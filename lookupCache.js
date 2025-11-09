import admin from "firebase-admin";

const db = admin.database();

const cache = new Map(); // chatId → { tiendaId, usuarioId, slug, sessionStartTs, expires }

export async function enrichWhatsAppPayload(payload) {
  const { chatId, tiendaSlug } = payload;
  const now = Date.now();
  const cached = cache.get(chatId);

  // Reuse cache if fresh (<60s)
  if (cached && cached.expires > now) {
    Object.assign(payload, cached);
    payload.profileReady = true;
    payload.firstInSession = false;
    payload.meta.profileReady = true;
    payload.meta.firstInSession = false;
    return payload;
  }

  // Parallel lookups
  const [tiendaSnap, usuarioSnap] = await Promise.all([
    db.ref(`/tiendas_por_slug/${tiendaSlug}`).get(),
    db.ref(`/usuarios_por_identidad/${chatId}`).get(),
  ]);

  const tiendaId = tiendaSnap.val();
  const usuarioId = usuarioSnap.exists() ? usuarioSnap.val() : null;
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
    }
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
