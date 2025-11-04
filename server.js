import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import admin from "firebase-admin";
import Joi from "joi";
import pino from "pino";

dotenv.config();

const logger = pino({
  name: "whatsapp-service",
  level: process.env.LOG_LEVEL ?? "info"
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

if (!process.env.FIREBASE_SERVICE_ACCOUNT || !process.env.FIREBASE_DATABASE_URL) {
  throw new Error("Missing Firebase configuration. Set FIREBASE_SERVICE_ACCOUNT and FIREBASE_DATABASE_URL.");
}

const loadServiceAccount = async () => {
  const value = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!value) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
  }
  if (value.trim().startsWith("{")) {
    return JSON.parse(value);
  }
  const contents = await fs.readFile(value, "utf-8");
  return JSON.parse(contents);
};

const firebaseCredential = await loadServiceAccount();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(firebaseCredential),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}
const db = admin.database();

const connectSchema = Joi.object({
  tiendaId: Joi.string().trim().min(1).required(),
  slug: Joi.string().trim().min(1).required(),
  telefono: Joi.string().trim().min(6).required(),
  webhookUrl: Joi.string().uri({ scheme: [/https?/i] }).required()
});

const statusSchema = Joi.object({
  tiendaId: Joi.string().trim().min(1).required(),
  includeQr: Joi.boolean()
    .truthy("true", "1", "yes")
    .falsy("false", "0", "no")
    .default(false)
});

const normalizeSlug = (slug) =>
  slug
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const evolution = axios.create({
  baseURL: process.env.EVOLUTION_BASE_URL ?? "https://evo.onrpa.com",
  timeout: Number.parseInt(process.env.EVOLUTION_TIMEOUT ?? "15000", 10)
});

const createInstance = async (instanceName, webhookUrl) => {
  const token = crypto.randomUUID();
  const webhookTarget = webhookUrl ?? process.env.WEBHOOK_GLOBAL_URL;

  if (!webhookTarget) {
    throw new Error("Webhook URL is required to create an Evolution instance");
  }

  const response = await evolution.post(
    "/instance/create",
    {
      instanceName,
      token,
      integration: "WHATSAPP-BAILEYS",
      qrcode: true,
      webhook: {
        enabled: true,
        url: webhookTarget,
        webhookByEvents: true,
        events: ["messages.upsert", "qrcode.updated", "connection.update"]
      }
    },
    {
      headers: {
        apikey: process.env.EVOLUTION_MASTER_KEY
      }
    }
  );
  return { data: response.data, token };
};

const fetchStatus = async (instanceName, apiKey) => {
  const response = await evolution.get(`/instance/connectionState/${encodeURIComponent(instanceName)}`, {
    headers: {
      apikey: apiKey
    }
  });
  return response.data;
};

const fetchQr = async (instanceName, apiKey) => {
  const response = await evolution.get(`/instance/connect/${encodeURIComponent(instanceName)}`, {
    headers: { apikey: apiKey }
  });
  return response.data?.code ?? null;
};

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.post("/api/v1/whatsapp/connect-whatsapp-colmado", async (req, res) => {
  const { error, value } = connectSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return res.status(400).json({
      error: "validation_error",
      details: error.details.map((detail) => detail.message)
    });
  }

  try {
    const instanceName = `colmado_${normalizeSlug(value.slug)}`;
    const webhookTarget = value.webhookUrl || process.env.WEBHOOK_GLOBAL_URL;

    if (!webhookTarget) {
      return res.status(400).json({
        error: "missing_webhook_url",
        message: "Webhook URL is required. Provide webhookUrl or set WEBHOOK_GLOBAL_URL."
      });
    }

    const { data, token } = await createInstance(instanceName, webhookTarget);

    const apiKey =
      data?.instance?.apikey ??
      data?.hash?.apikey ??
      (typeof data?.hash === "string" ? data.hash : null) ??
      token;

    const record = {
      instanceName,
      apiKey,
      slug: value.slug,
      telefono: value.telefono,
      webhookUrl: webhookTarget,
      status: "pending",
      qrCode: data?.qrcode?.code ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await db.ref(`/tiendas/${value.tiendaId}/evolution`).set(record);

    res.status(201).json({
      success: true,
      status: "pending",
      instanceName,
      qrCode: data?.qrcode?.code ?? null,
      apiKey,
      evolutionResponse: data
    });
  } catch (err) {
    logger.error({ err }, "Failed to create Evolution instance");
    res.status(502).json({ error: "evolution_error", message: err.message });
  }
});

app.get("/api/v1/whatsapp/status", async (req, res) => {
  const { error, value } = statusSchema.validate(req.query, { convert: true });
  if (error) {
    return res.status(400).json({
      error: "validation_error",
      details: error.details.map((detail) => detail.message)
    });
  }

  try {
    const snapshot = await db.ref(`/tiendas/${value.tiendaId}/evolution`).get();
    if (!snapshot.exists()) {
      return res.status(404).json({ error: "not_found", message: "No Evolution config for this tienda" });
    }

    const config = snapshot.val();
    const state = await fetchStatus(config.instanceName, config.apiKey);
    const connectionStatus = state?.instance?.connectionStatus ?? "close";

    let qrCode = config.qrCode;
    if (value.includeQr && connectionStatus !== "open") {
      qrCode = await fetchQr(config.instanceName, config.apiKey);
    }

    await db.ref(`/tiendas/${value.tiendaId}/evolution`).update({
      status: connectionStatus === "open" ? "connected" : "pending",
      qrCode,
      lastSyncedAt: Date.now(),
      connectionStatus
    });

    res.json({
      success: true,
      status: connectionStatus === "open" ? "connected" : "pending",
      instanceName: config.instanceName,
      connectionStatus,
      number: state?.instance?.number ?? null,
      profileName: state?.instance?.profileName ?? null,
      qrCode: value.includeQr ? qrCode : undefined
    });
  } catch (err) {
    logger.error({ err }, "Failed to fetch Evolution status");
    res.status(502).json({ error: "evolution_error", message: err.message });
  }
});

const port = Number.parseInt(process.env.PORT ?? "4001", 10);
http.createServer(app).listen(port, () => {
  logger.info({ port }, "whatsapp-service listening");
});

