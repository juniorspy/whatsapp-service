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
import { enrichWhatsAppPayload } from "./lookupCache.js";

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
  webhookUrl: Joi.string().uri({ scheme: [/https?/i] }).optional() // Optional - we use whatsapp-service webhook
});

const statusSchema = Joi.object({
  tiendaId: Joi.string().trim().min(1).required(),
  includeQr: Joi.boolean()
    .truthy("true", "1", "yes")
    .falsy("false", "0", "no")
    .default(false)
});

const addNumberSchema = Joi.object({
  tiendaId: Joi.string().trim().min(1).required(),
  slug: Joi.string().trim().min(1).required(),
  telefono: Joi.string().trim().min(6).optional(),
  displayName: Joi.string().trim().min(1).optional(),
  webhookUrl: Joi.string().trim().uri().optional()
});

const listNumbersSchema = Joi.object({
  tiendaId: Joi.string().trim().min(1).required()
});

const normalizeSlug = (slug) =>
  slug
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const evolution = axios.create({
  baseURL: process.env.EVOLUTION_API_URL ?? process.env.EVOLUTION_BASE_URL ?? "https://evo.onrpa.com",
  timeout: Number.parseInt(process.env.EVOLUTION_TIMEOUT ?? "45000", 10)
});

const createInstance = async (instanceName, webhookUrl) => {
  const token = crypto.randomUUID();

  // Use whatsapp-service webhook endpoint (generic for all stores)
  // The slug will be extracted from instanceName in the webhook handler
  let webhookTarget;

  // Priority 1: Explicit webhook URL (full URL)
  if (process.env.WHATSAPP_SERVICE_WEBHOOK_URL) {
    webhookTarget = process.env.WHATSAPP_SERVICE_WEBHOOK_URL;
  }
  // Priority 2: Internal URL (for same-server deployment, avoids hairpin NAT)
  else if (process.env.WHATSAPP_SERVICE_INTERNAL_URL) {
    webhookTarget = `${process.env.WHATSAPP_SERVICE_INTERNAL_URL}/webhook/evolution`;
  }
  // Priority 3: Base URL (public)
  else if (process.env.WHATSAPP_SERVICE_BASE_URL) {
    webhookTarget = `${process.env.WHATSAPP_SERVICE_BASE_URL}/webhook/evolution`;
  }
  // Priority 4: Fallback to public URL
  else {
    webhookTarget = "https://whatsapp-service.onrpa.com/webhook/evolution";
  }

  logger.info({ instanceName, webhookTarget }, "Creating Evolution instance with whatsapp-service webhook");

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
        events: ["MESSAGES_UPSERT", "QRCODE_UPDATED", "CONNECTION_UPDATE"]
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
  const data = response.data;
  if (data?.base64) {
    return data.base64.startsWith('data:')
      ? data.base64
      : `data:image/png;base64,${data.base64}`;
  }
  return data?.code ?? null;
};

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Debug endpoint - logs everything
app.post("/webhook/evolution/debug", (req, res) => {
  logger.info({
    headers: req.headers,
    body: req.body,
    method: req.method,
    url: req.url
  }, "DEBUG: Received request");

  res.status(200).json({ success: true, debug: true });
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

    // Webhook URL now points to whatsapp-service (multi-tenant endpoint)
    let whatsappServiceWebhook;
    if (process.env.WHATSAPP_SERVICE_WEBHOOK_URL) {
      whatsappServiceWebhook = process.env.WHATSAPP_SERVICE_WEBHOOK_URL;
    } else if (process.env.WHATSAPP_SERVICE_BASE_URL) {
      whatsappServiceWebhook = `${process.env.WHATSAPP_SERVICE_BASE_URL}/webhook/evolution`;
    } else {
      whatsappServiceWebhook = "https://whatsapp-service.onrpa.com/webhook/evolution";
    }

    // Create instance with whatsapp-service webhook (not n8n)
    const { data, token } = await createInstance(instanceName, whatsappServiceWebhook);

    const apiKey =
      data?.instance?.apikey ??
      data?.hash?.apikey ??
      (typeof data?.hash === "string" ? data.hash : null) ??
      token;

    const qrCodeData = data?.qrcode?.base64
      ? (data.qrcode.base64.startsWith('data:')
          ? data.qrcode.base64
          : `data:image/png;base64,${data.qrcode.base64}`)
      : (data?.qrcode?.code ?? null);

    const record = {
      instanceName,
      apiKey,
      slug: value.slug,
      telefono: value.telefono,
      webhookUrl: whatsappServiceWebhook, // Save whatsapp-service URL
      status: "pending",
      qrCode: qrCodeData,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await db.ref(`/tiendas/${value.tiendaId}/evolution`).set(record);

    // Create reverse lookup: instanceName -> tiendaId + apiKey (for webhook handler)
    await db.ref(`/evolution_instances/${instanceName}`).set({
      tiendaId: value.tiendaId,
      apiKey: apiKey,
      slug: value.slug,
      createdAt: Date.now()
    });

    res.status(201).json({
      success: true,
      status: "pending",
      instanceName,
      qrCode: qrCodeData,
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

// ============================================================================
// Multi-Number Endpoints - Add and list additional WhatsApp numbers
// ============================================================================

// Add a new WhatsApp number to an existing store
app.post("/api/v1/whatsapp/add-number", async (req, res) => {
  const { error, value } = addNumberSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return res.status(400).json({
      error: "validation_error",
      details: error.details.map((detail) => detail.message)
    });
  }

  try {
    // CRITICAL: Get the REAL tienda slug from the primary evolution config
    // The value.slug from request is just a display name, NOT the store slug!
    const primaryEvolution = await db.ref(`/tiendas/${value.tiendaId}/evolution`).get();
    if (!primaryEvolution.exists()) {
      return res.status(404).json({
        error: "not_found",
        message: "No primary WhatsApp number found for this tienda. Set up primary number first."
      });
    }

    const realSlug = primaryEvolution.val().slug;
    if (!realSlug) {
      return res.status(500).json({
        error: "invalid_state",
        message: "Primary evolution config missing slug"
      });
    }

    logger.info({ tiendaId: value.tiendaId, realSlug, requestSlug: value.slug }, "Using real tienda slug for additional number");

    const baseInstanceName = `colmado_${normalizeSlug(realSlug)}`;

    // Find next available number suffix
    const existingNumbers = await db.ref(`/tiendas/${value.tiendaId}/whatsapp_numbers`).get();
    let nextSuffix = 2;

    if (existingNumbers.exists()) {
      const numbers = existingNumbers.val();
      const suffixes = Object.values(numbers)
        .map(n => {
          const match = n.instanceName?.match(/_(\d+)$/);
          return match ? parseInt(match[1], 10) : 1;
        })
        .filter(s => !isNaN(s));

      if (suffixes.length > 0) {
        nextSuffix = Math.max(...suffixes) + 1;
      }
    }

    const instanceName = `${baseInstanceName}_${nextSuffix}`;

    // Determine webhook URL
    let whatsappServiceWebhook;
    if (process.env.WHATSAPP_SERVICE_WEBHOOK_URL) {
      whatsappServiceWebhook = process.env.WHATSAPP_SERVICE_WEBHOOK_URL;
    } else if (process.env.WHATSAPP_SERVICE_BASE_URL) {
      whatsappServiceWebhook = `${process.env.WHATSAPP_SERVICE_BASE_URL}/webhook/evolution`;
    } else {
      whatsappServiceWebhook = "https://whatsapp-service.onrpa.com/webhook/evolution";
    }

    // Create Evolution instance
    const { data, token } = await createInstance(instanceName, whatsappServiceWebhook);

    const apiKey =
      data?.instance?.apikey ??
      data?.hash?.apikey ??
      (typeof data?.hash === "string" ? data.hash : null) ??
      token;

    const qrCodeData = data?.qrcode?.base64
      ? (data.qrcode.base64.startsWith('data:')
          ? data.qrcode.base64
          : `data:image/png;base64,${data.qrcode.base64}`)
      : (data?.qrcode?.code ?? null);

    const numberId = `number_${nextSuffix}`;
    const record = {
      instanceName,
      apiKey,
      slug: realSlug,  // FIXED: Use real tienda slug, not display name
      telefono: value.telefono || null,
      displayName: value.displayName || `Número ${nextSuffix}`,
      webhookUrl: whatsappServiceWebhook,
      status: "pending",
      qrCode: qrCodeData,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    // Save to whatsapp_numbers collection
    await db.ref(`/tiendas/${value.tiendaId}/whatsapp_numbers/${numberId}`).set(record);

    // Create reverse lookup for webhook handler
    await db.ref(`/evolution_instances/${instanceName}`).set({
      tiendaId: value.tiendaId,
      apiKey: apiKey,
      slug: realSlug,  // FIXED: Use real tienda slug, not display name
      numberId: numberId,
      createdAt: Date.now()
    });

    logger.info({ tiendaId: value.tiendaId, instanceName, numberId }, "Additional WhatsApp number created");

    res.status(201).json({
      success: true,
      status: "pending",
      instanceName,
      numberId,
      qrCode: qrCodeData,
      apiKey
    });
  } catch (err) {
    logger.error({ err }, "Failed to create additional WhatsApp number");
    res.status(502).json({ error: "evolution_error", message: err.message });
  }
});

// List all WhatsApp numbers for a store
app.get("/api/v1/whatsapp/numbers", async (req, res) => {
  const { error, value } = listNumbersSchema.validate(req.query, { convert: true });
  if (error) {
    return res.status(400).json({
      error: "validation_error",
      details: error.details.map((detail) => detail.message)
    });
  }

  try {
    const numbers = [];

    // Get primary number from /evolution
    const primarySnapshot = await db.ref(`/tiendas/${value.tiendaId}/evolution`).get();
    if (primarySnapshot.exists()) {
      const primary = primarySnapshot.val();
      const state = await fetchStatus(primary.instanceName, primary.apiKey).catch(() => null);
      numbers.push({
        numberId: "primary",
        instanceName: primary.instanceName,
        telefono: primary.telefono,
        status: state?.instance?.connectionStatus === "open" ? "connected" : (primary.status || "pending"),
        profileName: state?.instance?.profileName ?? null,
        isPrimary: true,
        createdAt: primary.createdAt
      });
    }

    // Get additional numbers from /whatsapp_numbers
    const additionalSnapshot = await db.ref(`/tiendas/${value.tiendaId}/whatsapp_numbers`).get();
    if (additionalSnapshot.exists()) {
      const additionalNumbers = additionalSnapshot.val();
      for (const [numberId, config] of Object.entries(additionalNumbers)) {
        const state = await fetchStatus(config.instanceName, config.apiKey).catch(() => null);
        numbers.push({
          numberId,
          instanceName: config.instanceName,
          telefono: config.telefono,
          status: state?.instance?.connectionStatus === "open" ? "connected" : (config.status || "pending"),
          profileName: state?.instance?.profileName ?? null,
          isPrimary: false,
          createdAt: config.createdAt
        });
      }
    }

    res.json({
      success: true,
      count: numbers.length,
      numbers
    });
  } catch (err) {
    logger.error({ err }, "Failed to list WhatsApp numbers");
    res.status(502).json({ error: "evolution_error", message: err.message });
  }
});

// Get status/QR for a specific additional number
app.get("/api/v1/whatsapp/numbers/:numberId/status", async (req, res) => {
  const tiendaId = req.query.tiendaId;
  const numberId = req.params.numberId;
  const includeQr = req.query.includeQr === "true";

  if (!tiendaId) {
    return res.status(400).json({ error: "validation_error", message: "tiendaId is required" });
  }

  try {
    let config;

    if (numberId === "primary") {
      const snapshot = await db.ref(`/tiendas/${tiendaId}/evolution`).get();
      if (!snapshot.exists()) {
        return res.status(404).json({ error: "not_found", message: "Primary number not found" });
      }
      config = snapshot.val();
    } else {
      const snapshot = await db.ref(`/tiendas/${tiendaId}/whatsapp_numbers/${numberId}`).get();
      if (!snapshot.exists()) {
        return res.status(404).json({ error: "not_found", message: "Number not found" });
      }
      config = snapshot.val();
    }

    const state = await fetchStatus(config.instanceName, config.apiKey);
    const connectionStatus = state?.instance?.connectionStatus ?? "close";

    let qrCode = config.qrCode;
    if (includeQr && connectionStatus !== "open") {
      qrCode = await fetchQr(config.instanceName, config.apiKey);
    }

    // Update status in Firebase
    const updatePath = numberId === "primary"
      ? `/tiendas/${tiendaId}/evolution`
      : `/tiendas/${tiendaId}/whatsapp_numbers/${numberId}`;

    await db.ref(updatePath).update({
      status: connectionStatus === "open" ? "connected" : "pending",
      qrCode,
      lastSyncedAt: Date.now(),
      connectionStatus
    });

    res.json({
      success: true,
      numberId,
      status: connectionStatus === "open" ? "connected" : "pending",
      instanceName: config.instanceName,
      connectionStatus,
      number: state?.instance?.number ?? null,
      profileName: state?.instance?.profileName ?? null,
      qrCode: includeQr ? qrCode : undefined
    });
  } catch (err) {
    logger.error({ err, numberId }, "Failed to fetch number status");
    res.status(502).json({ error: "evolution_error", message: err.message });
  }
});

// Delete a WhatsApp number
app.delete("/api/v1/whatsapp/numbers/:numberId", async (req, res) => {
  const tiendaId = req.query.tiendaId;
  const numberId = req.params.numberId;

  if (!tiendaId) {
    return res.status(400).json({ error: "validation_error", message: "tiendaId is required" });
  }

  if (!numberId) {
    return res.status(400).json({ error: "validation_error", message: "numberId is required" });
  }

  // Prevent deletion of primary number
  if (numberId === "primary") {
    return res.status(400).json({
      error: "cannot_delete_primary",
      message: "Cannot delete primary number. Delete from additional numbers only."
    });
  }

  try {
    // Get the number configuration
    const snapshot = await db.ref(`/tiendas/${tiendaId}/whatsapp_numbers/${numberId}`).get();
    if (!snapshot.exists()) {
      return res.status(404).json({ error: "not_found", message: "Number not found" });
    }

    const config = snapshot.val();
    const instanceName = config.instanceName;

    // IMPORTANT: Close session and delete instance from Evolution API BEFORE deleting from Firebase
    if (instanceName) {
      try {
        logger.info(
          { tiendaId, numberId, instanceName },
          "Deleting Evolution instance before removing from Firebase"
        );

        // Delete from Evolution API
        await evolution.delete(`/instance/delete/${encodeURIComponent(instanceName)}`, {
          headers: {
            apikey: process.env.EVOLUTION_MASTER_KEY
          }
        });

        logger.info(
          { tiendaId, numberId, instanceName },
          "Evolution instance deleted successfully"
        );
      } catch (evolutionError) {
        // Log but don't fail if Evolution deletion fails with 404 (instance already deleted)
        const status = evolutionError.response?.status;
        logger.warn(
          {
            tiendaId,
            numberId,
            instanceName,
            error: evolutionError.message,
            status
          },
          "Failed to delete Evolution instance (may already be deleted)"
        );

        // Only fail if it's not a 404 (instance not found)
        if (status && status !== 404) {
          return res.status(502).json({
            error: "evolution_error",
            message: `Failed to delete Evolution instance: ${evolutionError.message}`
          });
        }
      }
    }

    // Delete from Firebase /whatsapp_numbers/
    await db.ref(`/tiendas/${tiendaId}/whatsapp_numbers/${numberId}`).remove();

    // Delete from /evolution_instances/ reverse lookup
    if (instanceName) {
      await db.ref(`/evolution_instances/${instanceName}`).remove();
    }

    logger.info(
      { tiendaId, numberId, telefono: config.telefono },
      "WhatsApp number deleted from Firebase"
    );

    res.json({
      success: true,
      deleted: true,
      numberId
    });
  } catch (err) {
    logger.error({ err, tiendaId, numberId }, "Failed to delete WhatsApp number");
    res.status(500).json({ error: "server_error", message: err.message });
  }
});

// ============================================================================
// Evolution Webhook Endpoint - Receives messages from WhatsApp
// ============================================================================
app.post("/webhook/evolution", async (req, res) => {
  const startTime = Date.now();
  logger.info({ timestamp: new Date().toISOString() }, "WEBHOOK: Request arrived");

  try {
    const { event, data, instance } = req.body;

    logger.info({ event, instance, bodySize: JSON.stringify(req.body).length }, "WEBHOOK: Parsed body");

    // Filter: Only process MESSAGES_UPSERT events
    if (event !== "messages.upsert") {
      logger.debug({ event }, "Ignoring non-message event");
      return res.status(200).json({
        success: true,
        message: "Event ignored (not messages.upsert)"
      });
    }

    // Filter: Ignore own messages (fromMe = true)
    if (data?.key?.fromMe === true) {
      logger.debug("Ignoring own message");
      return res.status(200).json({
        success: true,
        message: "Own message ignored"
      });
    }

    // Extract phone number from remoteJid
    const remoteJid = data?.key?.remoteJid;
    if (!remoteJid) {
      logger.warn("Missing remoteJid in webhook data");
      return res.status(400).json({
        success: false,
        error: "Missing remoteJid"
      });
    }

    const phoneNumber = remoteJid.replace('@s.whatsapp.net', '');
    const chatId = `web_${phoneNumber}`;

    // Detect message type and extract content
    let messageType = 'text';
    let text = '';
    let audioData = null;

    // Check for audio/voice note
    const audioMessage = data?.message?.audioMessage;
    if (audioMessage) {
      messageType = 'audio';

      // Download audio as base64 from Evolution API
      let audioBase64 = null;
      try {
        // Get instance config to retrieve API key
        const instanceConfig = await db.ref(`/evolution_instances/${instance}`).once('value');
        const apiKey = instanceConfig.val()?.apiKey;

        if (apiKey && data?.key?.id) {
          logger.info({ instance, messageId: data.key.id }, "Downloading audio from Evolution API");

          const mediaResponse = await evolution.post(
            `/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`,
            {
              message: {
                key: {
                  id: data.key.id
                }
              }
            },
            {
              headers: {
                apikey: apiKey
              },
              timeout: 30000 // 30 second timeout for media download
            }
          );

          audioBase64 = mediaResponse.data?.base64 || null;
          logger.info({ hasBase64: !!audioBase64 }, "Audio download completed");
        } else {
          logger.warn({ instance }, "Cannot download audio: missing API key or message ID");
        }
      } catch (downloadError) {
        logger.error({ err: downloadError, instance }, "Failed to download audio from Evolution API");
      }

      audioData = {
        url: audioMessage.url || null,
        base64: audioBase64, // Downloaded base64 audio
        mimetype: audioMessage.mimetype || 'audio/ogg',
        seconds: audioMessage.seconds || 0,
        ptt: audioMessage.ptt || false, // Push-to-talk (voice note)
        fileLength: audioMessage.fileLength || null,
        mediaKey: audioMessage.mediaKey || null,
        fileSha256: audioMessage.fileSha256 || null
      };
      text = `[Audio message - ${audioData.seconds}s]`; // Placeholder text for logs
      logger.info({ chatId, audioData: { ...audioData, base64: audioBase64 ? '[REDACTED]' : null } }, "Audio message detected");
    } else {
      // Extract text message
      text = data?.message?.conversation ||
             data?.message?.extendedTextMessage?.text || '';

      if (!text.trim()) {
        logger.debug("Ignoring empty message");
        return res.status(200).json({
          success: true,
          message: "Empty message ignored"
        });
      }
    }

    // Extract timestamp (Evolution uses seconds, Firebase needs milliseconds)
    const ts = (data?.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000;

    // Get slug from /evolution_instances/ lookup (supports multi-number)
    let slug = 'unknown';
    try {
      const instanceLookup = await db.ref(`/evolution_instances/${instance}`).get();
      if (instanceLookup.exists()) {
        slug = instanceLookup.val().slug || 'unknown';
        logger.debug({ instance, slug }, "Slug retrieved from evolution_instances lookup");
      } else {
        // Fallback: Extract slug from instance name (legacy support)
        // "colmado_colmado_william" -> "colmado_william"
        // Also strip _2, _3, etc. suffix for multi-number instances
        slug = instance ? instance.replace(/^colmado_/, '').replace(/_\d+$/, '') : 'unknown';
        logger.warn({ instance, slug }, "Instance not found in evolution_instances, using parsed slug (may be incorrect)");
      }
    } catch (lookupError) {
      logger.error({ err: lookupError, instance }, "Failed to lookup instance slug, using parsed fallback");
      slug = instance ? instance.replace(/^colmado_/, '').replace(/_\d+$/, '') : 'unknown';
    }

    // RESPOND IMMEDIATELY to avoid Evolution timeout
    res.status(200).json({
      success: true,
      chatId: chatId,
      slug: slug,
      accepted: true
    });

    const responseTime = Date.now() - startTime;
    logger.info({ responseTime }, "Response sent to Evolution");

    // ========================================================================
    // Process webhook in background (after responding to avoid timeout)
    // ========================================================================

    // 1. Build base payload
    const basePayload = {
      role: 'user',
      text: text,
      messageType: messageType, // 'text' or 'audio'
      ts: ts,
      chatId: chatId,
      tiendaSlug: slug,
      slug: slug, // Duplicate for compatibility
      telefono: `+${phoneNumber}`, // Format with + prefix (at root level)
      instanceName: instance, // Track which WhatsApp number received this message
      nombre: null,
      direccion: null,
      pedidoId: null,
      profileReady: false,
      firstInSession: false, // HARDCODED: Always false for WhatsApp
      sessionStartTs: ts,
      meta: {
        chatId: chatId,
        slug: slug,
        source: 'whatsapp',
        pushName: data?.pushName || 'Cliente',
        remoteJid: remoteJid,
        messageId: data?.key?.id || '',
        instanceName: instance, // Track which WhatsApp number received this message
        firstInSession: false, // HARDCODED: Always false for WhatsApp
        sessionStartTs: ts,
        profileReady: false,
        messageType: messageType
      }
    };

    // Save chat-to-instance mapping for response routing
    await db.ref(`/chat_instances/${slug}/${chatId}`).set({
      instanceName: instance,
      lastMessageAt: ts
    });

    // Add audio data if present
    if (audioData) {
      basePayload.audio = audioData;
      basePayload.meta.audio = audioData;
    }

    // 2. Enrich payload dynamically with caching (60s TTL)
    const enrichedPayload = await enrichWhatsAppPayload(basePayload);

    // DEBUG: Log complete payload being written to Firebase
    console.log('\n========== WHATSAPP PAYLOAD TO FIREBASE ==========');
    console.log(JSON.stringify(enrichedPayload, null, 2));
    console.log('==================================================\n');

    // 3. Write enriched message to Firebase
    const mensajesRef = db.ref(`/mensajes/${slug}/${chatId}`);
    const newMessageRef = await mensajesRef.push(enrichedPayload);

    logger.info({
      chatId,
      slug,
      messageId: newMessageRef.key,
      messageType: messageType,
      tiendaId: enrichedPayload.tiendaId,
      profileReady: enrichedPayload.meta.profileReady,
      firstInSession: enrichedPayload.meta.firstInSession,
      sessionStartTs: enrichedPayload.sessionStartTs,
      text: text.substring(0, 50),
      hasAudio: audioData !== null
    }, "Enriched message written to Firebase /mensajes/ (with cache)");

    // Cloud Functions will detect and process automatically

  } catch (err) {
    logger.error({ err }, "Error processing Evolution webhook");
    // Only send error response if we haven't responded yet
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: err.message
      });
    }
  }
});

// ============================================================================
// Firebase Listener - Send bot responses via WhatsApp
// ============================================================================

// Map to track processed responses (prevent duplicates)
const processedResponses = new Set();

// Service startup timestamp - only process messages created AFTER this
const serviceStartupTime = Date.now();
logger.info({ serviceStartupTime, time: new Date(serviceStartupTime).toISOString() }, "Service started - will only process new messages");

// Helper function: Retry with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) {
        throw error; // Last attempt failed, throw error
      }

      const delay = delayMs * Math.pow(2, attempt - 1); // Exponential backoff: 1s, 2s, 4s
      logger.warn({
        attempt,
        maxRetries,
        delayMs: delay,
        error: error.message
      }, `Retry attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms`);

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Poll /respuestas/ for new messages instead of using listeners
// This prevents multiple instances from racing and sending duplicates
const respuestasRef = db.ref('/respuestas');

logger.info("🔵 INITIALIZING /respuestas POLLING at service startup");
logger.info({ serviceStartupTime, date: new Date(serviceStartupTime).toISOString(), pollInterval: 2000 }, "Service startup timestamp and polling config");

let pollCount = 0;

// Poll every 2 seconds for new responses (prevents race conditions between multiple instances)
setInterval(async () => {
  try {
    pollCount++;
    // Only log pollCount every 30 polls (approx 1 minute) to reduce noise
    if (pollCount % 30 === 0) logger.debug({ pollCount }, "🔄 Polling /respuestas (heartbeat)");

    const snapshot = await respuestasRef.once('value');
    if (!snapshot.exists()) return;

    const respuestas = snapshot.val();

    // Iterate through all slugs (stores)
    for (const slug in respuestas) {
      if (!respuestas[slug]) continue;

      // Iterate through all chats
      for (const chatId in respuestas[slug]) {
        // Filter: Only process web_ chat IDs
        if (!chatId.startsWith('web_')) continue;

        // Iterate through all messages in the chat
        for (const responseId in respuestas[slug][chatId]) {
          const response = respuestas[slug][chatId][responseId];
          const responsePath = `${slug}/${chatId}/${responseId}`;

          // ============================================================
          // 🛡️ FIX 1: SELF-HEALING CLEANUP
          // If message is already sent, DELETE IT immediately.
          // Don't just skip it, or it will clutter the DB and logs forever.
          // ============================================================
          if (response.enviado === true) {
            logger.warn({ responsePath }, "🧹 CLEANUP: Found 'enviado: true' message. Deleting from DB.");
            try {
              await db.ref(`/respuestas/${slug}/${chatId}/${responseId}`).remove();
              // Remove from local Set so we don't track it anymore
              processedResponses.delete(responsePath);
            } catch (e) {
              logger.error({ err: e, responsePath }, "Failed to delete cleanup message");
            }
            continue;
          }

          // Check local memory cache to avoid reprocessing in same cycle
          if (processedResponses.has(responsePath)) continue;
          processedResponses.add(responsePath);

          const text = response?.text;
          // Safety check for invalid content
          if (!text || typeof text !== 'string') {
             // If invalid, delete it to stop the loop
             logger.warn({ responsePath }, "❌ INVALID: Response has no text. Deleting.");
             await db.ref(`/respuestas/${slug}/${chatId}/${responseId}`).remove();
             continue;
          }

          // Protection: Skip old messages from before reboot
          const messageTimestamp = response.ts || 0;
          if (messageTimestamp < serviceStartupTime) {
            logger.warn({ responsePath }, "⏰ EXPIRED: Message older than service startup. Deleting.");
            await db.ref(`/respuestas/${slug}/${chatId}/${responseId}`).remove();
            continue;
          }

          logger.info({ responsePath }, "🔵 NEW MESSAGE: Attempting Transaction");

          // 🛡️ FIX 2: TRANSACTION LOCK
          const responseRef = db.ref(`/respuestas/${slug}/${chatId}/${responseId}`);
          const claimResult = await responseRef.child('enviado').transaction((currentValue) => {
            if (currentValue === true) return; // Abort if someone else took it
            return true; // Lock it
          });

          if (!claimResult.committed) {
            logger.debug({ responsePath }, "🔒 Locked by another thread/process");
            continue;
          }

          // --- SENDING LOGIC STARTS HERE ---
          try {
            const phoneNumber = chatId.replace('web_', '');

            // 1. Get Instance Mapping
            let instanceName = null;
            let apiKey = null;

            const chatInstanceSnapshot = await db.ref(`/chat_instances/${slug}/${chatId}`).get();
            if (chatInstanceSnapshot.exists()) {
              const mappedInstance = chatInstanceSnapshot.val().instanceName;
              const instanceLookup = await db.ref(`/evolution_instances/${mappedInstance}`).get();
              if (instanceLookup.exists()) {
                instanceName = mappedInstance;
                apiKey = instanceLookup.val().apiKey;
              }
            }

            // 2. Fallback to Primary
            if (!instanceName) {
              const tiendaIdSnapshot = await db.ref(`/tiendas_por_slug/${slug}`).get();
              if (tiendaIdSnapshot.exists()) {
                 const tiendaId = tiendaIdSnapshot.val();
                 const evolutionSnapshot = await db.ref(`/tiendas/${tiendaId}/evolution`).get();
                 if (evolutionSnapshot.exists()) {
                   instanceName = evolutionSnapshot.val().instanceName;
                   apiKey = evolutionSnapshot.val().apiKey;
                 }
              }
            }

            if (instanceName && apiKey) {
              logger.info({ responsePath, instanceName }, "🚀 SENDING to WhatsApp...");

              await retryWithBackoff(async () => {
                return await evolution.post(
                  `/message/sendText/${encodeURIComponent(instanceName)}`,
                  { number: phoneNumber, text: text },
                  { headers: { apikey: apiKey } }
                );
              }, 3, 1000);

              logger.info({ responsePath }, "✅ SENT. Deleting from DB.");
            } else {
              logger.error({ responsePath }, "❌ NO INSTANCE FOUND. Deleting to prevent loop.");
            }

          } catch (err) {
            logger.error({ err, responsePath }, "❌ SEND FAILED");
          } finally {
            // 🛡️ FIX 3: ALWAYS DELETE
            // Whether sent successfully or failed (invalid instance),
            // delete it so we don't loop forever.
            await responseRef.remove();
            processedResponses.delete(responsePath);
          }
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "Error in polling loop");
  }
}, 2000);

logger.info("Firebase response polling initialized (2s interval, transaction-protected)");

const port = Number.parseInt(process.env.PORT ?? "4001", 10);
http.createServer(app).listen(port, () => {
  logger.info({ port }, "whatsapp-service listening");
});

