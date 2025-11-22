import { createInstance, configureWebhook, getConnectionState, getQrCode } from "../services/evolutionClient.js";
import {
  saveEvolutionConfig,
  getEvolutionConfig,
  updateEvolutionConfig,
  // New multi-number functions
  saveWhatsAppNumber,
  getWhatsAppNumbers,
  getWhatsAppNumber,
  getWhatsAppNumberByPhone,
  getDefaultWhatsAppNumber,
  updateWhatsAppNumber as updateWhatsAppNumberRepo,
  deleteWhatsAppNumber as deleteWhatsAppNumberRepo,
  setDefaultWhatsAppNumber,
  migrateLegacyToMultiNumber
} from "../repositories/tiendaRepository.js";
import { logger } from "../utils/logger.js";

const normalizeSlug = (slug) =>
  slug
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const buildInstanceName = (slug) => `colmado_${normalizeSlug(slug)}`;

const mapConnectionStatus = (status) => {
  switch (status) {
    case "open":
      return "connected";
    case "connecting":
      return "connecting";
    case "close":
    default:
      return "pending";
  }
};

const updateWebhookIfNeeded = async ({ instanceName, existingUrl, desiredUrl }) => {
  if (!desiredUrl || desiredUrl === existingUrl) {
    return;
  }

  try {
    await configureWebhook({ instanceName, webhookUrl: desiredUrl });
  } catch (error) {
    if (error.status === 404 || error.status === 405) {
      logger.warn(
        { instanceName, status: error.status },
        "Evolution API webhook endpoint not available while updating webhook"
      );
    } else {
      throw error;
    }
  }
};

export const connectWhatsApp = async (payload) => {
  const { tiendaId, slug, telefono, webhookUrl } = payload;

  const normalizedSlug = normalizeSlug(slug);
  const instanceName = buildInstanceName(normalizedSlug);

  const existingConfig = await getEvolutionConfig(tiendaId);

  if (existingConfig) {
    if (
      existingConfig.instanceName &&
      existingConfig.instanceName !== instanceName &&
      existingConfig.status === "connected"
    ) {
      const error = new Error(
        "La tienda ya tiene una instancia de WhatsApp conectada. Confirma si deseas reemplazarla."
      );
      error.status = 409;
      error.code = "instance_exists";
      throw error;
    }

    if (
      existingConfig.instanceName === instanceName &&
      existingConfig.apiKey &&
      existingConfig.status === "connected"
    ) {
      await updateWebhookIfNeeded({
        instanceName,
        existingUrl: existingConfig.webhookUrl ?? null,
        desiredUrl: webhookUrl
      });

      if (webhookUrl && webhookUrl !== existingConfig.webhookUrl) {
        await updateEvolutionConfig(tiendaId, {
          webhookUrl,
          updatedAt: new Date().toISOString()
        });
      }

      logger.info(
        { tiendaId, instanceName },
        "Evolution instance already connected, skipping recreation"
      );

      return {
        success: true,
        status: "connected",
        instanceName,
        qrCode: existingConfig.qrCode ?? null,
        apiKey: existingConfig.apiKey,
        reused: true
      };
    }

    if (existingConfig.instanceName === instanceName && existingConfig.apiKey) {
      try {
        const stateResponse = await getConnectionState({
          instanceName,
          instanceApiKey: existingConfig.apiKey
        });

        const connectionStatus =
          stateResponse?.instance?.connectionStatus ?? "close";
        const mappedStatus = mapConnectionStatus(connectionStatus);

        let qrCode = existingConfig.qrCode ?? null;

        if (mappedStatus !== "connected") {
          const qrResponse = await getQrCode({
            instanceName,
            instanceApiKey: existingConfig.apiKey
          });

          qrCode = qrResponse?.base64
            ? (qrResponse.base64.startsWith('data:')
                ? qrResponse.base64
                : `data:image/png;base64,${qrResponse.base64}`)
            : (qrResponse?.code ?? qrCode);
        }

        await updateEvolutionConfig(tiendaId, {
          status: mappedStatus,
          connectionStatus,
          qrCode,
          lastSyncedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...(webhookUrl ? { webhookUrl } : {}),
          connectionInfo: {
            number: stateResponse?.instance?.number ?? null,
            profileName: stateResponse?.instance?.profileName ?? null,
            ownerJid: stateResponse?.instance?.ownerJid ?? null
          }
        });

        await updateWebhookIfNeeded({
          instanceName,
          existingUrl: existingConfig.webhookUrl ?? null,
          desiredUrl: webhookUrl
        });

        return {
          success: true,
          status: mappedStatus,
          instanceName,
          qrCode,
          apiKey: existingConfig.apiKey,
          reused: true
        };
      } catch (error) {
        if (error.status !== 404) {
          throw error;
        }

        logger.warn(
          { tiendaId, instanceName },
          "Stored Evolution instance not found, creating a new one"
        );
      }
    }
  }

  const creation = await createInstance({
    instanceName,
    phoneNumber: telefono,
    webhookUrl
  });

  await updateWebhookIfNeeded({
    instanceName,
    existingUrl: existingConfig?.webhookUrl ?? null,
    desiredUrl: webhookUrl
  });

  const { data, token: generatedToken } = creation;
  const apiKey =
    data?.instance?.apikey ??
    data?.hash?.apikey ??
    (typeof data?.hash === "string" ? data.hash : null) ??
    generatedToken ??
    null;

  if (!apiKey) {
    const error = new Error("Evolution API did not return an instance API key");
    error.status = 500;
    error.code = "missing_api_key";
    throw error;
  }

  let qrCodeData = data?.qrcode?.base64
    ? (data.qrcode.base64.startsWith('data:')
        ? data.qrcode.base64
        : `data:image/png;base64,${data.qrcode.base64}`)
    : data?.qrcode?.code ?? null;

  if (!qrCodeData) {
    try {
      logger.info(
        { tiendaId, instanceName },
        "QR not in create response, fetching separately"
      );
      const qrResponse = await getQrCode({ instanceName, instanceApiKey: apiKey });
      qrCodeData = qrResponse?.base64
        ? (qrResponse.base64.startsWith('data:')
            ? qrResponse.base64
            : `data:image/png;base64,${qrResponse.base64}`)
        : qrResponse?.code ?? null;
    } catch (error) {
      logger.warn(
        { tiendaId, instanceName, error: error.message },
        "Failed to fetch QR immediately after creation, will be available via polling"
      );
    }
  }

  const now = new Date().toISOString();

  const record = {
    instanceName,
    apiKey,
    qrCode: qrCodeData,
    status: "pending",
    webhookUrl,
    telefono,
    slug: normalizedSlug,
    createdAt: now,
    updatedAt: now
  };

  await saveEvolutionConfig(tiendaId, record);

  logger.info(
    { tiendaId, instanceName, hasQr: !!qrCodeData },
    "Evolution instance created and stored in Firebase"
  );

  return {
    success: true,
    status: "pending",
    instanceName,
    qrCode: qrCodeData,
    apiKey,
    created: true
  };
};

export const getWhatsAppStatus = async ({ tiendaId, includeQr = false }) => {
  const config = await getEvolutionConfig(tiendaId);

  if (!config) {
    const error = new Error(
      `No se encontró configuración de Evolution para la tienda ${tiendaId}`
    );
    error.status = 404;
    error.code = "not_found";
    throw error;
  }

  const { instanceName, apiKey } = config;

  if (!instanceName || !apiKey) {
    const error = new Error("Configuración de Evolution incompleta en Firebase");
    error.status = 500;
    error.code = "invalid_config";
    throw error;
  }

  const stateResponse = await getConnectionState({
    instanceName,
    instanceApiKey: apiKey
  });

  const connectionStatus = stateResponse?.instance?.connectionStatus ?? "close";
  const mappedStatus = mapConnectionStatus(connectionStatus);
  let qrCode = config.qrCode ?? null;

  if (mappedStatus !== "connected" && includeQr) {
    const qrResponse = await getQrCode({
      instanceName,
      instanceApiKey: apiKey
    });

    qrCode = qrResponse?.base64
      ? (qrResponse.base64.startsWith('data:')
          ? qrResponse.base64
          : `data:image/png;base64,${qrResponse.base64}`)
      : (qrResponse?.code ?? qrCode);
  }

  const updatedRecord = {
    status: mappedStatus,
    connectionStatus,
    lastSyncedAt: new Date().toISOString(),
    qrCode,
    connectionInfo: {
      number: stateResponse?.instance?.number ?? null,
      profileName: stateResponse?.instance?.profileName ?? null,
      ownerJid: stateResponse?.instance?.ownerJid ?? null
    }
  };

  await updateEvolutionConfig(tiendaId, updatedRecord);

  return {
    success: true,
    status: mappedStatus,
    instanceName,
    connectionStatus,
    number: stateResponse?.instance?.number ?? null,
    profileName: stateResponse?.instance?.profileName ?? null,
    qrCode: includeQr ? qrCode : undefined
  };
};

// ====================================
// NEW: Multi-Number WhatsApp Functions
// ====================================

/**
 * Connect a new WhatsApp number to a store (multi-number structure)
 */
export const connectWhatsAppNumber = async (payload) => {
  const { tiendaId, slug, telefono, webhookUrl, displayName } = payload;

  const normalizedSlug = normalizeSlug(slug);
  const instanceName = buildInstanceName(normalizedSlug);

  // Check if this number already exists
  const existing = await getWhatsAppNumberByPhone(tiendaId, telefono);
  if (existing) {
    // Number already exists, check if connected
    if (existing.status === "connected") {
      await updateWebhookIfNeeded({
        instanceName: existing.instanceName,
        existingUrl: existing.webhookUrl ?? null,
        desiredUrl: webhookUrl
      });

      if (webhookUrl && webhookUrl !== existing.webhookUrl) {
        await updateWhatsAppNumberRepo(tiendaId, existing.numberId, {
          webhookUrl,
          updatedAt: new Date().toISOString()
        });
      }

      logger.info(
        { tiendaId, numberId: existing.numberId, telefono },
        "WhatsApp number already connected, reusing"
      );

      return {
        success: true,
        status: "connected",
        numberId: existing.numberId,
        instanceName: existing.instanceName,
        qrCode: existing.qrCode ?? null,
        apiKey: existing.apiKey,
        reused: true
      };
    }

    // Number exists but not connected, try to reconnect
    if (existing.apiKey) {
      try {
        const stateResponse = await getConnectionState({
          instanceName: existing.instanceName,
          instanceApiKey: existing.apiKey
        });

        const connectionStatus = stateResponse?.instance?.connectionStatus ?? "close";
        const mappedStatus = mapConnectionStatus(connectionStatus);

        let qrCode = existing.qrCode ?? null;

        if (mappedStatus !== "connected") {
          const qrResponse = await getQrCode({
            instanceName: existing.instanceName,
            instanceApiKey: existing.apiKey
          });

          qrCode = qrResponse?.base64
            ? (qrResponse.base64.startsWith('data:')
                ? qrResponse.base64
                : `data:image/png;base64,${qrResponse.base64}`)
            : (qrResponse?.code ?? qrCode);
        }

        await updateWhatsAppNumberRepo(tiendaId, existing.numberId, {
          status: mappedStatus,
          connectionStatus,
          qrCode,
          lastSyncedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...(webhookUrl ? { webhookUrl } : {}),
          connectionInfo: {
            number: stateResponse?.instance?.number ?? null,
            profileName: stateResponse?.instance?.profileName ?? null,
            ownerJid: stateResponse?.instance?.ownerJid ?? null
          }
        });

        await updateWebhookIfNeeded({
          instanceName: existing.instanceName,
          existingUrl: existing.webhookUrl ?? null,
          desiredUrl: webhookUrl
        });

        return {
          success: true,
          status: mappedStatus,
          numberId: existing.numberId,
          instanceName: existing.instanceName,
          qrCode,
          apiKey: existing.apiKey,
          reused: true
        };
      } catch (error) {
        if (error.status !== 404) {
          throw error;
        }

        logger.warn(
          { tiendaId, numberId: existing.numberId },
          "Stored instance not found, creating new one"
        );
      }
    }
  }

  // Create new Evolution instance
  const creation = await createInstance({
    instanceName,
    phoneNumber: telefono,
    webhookUrl
  });

  await updateWebhookIfNeeded({
    instanceName,
    existingUrl: existing?.webhookUrl ?? null,
    desiredUrl: webhookUrl
  });

  const { data, token: generatedToken } = creation;
  const apiKey =
    data?.instance?.apikey ??
    data?.hash?.apikey ??
    (typeof data?.hash === "string" ? data.hash : null) ??
    generatedToken ??
    null;

  if (!apiKey) {
    const error = new Error("Evolution API did not return an instance API key");
    error.status = 500;
    error.code = "missing_api_key";
    throw error;
  }

  let qrCodeData = data?.qrcode?.base64
    ? (data.qrcode.base64.startsWith('data:')
        ? data.qrcode.base64
        : `data:image/png;base64,${data.qrcode.base64}`)
    : data?.qrcode?.code ?? null;

  if (!qrCodeData) {
    try {
      logger.info(
        { tiendaId, instanceName },
        "QR not in create response, fetching separately"
      );
      const qrResponse = await getQrCode({ instanceName, instanceApiKey: apiKey });
      qrCodeData = qrResponse?.base64
        ? (qrResponse.base64.startsWith('data:')
            ? qrResponse.base64
            : `data:image/png;base64,${qrResponse.base64}`)
        : qrResponse?.code ?? null;
    } catch (error) {
      logger.warn(
        { tiendaId, instanceName, error: error.message },
        "Failed to fetch QR immediately after creation"
      );
    }
  }

  // Save to new multi-number structure
  const numberId = await saveWhatsAppNumber(tiendaId, {
    instanceName,
    apiKey,
    qrCode: qrCodeData,
    status: "pending",
    webhookUrl,
    telefono,
    slug: normalizedSlug,
    displayName: displayName || "WhatsApp",
    isDefault: false, // New numbers are not default by default
    connectionStatus: "",
    lastSyncedAt: null,
    connectionInfo: null
  });

  logger.info(
    { tiendaId, numberId, instanceName, telefono },
    "New WhatsApp number created in multi-number structure"
  );

  return {
    success: true,
    status: "pending",
    numberId,
    instanceName,
    qrCode: qrCodeData,
    apiKey,
    created: true
  };
};

/**
 * List all WhatsApp numbers for a store
 */
export const listWhatsAppNumbers = async ({ tiendaId }) => {
  const numbers = await getWhatsAppNumbers(tiendaId);

  // Convert object to array with numberId included
  const numbersList = Object.entries(numbers).map(([numberId, data]) => ({
    numberId,
    ...data
  }));

  // Sort by creation date (newest first)
  numbersList.sort((a, b) => {
    const dateA = new Date(a.createdAt || 0);
    const dateB = new Date(b.createdAt || 0);
    return dateB - dateA;
  });

  return {
    success: true,
    numbers: numbersList,
    count: numbersList.length
  };
};

/**
 * Get status of a specific WhatsApp number
 */
export const getWhatsAppNumberStatus = async ({ tiendaId, numberId, includeQr = false }) => {
  const config = await getWhatsAppNumber(tiendaId, numberId);

  if (!config) {
    const error = new Error(
      `No se encontró el número de WhatsApp ${numberId} para la tienda ${tiendaId}`
    );
    error.status = 404;
    error.code = "not_found";
    throw error;
  }

  const { instanceName, apiKey } = config;

  if (!instanceName || !apiKey) {
    const error = new Error("Configuración de Evolution incompleta");
    error.status = 500;
    error.code = "invalid_config";
    throw error;
  }

  const stateResponse = await getConnectionState({
    instanceName,
    instanceApiKey: apiKey
  });

  const connectionStatus = stateResponse?.instance?.connectionStatus ?? "close";
  const mappedStatus = mapConnectionStatus(connectionStatus);
  let qrCode = config.qrCode ?? null;

  if (mappedStatus !== "connected" && includeQr) {
    const qrResponse = await getQrCode({
      instanceName,
      instanceApiKey: apiKey
    });

    qrCode = qrResponse?.base64
      ? (qrResponse.base64.startsWith('data:')
          ? qrResponse.base64
          : `data:image/png;base64,${qrResponse.base64}`)
      : (qrResponse?.code ?? qrCode);
  }

  const updatedRecord = {
    status: mappedStatus,
    connectionStatus,
    lastSyncedAt: new Date().toISOString(),
    qrCode,
    connectionInfo: {
      number: stateResponse?.instance?.number ?? null,
      profileName: stateResponse?.instance?.profileName ?? null,
      ownerJid: stateResponse?.instance?.ownerJid ?? null
    }
  };

  await updateWhatsAppNumberRepo(tiendaId, numberId, updatedRecord);

  return {
    success: true,
    numberId,
    status: mappedStatus,
    instanceName,
    connectionStatus,
    number: stateResponse?.instance?.number ?? null,
    profileName: stateResponse?.instance?.profileName ?? null,
    qrCode: includeQr ? qrCode : undefined,
    isDefault: config.isDefault ?? false,
    displayName: config.displayName ?? "WhatsApp"
  };
};

/**
 * Delete a WhatsApp number
 */
export const deleteWhatsAppNumber = async ({ tiendaId, numberId }) => {
  const config = await getWhatsAppNumber(tiendaId, numberId);

  if (!config) {
    const error = new Error(
      `No se encontró el número de WhatsApp ${numberId}`
    );
    error.status = 404;
    error.code = "not_found";
    throw error;
  }

  // Prevent deletion of default number if it's the only one
  if (config.isDefault) {
    const allNumbers = await getWhatsAppNumbers(tiendaId);
    const count = Object.keys(allNumbers).length;

    if (count === 1) {
      const error = new Error(
        "No se puede eliminar el único número de WhatsApp. Agrega otro primero."
      );
      error.status = 400;
      error.code = "cannot_delete_only_number";
      throw error;
    }

    // If there are other numbers, warn that default will change
    logger.warn(
      { tiendaId, numberId },
      "Deleting default number, another number will become default"
    );
  }

  await deleteWhatsAppNumberRepo(tiendaId, numberId);

  logger.info(
    { tiendaId, numberId, telefono: config.telefono },
    "WhatsApp number deleted"
  );

  return {
    success: true,
    deleted: true,
    numberId
  };
};

/**
 * Set a WhatsApp number as default
 */
export const setDefaultNumber = async ({ tiendaId, telefono }) => {
  const number = await getWhatsAppNumberByPhone(tiendaId, telefono);

  if (!number) {
    const error = new Error(
      `No se encontró el número de WhatsApp ${telefono}`
    );
    error.status = 404;
    error.code = "not_found";
    throw error;
  }

  await setDefaultWhatsAppNumber(tiendaId, telefono);

  logger.info(
    { tiendaId, telefono, numberId: number.numberId },
    "Default WhatsApp number updated"
  );

  return {
    success: true,
    telefono,
    numberId: number.numberId,
    message: "Número predeterminado actualizado"
  };
};

/**
 * Migrate from legacy single-number to multi-number structure
 */
export const migrateToMultiNumber = async ({ tiendaId }) => {
  const result = await migrateLegacyToMultiNumber(tiendaId);

  if (!result.migrated) {
    logger.info({ tiendaId, reason: result.reason }, "Migration not performed");
    return {
      success: false,
      migrated: false,
      reason: result.reason
    };
  }

  logger.info(
    { tiendaId, numberId: result.numberId, telefono: result.telefono },
    "Store migrated to multi-number structure"
  );

  return {
    success: true,
    migrated: true,
    numberId: result.numberId,
    telefono: result.telefono,
    message: result.message
  };
};

export default {
  // Old single-number functions (backward compatibility)
  connectWhatsApp,
  getWhatsAppStatus,
  // New multi-number functions
  connectWhatsAppNumber,
  listWhatsAppNumbers,
  getWhatsAppNumberStatus,
  deleteWhatsAppNumber,
  setDefaultNumber,
  migrateToMultiNumber
};
