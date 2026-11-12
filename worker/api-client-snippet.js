// La Reviú — fragmento de integración para el cliente (index.html).
// NO es un archivo que se ejecute solo: el agente que edita index.html debe
// pegar estas funciones (o su equivalente) y conectarlas al formulario de
// solicitud, a las tarjetas de reseñas y al Studio.
//
// Regla de oro: la API es la fuente de verdad. localStorage SOLO es respaldo
// offline: si la API responde, sus datos mandan; si no responde, se muestra
// lo cacheado y las solicitudes pendientes se reintentan después.
// Claves locales actuales en index.html (NO borrar): 'reviu-studio-demo-v2'.

// --- Configuración ---------------------------------------------------------
// En producción: la URL del Worker (workers.dev o dominio propio).
// En local, dejar '' para mismo origen.
const REVIU_API_BASE = ''; // p. ej. 'https://la-reviu.<subdominio>.workers.dev'

const reviuApi = async (path, opts = {}) => {
  const r = await fetch(REVIU_API_BASE + path, {
    credentials: 'include', // necesario: la sesión viaja en cookie
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('Error ' + r.status));
  return data;
};

// --- Solicitudes ("Solicita una Reviú") ------------------------------------
// Uso: en el submit de #request-form, llamar a sendReviuRequest(datos).
// Si la API responde: celebrar y limpiar el form. Si NO responde (offline):
// guardar en la cola local y avisar que se enviará al recuperar conexión.
const REVIU_PENDING_KEY = 'reviu-pending-requests-v1';
const getPendingRequests = () => {
  try { return JSON.parse(localStorage.getItem(REVIU_PENDING_KEY)) || []; }
  catch { return []; }
};
const queuePendingRequest = (req) => {
  const q = getPendingRequests();
  q.unshift({ ...req, queuedAt: new Date().toISOString() });
  try { localStorage.setItem(REVIU_PENDING_KEY, JSON.stringify(q.slice(0, 50))); } catch {}
};
const flushPendingRequests = async () => {
  const q = getPendingRequests();
  if (!q.length) return 0;
  let sent = 0;
  const remaining = [];
  for (const req of q) {
    try { await reviuApi('/api/requests', { method: 'POST', body: JSON.stringify(req) }); sent++; }
    catch { remaining.push(req); }
  }
  try { localStorage.setItem(REVIU_PENDING_KEY, JSON.stringify(remaining)); } catch {}
  return sent;
};
const sendReviuRequest = async ({ nombre, contacto, lugar, categoria, mensaje }) => {
  const payload = { nombre, contacto, lugar, categoria, mensaje };
  try {
    const res = await reviuApi('/api/requests', { method: 'POST', body: JSON.stringify(payload) });
    await flushPendingRequests().catch(() => {});
    return { ok: true, id: res.id, emailSent: res.emailSent };
  } catch (e) {
    // Respaldo offline: la solicitud NO se pierde, se reintenta sola.
    queuePendingRequest(payload);
    return { ok: false, offline: true, error: String(e.message || e) };
  }
};

// --- Reseñas públicas -------------------------------------------------------
// Uso: al cargar #review-cards y #home-cards, llamar a loadPublicReviews().
// Si la API responde: renderizar sus items y refrescar el caché local.
// Si NO responde: renderizar el caché (o los 3 placeholders actuales).
const REVIU_CACHE_KEY = 'reviu-reviews-cache-v1';
const loadPublicReviews = async ({ categoria = '', limit = 50 } = {}) => {
  try {
    const q = new URLSearchParams();
    if (categoria) q.set('categoria', categoria);
    if (limit) q.set('limit', String(limit));
    const { items } = await reviuApi('/api/reviews?' + q.toString());
    try { localStorage.setItem(REVIU_CACHE_KEY, JSON.stringify({ items, cachedAt: Date.now() })); } catch {}
    return { items, fromCache: false };
  } catch {
    try {
      const cached = JSON.parse(localStorage.getItem(REVIU_CACHE_KEY)) || {};
      return { items: Array.isArray(cached.items) ? cached.items : [], fromCache: true };
    } catch { return { items: [], fromCache: true }; }
  }
};

// --- Auth de Studio (solo el dueño, Google OAuth) ---------------------------
// Uso: al entrar a #studio, llamar a reviuMe(). Si user?.admin, cargar Studio
// desde la API; si no, mostrar el botón "Entrar con Google" que apunta a
// REVIU_API_BASE + '/api/auth/google/start'. Cualquier otro usuario Google
// autenticado verá 403 en Studio: es el comportamiento correcto.
const reviuMe = async () => {
  try { const { user } = await reviuApi('/api/auth/me'); return user; }
  catch { return null; }
};
const reviuLogout = async () => {
  await reviuApi('/api/auth/logout', { method: 'POST' }).catch(() => {});
};

// --- Studio: solicitudes y reseñas (solo admin; 401 sin sesión, 403 si no
// es el dueño). Las funciones lanzan Error con el mensaje del servidor. ------
const studioListRequests = (estado = '') =>
  reviuApi('/api/studio/requests' + (estado ? '?estado=' + encodeURIComponent(estado) : ''));
const studioSetRequestStatus = (id, estado) =>
  reviuApi('/api/studio/requests/' + encodeURIComponent(id) + '/status', {
    method: 'POST', body: JSON.stringify({ estado }),
  });
const studioDeleteRequest = (id) =>
  reviuApi('/api/studio/requests/' + encodeURIComponent(id), { method: 'DELETE' });
const studioListReviews = (status = '') =>
  reviuApi('/api/studio/reviews' + (status ? '?status=' + encodeURIComponent(status) : ''));
const studioCreateReview = (review) =>
  reviuApi('/api/studio/reviews', { method: 'POST', body: JSON.stringify(review) });
const studioUpdateReview = (id, review) =>
  reviuApi('/api/studio/reviews/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(review) });
const studioDeleteReview = (id) =>
  reviuApi('/api/studio/reviews/' + encodeURIComponent(id), { method: 'DELETE' });
const studioStats = () => reviuApi('/api/studio/stats');

// Formato de una reseña para crear/editar (campos del Worker):
// { title, place, category: 'Restaurante'|'Bar'|'Turismo'|'Festival'|'Viaje'|'Otro',
//   summary, body, photo (URL https), video (URL https), rating (1-5 o null),
//   code (p. ej. 'FOOD-01'), status: 'borrador'|'publicado' }
// Al publicar (status 'publicado') aparece en GET /api/reviews; en borrador
// solo se ve en Studio.
