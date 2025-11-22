import { getRealtimeDatabase } from "../services/firebaseService.js";
import { logger } from "../utils/logger.js";

// ====================================
// OLD STRUCTURE: Single WhatsApp (KEEP FOR BACKWARD COMPATIBILITY)
// Path: /tiendas/{tiendaId}/evolution
// ====================================

const getEvolutionRef = (tiendaId) =>
  getRealtimeDatabase().ref(`/tiendas/${tiendaId}/evolution`);

export const saveEvolutionConfig = async (tiendaId, data) => {
  const ref = getEvolutionRef(tiendaId);
  await ref.set(data);
};

export const getEvolutionConfig = async (tiendaId) => {
  const ref = getEvolutionRef(tiendaId);
  const snapshot = await ref.get();
  return snapshot.exists() ? snapshot.val() : null;
};

export const updateEvolutionConfig = async (tiendaId, data) => {
  const ref = getEvolutionRef(tiendaId);
  await ref.update(data);
};

// Alias for clarity in migration code
export const getLegacyEvolutionConfig = getEvolutionConfig;

// ====================================
// NEW STRUCTURE: Multiple WhatsApp Numbers
// Path: /tiendas/{tiendaId}/whatsapp_numbers/{numberId}
// ====================================

const getWhatsAppNumbersRef = (tiendaId) =>
  getRealtimeDatabase().ref(`/tiendas/${tiendaId}/whatsapp_numbers`);

const getWhatsAppNumberRef = (tiendaId, numberId) =>
  getWhatsAppNumbersRef(tiendaId).child(numberId);

/**
 * Save a new WhatsApp number configuration
 * @returns {Promise<string>} numberId (Firebase push key)
 */
export const saveWhatsAppNumber = async (tiendaId, data) => {
  const ref = getWhatsAppNumbersRef(tiendaId).push();
  await ref.set({
    ...data,
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  return ref.key;
};

/**
 * Get all WhatsApp numbers for a store
 * @returns {Promise<Object>} { numberId1: {...}, numberId2: {...} }
 */
export const getWhatsAppNumbers = async (tiendaId) => {
  const ref = getWhatsAppNumbersRef(tiendaId);
  const snapshot = await ref.get();
  return snapshot.exists() ? snapshot.val() : {};
};

/**
 * Get a specific WhatsApp number by numberId
 */
export const getWhatsAppNumber = async (tiendaId, numberId) => {
  const ref = getWhatsAppNumberRef(tiendaId, numberId);
  const snapshot = await ref.get();
  return snapshot.exists() ? snapshot.val() : null;
};

/**
 * Get WhatsApp number by phone number (search by telefono field)
 */
export const getWhatsAppNumberByPhone = async (tiendaId, telefono) => {
  const ref = getWhatsAppNumbersRef(tiendaId);
  const snapshot = await ref.orderByChild("telefono").equalTo(telefono).get();

  if (!snapshot.exists()) return null;

  const data = snapshot.val();
  const numberId = Object.keys(data)[0];
  return { numberId, ...data[numberId] };
};

/**
 * Get default WhatsApp number for store
 */
export const getDefaultWhatsAppNumber = async (tiendaId) => {
  // Try to get default reference
  const defaultRef = getRealtimeDatabase().ref(`/tiendas/${tiendaId}/whatsapp_default`);
  const defaultSnapshot = await defaultRef.get();

  if (defaultSnapshot.exists()) {
    const defaultTelefono = defaultSnapshot.val();
    return await getWhatsAppNumberByPhone(tiendaId, defaultTelefono);
  }

  // Fallback: get first number marked as default
  const ref = getWhatsAppNumbersRef(tiendaId);
  const snapshot = await ref.orderByChild("isDefault").equalTo(true).limitToFirst(1).get();

  if (snapshot.exists()) {
    const data = snapshot.val();
    const numberId = Object.keys(data)[0];
    return { numberId, ...data[numberId] };
  }

  // Fallback: return first number
  const allSnapshot = await ref.limitToFirst(1).get();
  if (allSnapshot.exists()) {
    const data = allSnapshot.val();
    const numberId = Object.keys(data)[0];
    return { numberId, ...data[numberId] };
  }

  return null;
};

/**
 * Update a specific WhatsApp number
 */
export const updateWhatsAppNumber = async (tiendaId, numberId, data) => {
  const ref = getWhatsAppNumberRef(tiendaId, numberId);
  await ref.update({
    ...data,
    updatedAt: new Date().toISOString()
  });
};

/**
 * Delete a WhatsApp number
 */
export const deleteWhatsAppNumber = async (tiendaId, numberId) => {
  const ref = getWhatsAppNumberRef(tiendaId, numberId);
  await ref.remove();
};

/**
 * Set default WhatsApp number
 */
export const setDefaultWhatsAppNumber = async (tiendaId, telefono) => {
  // Remove default flag from all numbers
  const numbers = await getWhatsAppNumbers(tiendaId);
  const updates = {};

  Object.keys(numbers).forEach((numberId) => {
    updates[`${numberId}/isDefault`] = numbers[numberId].telefono === telefono;
  });

  await getWhatsAppNumbersRef(tiendaId).update(updates);

  // Set default reference
  await getRealtimeDatabase()
    .ref(`/tiendas/${tiendaId}/whatsapp_default`)
    .set(telefono);
};

// ====================================
// COMPATIBILITY LAYER: Works with BOTH structures
// ====================================

/**
 * Check if store uses old single-number structure
 */
export const hasLegacyEvolutionConfig = async (tiendaId) => {
  const config = await getEvolutionConfig(tiendaId);
  return config !== null;
};

/**
 * Get WhatsApp config from EITHER old or new structure
 * Priority: new structure → old structure → null
 */
export const getAnyEvolutionConfig = async (tiendaId) => {
  // 1. Try new multi-number structure (default number)
  try {
    const defaultNumber = await getDefaultWhatsAppNumber(tiendaId);
    if (defaultNumber) {
      logger.debug({ tiendaId }, "Found config in new multi-number structure");
      return defaultNumber;
    }
  } catch (error) {
    logger.warn({ tiendaId, error: error.message }, "Failed to get new structure config");
  }

  // 2. Fallback to old single-number structure
  try {
    const legacyConfig = await getEvolutionConfig(tiendaId);
    if (legacyConfig) {
      logger.debug({ tiendaId }, "Found config in legacy single-number structure");
      return legacyConfig;
    }
  } catch (error) {
    logger.warn({ tiendaId, error: error.message }, "Failed to get legacy config");
  }

  return null;
};

/**
 * Migrate from legacy single-number to multi-number structure
 */
export const migrateLegacyToMultiNumber = async (tiendaId) => {
  // 1. Check if already migrated
  const existing = await getWhatsAppNumbers(tiendaId);
  if (Object.keys(existing).length > 0) {
    return { migrated: false, reason: "Already migrated" };
  }

  // 2. Get legacy data
  const legacyData = await getEvolutionConfig(tiendaId);
  if (!legacyData) {
    return { migrated: false, reason: "No legacy data found" };
  }

  // 3. CREATE SNAPSHOT of old data (safety backup)
  await getRealtimeDatabase()
    .ref(`/tiendas/${tiendaId}/_migration_backup`)
    .set({
      evolution: legacyData,
      backupDate: new Date().toISOString(),
      migratedBy: "auto"
    });

  // 4. Create new number with legacy data
  const numberId = await saveWhatsAppNumber(tiendaId, {
    instanceName: legacyData.instanceName,
    apiKey: legacyData.apiKey,
    status: legacyData.status || "pending",
    telefono: legacyData.telefono,
    displayName: "Principal",
    isDefault: true,
    webhookUrl: legacyData.webhookUrl || "",
    qrCode: legacyData.qrCode || null,
    slug: legacyData.slug || "",
    createdAt: legacyData.createdAt || new Date().toISOString(),
    connectionStatus: legacyData.connectionStatus || "",
    lastSyncedAt: legacyData.lastSyncedAt || null,
    connectionInfo: legacyData.connectionInfo || null,
    migratedFrom: "evolution"
  });

  // 5. Set as default
  await setDefaultWhatsAppNumber(tiendaId, legacyData.telefono);

  logger.info({ tiendaId, numberId, telefono: legacyData.telefono }, "Legacy config migrated to multi-number structure");

  // 6. KEEP old structure (DON'T DELETE) for safety
  // Old data stays at /tiendas/{tiendaId}/evolution

  return {
    migrated: true,
    numberId,
    telefono: legacyData.telefono,
    message: "Migration successful. Old structure preserved for safety."
  };
};

// ====================================
// EXPORTS
// ====================================

export default {
  // Old structure (KEEP for backward compatibility)
  saveEvolutionConfig,
  getEvolutionConfig,
  updateEvolutionConfig,
  getLegacyEvolutionConfig,
  hasLegacyEvolutionConfig,

  // New multi-number structure
  saveWhatsAppNumber,
  getWhatsAppNumbers,
  getWhatsAppNumber,
  getWhatsAppNumberByPhone,
  getDefaultWhatsAppNumber,
  updateWhatsAppNumber,
  deleteWhatsAppNumber,
  setDefaultWhatsAppNumber,

  // Compatibility & migration
  getAnyEvolutionConfig,
  migrateLegacyToMultiNumber
};
