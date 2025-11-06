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
  webhookUrl: Joi.string().uri({ scheme: [/https?/i] }).optional() // Optional - we use whatsapp-service webhook
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
// Helper Functions for Message Enrichment
// ============================================================================

/**
 * Lookup tienda by Evolution instanceName
 * Returns: { tiendaId, slug, telefono } or null
 */
const lookupTiendaByInstance = async (instanceName) => {
  try {
    const tiendasSnapshot = await db.ref('/tiendas').once('value');

    if (!tiendasSnapshot.exists()) {
      return null;
    }

    const tiendas = tiendasSnapshot.val();

    for (const [tiendaId, tiendaData] of Object.entries(tiendas)) {
      if (tiendaData?.evolution?.instanceName === instanceName) {
        return {
          tiendaId,
          slug: tiendaData.slug || tiendaData.evolution.slug,
          telefono: tiendaData.telefono || tiendaData.evolution.telefono
        };
      }
    }

    return null;
  } catch (err) {
    logger.error({ err, instanceName }, "Error in lookupTiendaByInstance");
    return null;
  }
};

/**
 * Normalize phone number to consistent format
 * Input: "whatsapp:+18091234567" or "18091234567@s.whatsapp.net" or "8091234567"
 * Output: "8091234567" (10 digits, RD format)
 */
const normalizarTelefono = (telefono) => {
  if (!telefono) return null;

  let normalizado = telefono
    .replace(/^whatsapp:\+/, '')
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/^1/, '') // Remove country code 1 (USA/RD)
    .replace(/\D/g, ''); // Only digits

  // If 10 digits and starts with 809/829/849 → RD number
  if (normalizado.length === 10 && /^(809|829|849)/.test(normalizado)) {
    return normalizado;
  }

  // Try to extract last 10 digits
  if (normalizado.length > 10) {
    return normalizado.slice(-10);
  }

  return normalizado;
};

/**
 * Search for user by phone number
 * Returns: { usuarioId, nombre, telefono, direccion, profileReady } or null
 */
const buscarUsuarioPorTelefono = async (slug, telefono) => {
  const telefonoNormalizado = normalizarTelefono(telefono);

  if (!telefonoNormalizado) {
    return null;
  }

  try {
    // Search in /usuarios/{slug}/
    const usuariosRef = db.ref(`/usuarios/${slug}`);
    const snapshot = await usuariosRef
      .orderByChild('telefono')
      .equalTo(telefonoNormalizado)
      .once('value');

    if (snapshot.exists()) {
      const usuarioId = Object.keys(snapshot.val())[0];
      const usuario = snapshot.val()[usuarioId];
      return {
        usuarioId,
        nombre: usuario.nombre,
        telefono: usuario.telefono,
        direccion: usuario.direccion,
        profileReady: true
      };
    }

    // Fallback: Search in /clientes/{telefono}/ (legacy)
    const clienteSnapshot = await db.ref(`/clientes/${telefonoNormalizado}`).once('value');
    if (clienteSnapshot.exists()) {
      const cliente = clienteSnapshot.val();
      return {
        usuarioId: null, // Legacy doesn't have usuarioId
        nombre: cliente.nombre,
        telefono: telefonoNormalizado,
        direccion: cliente.direccion,
        profileReady: true,
        source: 'clientes_legacy'
      };
    }

    return null;
  } catch (err) {
    logger.error({ err, slug, telefono }, "Error in buscarUsuarioPorTelefono");
    return null;
  }
};

/**
 * Check session status and find active pedidoId
 * Returns: { firstInSession, sessionStartTs, pedidoId, pedidoActivo }
 */
const checkSessionStatus = async (slug, chatId, usuarioId) => {
  try {
    // Check last messages in this chat
    const mensajesRef = db.ref(`/mensajes/${slug}/${chatId}`);
    const lastMessagesSnapshot = await mensajesRef
      .orderByChild('ts')
      .limitToLast(10)
      .once('value');

    if (!lastMessagesSnapshot.exists()) {
      // No previous messages - new session
      return {
        firstInSession: true,
        sessionStartTs: Date.now(),
        pedidoId: null,
        pedidoActivo: null
      };
    }

    const messages = Object.values(lastMessagesSnapshot.val());
    const lastMessage = messages[messages.length - 1];
    const lastMessageTime = lastMessage.ts;
    const timeSinceLastMessage = Date.now() - lastMessageTime;

    // Session timeout: 30 minutes
    const SESSION_TIMEOUT = 30 * 60 * 1000;

    if (timeSinceLastMessage > SESSION_TIMEOUT) {
      // Session expired - new session
      return {
        firstInSession: true,
        sessionStartTs: Date.now(),
        pedidoId: null,
        pedidoActivo: null
      };
    }

    // Active session - find sessionStartTs and pedidoId
    let sessionStartTs = lastMessage.meta?.sessionStartTs || lastMessageTime;
    let pedidoId = null;
    let pedidoActivo = null;

    // Look for most recent pedidoId in session
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].pedidoId) {
        pedidoId = messages[i].pedidoId;

        // Check if pedido is still active
        const pedidoSnapshot = await db.ref(`/pedidos/${slug}/${pedidoId}`).once('value');
        if (pedidoSnapshot.exists()) {
          const pedido = pedidoSnapshot.val();
          if (pedido.estado !== 'completado' && pedido.estado !== 'cancelado') {
            pedidoActivo = pedido;
          }
        }

        break;
      }

      if (messages[i].meta?.sessionStartTs) {
        sessionStartTs = messages[i].meta.sessionStartTs;
      }
    }

    return {
      firstInSession: false,
      sessionStartTs: sessionStartTs,
      pedidoId: pedidoId,
      pedidoActivo: pedidoActivo
    };

  } catch (err) {
    logger.error({ err, slug, chatId }, "Error in checkSessionStatus");
    return {
      firstInSession: true,
      sessionStartTs: Date.now(),
      pedidoId: null,
      pedidoActivo: null
    };
  }
};

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
    const chatId = `whatsapp:+${phoneNumber}`;

    // Extract message text
    const text = data?.message?.conversation ||
                 data?.message?.extendedTextMessage?.text || '';

    if (!text.trim()) {
      logger.debug("Ignoring empty message");
      return res.status(200).json({
        success: true,
        message: "Empty message ignored"
      });
    }

    // Extract timestamp (Evolution uses seconds, Firebase needs milliseconds)
    const ts = (data?.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000;

    // RESPOND IMMEDIATELY to avoid Evolution timeout
    res.status(200).json({
      success: true,
      chatId: chatId,
      accepted: true
    });

    const responseTime = Date.now() - startTime;
    logger.info({ responseTime }, "Response sent to Evolution");

    // ========================================================================
    // Process webhook in background (after responding) with full enrichment
    // ========================================================================

    // 1. Lookup tienda by instanceName (get real slug from Firebase)
    const tienda = await lookupTiendaByInstance(instance);

    if (!tienda) {
      logger.error({ instance }, "Tienda not found for instanceName");
      return;
    }

    const { slug, tiendaId } = tienda;

    logger.info({ instance, slug, tiendaId }, "Tienda found");

    // 2. Search user by phone number
    const usuario = await buscarUsuarioPorTelefono(slug, phoneNumber);

    logger.info({
      phoneNumber,
      usuarioFound: !!usuario,
      usuarioId: usuario?.usuarioId,
      profileReady: usuario?.profileReady
    }, "User lookup completed");

    // 3. Check session status and find active pedidoId
    const sesion = await checkSessionStatus(slug, chatId, usuario?.usuarioId);

    logger.info({
      chatId,
      firstInSession: sesion.firstInSession,
      pedidoId: sesion.pedidoId,
      pedidoActivo: !!sesion.pedidoActivo
    }, "Session status checked");

    // 4. Build enriched message (same format as web client)
    const firebaseMessage = {
      role: 'user',
      text: text,
      ts: ts,
      pedidoId: sesion.pedidoId, // Active pedido or null
      meta: {
        slug: slug,
        tiendaId: tiendaId,
        chatId: chatId,
        usuarioId: usuario?.usuarioId || null,
        profileReady: usuario?.profileReady || false,
        firstInSession: sesion.firstInSession,
        sessionStartTs: sesion.sessionStartTs,
        source: 'whatsapp',
        pushName: data?.pushName || 'Cliente',
        remoteJid: remoteJid,
        messageId: data?.key?.id || '',
        ...(usuario && {
          nombre: usuario.nombre,
          telefono: usuario.telefono,
          direccion: usuario.direccion
        })
      }
    };

    // 5. Write to Firebase
    const mensajesRef = db.ref(`/mensajes/${slug}/${chatId}`);
    const newMessageRef = await mensajesRef.push(firebaseMessage);

    logger.info({
      chatId,
      slug,
      messageId: newMessageRef.key,
      text: text.substring(0, 50),
      usuarioId: usuario?.usuarioId,
      profileReady: usuario?.profileReady,
      pedidoId: sesion.pedidoId
    }, "Message written to Firebase with full enrichment");

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

// Listen to all /respuestas/ nodes for WhatsApp messages
const respuestasRef = db.ref('/respuestas');

respuestasRef.on('child_added', (slugSnapshot) => {
  const slug = slugSnapshot.key;

  slugSnapshot.ref.on('child_added', (chatIdSnapshot) => {
    const chatId = chatIdSnapshot.key;

    // Only process WhatsApp chat IDs
    if (!chatId.startsWith('whatsapp:')) {
      return;
    }

    chatIdSnapshot.ref.on('child_added', async (responseSnapshot) => {
      const responseId = responseSnapshot.key;
      const responsePath = `${slug}/${chatId}/${responseId}`;

      // Check if already processed
      if (processedResponses.has(responsePath)) {
        return;
      }
      processedResponses.add(responsePath);

      const response = responseSnapshot.val();
      const text = response?.text;

      if (!text || typeof text !== 'string') {
        logger.debug({ responsePath }, "Skipping response without text");
        return;
      }

      try {
        // Extract phone number from chatId: "whatsapp:+18091234567" -> "18091234567"
        const phoneNumber = chatId.replace('whatsapp:+', '');

        // Get tiendaId from slug
        const tiendaIdSnapshot = await db.ref(`/tiendas_por_slug/${slug}`).get();
        if (!tiendaIdSnapshot.exists()) {
          logger.warn({ slug }, "No tiendaId found for slug");
          return;
        }

        const tiendaId = tiendaIdSnapshot.val();

        // Get Evolution instance details from Firebase
        const evolutionSnapshot = await db.ref(`/tiendas/${tiendaId}/evolution`).get();
        if (!evolutionSnapshot.exists()) {
          logger.warn({ slug, tiendaId }, "No Evolution config found for tienda");
          return;
        }

        const evolutionConfig = evolutionSnapshot.val();
        const instanceName = evolutionConfig.instanceName;
        const apiKey = evolutionConfig.apiKey;

        if (!instanceName || !apiKey) {
          logger.warn({ slug, tiendaId }, "Missing instanceName or apiKey in Evolution config");
          return;
        }

        // Send message via Evolution API
        const sendResponse = await evolution.post(
          `/message/sendText/${encodeURIComponent(instanceName)}`,
          {
            number: phoneNumber,
            text: text
          },
          {
            headers: {
              apikey: apiKey
            }
          }
        );

        logger.info({
          chatId,
          slug,
          phoneNumber,
          responseId,
          text: text.substring(0, 50)
        }, "Message sent via WhatsApp");

      } catch (err) {
        logger.error({
          err,
          chatId,
          slug,
          responseId
        }, "Failed to send WhatsApp message");
      }
    });
  });
});

logger.info("Firebase listener initialized for /respuestas/");

const port = Number.parseInt(process.env.PORT ?? "4001", 10);
http.createServer(app).listen(port, () => {
  logger.info({ port }, "whatsapp-service listening");
});

