import admin from "firebase-admin";

const cache = new Map(); // chatId → { tiendaId, usuarioId, slug, sessionStartTs, expires }

// Normalize phone number to match Firebase format: "18091234567" -> "+18091234567"
function normalizePhone(phone) {
  if (!phone) return null;

  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, '');

  // Add + prefix to match Firebase storage format
  return `+${digits}`;
}

export async function enrichWhatsAppPayload(payload) {
  const { chatId, tiendaSlug, telefono } = payload;
  const now = Date.now();
  const cached = cache.get(chatId);

  // Get database reference (initialized in server.js)
  const db = admin.database();

  // Reuse cache if fresh (<60s)
  if (cached && cached.expires > now) {
    Object.assign(payload, cached);
    payload.profileReady = true;
    payload.firstInSession = false;
    payload.meta.profileReady = true;
    payload.meta.firstInSession = false;
    return payload;
  }

  // Parallel lookups: tiendaId + user by chatId
  const [tiendaSnap, usuarioSnap] = await Promise.all([
    db.ref(`/tiendas_por_slug/${tiendaSlug}`).get(),
    db.ref(`/usuarios_por_identidad/${chatId}`).get(),
  ]);

  const tiendaId = tiendaSnap.val();
  let usuarioId = usuarioSnap.exists() ? usuarioSnap.val() : null;

  // If not found by chatId, try by phone number (cross-channel identity)
  if (!usuarioId && telefono) {
    const normalizedPhone = normalizePhone(telefono);
    if (normalizedPhone) {
      const phoneSnap = await db.ref(`/usuarios_por_telefono/${normalizedPhone}`).get();
      if (phoneSnap.exists()) {
        usuarioId = phoneSnap.val();
      }
    }
  }

  const profileReady = !!usuarioId;

  let sessionStartTs = Date.now();
  let firstInSession = true;
  if (usuarioId) {
    const sessionSnap = await db
      .ref(`/sesiones_index/${tiendaId}/${usuarioId}`)
      .get();
    if (sessionSnap.exists()) {
      firstInSession = false;
      sessionStartTs = sessionSnap.val().sessionStartTs || sessionStartTs;
      console.log(`[CACHE] Session found for ${usuarioId}: firstInSession=false, sessionStartTs=${sessionStartTs}`);
    } else {
      console.log(`[CACHE] No session found for ${usuarioId}: firstInSession=true (new session)`);
    }
  } else {
    console.log(`[CACHE] No usuarioId found: profileReady=false, firstInSession=true`);
  }

  // Cache for 60s
  cache.set(chatId, {
    tiendaId,
    usuarioId,
    slug: tiendaSlug,
    sessionStartTs,
    expires: now + 60_000,
  });

  // Inject data into payload
  payload.tiendaId = tiendaId;
  payload.profileReady = profileReady;
  payload.firstInSession = firstInSession;
  payload.sessionStartTs = sessionStartTs;
  payload.meta.profileReady = profileReady;
  payload.meta.firstInSession = firstInSession;

  return payload;
}
