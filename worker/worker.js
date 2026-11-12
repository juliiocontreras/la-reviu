// La Reviú — Cloudflare Worker (ES module)
// Backend real de la bitácora de Julio (juliiocontreras/la-reviu).
// Patrón tomado de TecnicosMX (~/workspace/tecnicosmx-rebuild/worker-turso.js
// y worker.js): sesión por cookie y aviso por Resend. Diferencias:
//   - Auth: SOLO usuario + contraseña (uso interno, solo Julio). Sin Google
//     OAuth: el navegador envía SHA-256 de la contraseña y el Worker guarda
//     SHA-256 de ese hash en D1 (tabla admin_users). El setup de primer uso
//     (POST /api/auth/setup) solo funciona si aún no existe administrador.
//   - Almacén PREFERIDO: D1 (binding DB). Sin R2: las fotos/videos de las
//     reseñas son URLs externas (Unsplash, etc.), no se suben archivos.
//   - Fallback documentado: Turso por pipeline HTTP Hrana v2, mismo patrón
//     que TecnicosMX, activo solo si NO hay binding D1 y SÍ hay
//     TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.
//   - El frontend vive en Pages, NO embebido aquí: este Worker solo
//     sirve /api/*, por eso hay CORS (origen permitido por env).
//
// Bindings / variables de entorno:
//   DB (D1, preferido) | TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (fallback)
//   RESEND_API_KEY (secreto; heredado del Worker de TecnicosMX solo si se
//   pone con `wrangler secret put` en ESTE Worker — nunca va en el código)
//   ALLOWED_ORIGIN (plain text, opcional; por defecto Pages de La Reviú)
//
// Admin: un solo usuario en admin_users, creado por Julio en /admin.
// Sin sesión, /api/studio/* responde 401.

const NOTIFY_TO = 'juliiocontreras@gmail.com';
const NOTIFY_FROM = 'La Reviú <noreply@tapmarketing.site>'; // Dominio verificado en Resend (plan: solo 3 dominios; la-reviu no cabe sin subir de plan)
const SESSION_COOKIE = 'reviu_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días, igual que TecnicosMX
// Usuario: 3-40 caracteres [A-Za-z0-9._-]. La contraseña viaja como hash
// SHA-256 en hexadecimal (64 chars) y se guarda SHA-256 de ese hash.
const USERNAME_RE = /^[A-Za-z0-9._-]{3,40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
const CATEGORIES = ['Restaurante', 'Bar', 'Turismo', 'Festival', 'Viaje', 'Otro'];
const REQUEST_STATES = ['Pendiente', 'En contacto', 'En producción', 'Publicado', 'Cerrado'];
const REVIEW_STATES = ['borrador', 'publicado'];

const J = (x, s = 200, extraHeaders = {}) => Response.json(x, {
  status: s,
  headers: { 'cache-control': 'no-store', ...extraHeaders },
});
const rand = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const sha = async s => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map(x => x.toString(16).padStart(2, '0')).join('');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cookieVal = (req, name) => req.headers.get('cookie')?.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'))?.[1] || null;
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

// ---- CORS: el frontend está en GitHub Pages, otro origen que el Worker ----
const allowedOrigins = env => [env.ALLOWED_ORIGIN, 'https://la-reviu.pages.dev'].filter(Boolean);
const corsOrigin = (req, env) => {
  const o = req.headers.get('origin');
  return o && allowedOrigins(env).includes(o) ? o : null;
};
const corsHeaders = (req, env) => {
  const o = corsOrigin(req, env);
  return o ? { 'access-control-allow-origin': o, 'access-control-allow-credentials': 'true', 'vary': 'Origin' } : {};
};

// ---- Capa de datos: D1 preferido, Turso fallback (mismo contrato) ----
// Contrato: one(sql, args) -> fila|null; all(sql, args) -> filas[];
// run(sql, args) -> { affected }. Los dos adaptadores lo cumplen.
const storeKind = env => (env.DB ? 'd1' : (env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN ? 'turso' : 'none'));

const d1 = env => ({
  one: async (sql, args = []) => await env.DB.prepare(sql).bind(...args).first() || null,
  all: async (sql, args = []) => (await env.DB.prepare(sql).bind(...args).all()).results || [],
  run: async (sql, args = []) => {
    const r = await env.DB.prepare(sql).bind(...args).run();
    return { affected: r.meta?.changes ?? 0 };
  },
});

// Cliente Turso: HTTP pipeline Hrana v2 (mismo patrón que TecnicosMX).
const encArg = v => v === null || v === undefined ? { type: 'null' }
  : typeof v === 'string' ? { type: 'text', value: v }
  : typeof v === 'boolean' ? { type: 'integer', value: v ? '1' : '0' }
  : typeof v === 'number' && Number.isFinite(v)
    ? (Number.isSafeInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v })
    : (() => { throw new Error('Valor SQL no soportado'); })();
const tursoEndpoint = env => {
  const raw = (env.TURSO_DATABASE_URL || '').trim();
  if (!raw) throw new Error('Turso no configurado');
  const u = new URL(raw.replace(/^libsql:/i, 'https:').replace(/^turso:/i, 'https:').replace(/^wss:/i, 'https:'));
  if (u.protocol !== 'https:') throw new Error('Turso requiere HTTPS');
  return u.origin + '/v2/pipeline';
};
const turso = env => {
  const q = async (sql, args = []) => {
    const r = await fetch(tursoEndpoint(env), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env.TURSO_AUTH_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: args.map(encArg) } }, { type: 'close' }] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('Turso HTTP ' + r.status);
    const body = await r.json();
    const item = body.results?.[0];
    if (item?.type === 'error') throw new Error('Turso: ' + (item.error?.message || 'error SQL'));
    if (item?.type !== 'ok') throw new Error('Respuesta Turso inesperada');
    const res = item.response?.result || {};
    const cols = (res.cols || []).map(c => c.name);
    const rows = (res.rows || []).map(row => {
      const o = {};
      row.forEach((cell, i) => {
        let v = cell?.value ?? null;
        if (cell?.type === 'integer' || cell?.type === 'float') v = Number(v);
        o[cols[i]] = v;
      });
      return o;
    });
    return { rows, affected: Number(res.rows_affected || 0) };
  };
  return {
    one: async (sql, args = []) => (await q(sql, args)).rows[0] || null,
    all: async (sql, args = []) => (await q(sql, args)).rows,
    run: async (sql, args = []) => q(sql, args),
  };
};
const db = env => {
  const kind = storeKind(env);
  if (kind === 'd1') return d1(env);
  if (kind === 'turso') return turso(env);
  throw Object.assign(new Error('Base de datos no configurada'), { status: 503 });
};

// ---- Resend: aviso al dueño por cada solicitud nueva ----
const notifyOwner = async (env, req) => {
  if (!env.RESEND_API_KEY) return { sent: false, reason: 'Resend no configurado' };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: NOTIFY_FROM,
      to: NOTIFY_TO,
      subject: 'Nueva solicitud de Reviú: ' + req.lugar,
      html: '<p><strong>' + esc(req.nombre) + '</strong> pide una Reviú para <strong>' + esc(req.lugar) + '</strong> (' + esc(req.categoria) + ').</p>'
        + '<p>Contacto: ' + esc(req.contacto) + '</p>'
        + '<p>' + esc(req.mensaje).replace(/\n/g, '<br>') + '</p>'
        + '<p><a href="https://la-reviu.pages.dev/admin">Abrir el panel de administración</a></p>',
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('Resend ' + r.status + ' ' + t.slice(0, 200));
  }
  return { sent: true };
};

// ---- Presentación pública de reseñas ----
const pubReview = x => x ? {
  id: x.id, title: x.title, place: x.place, category: x.category,
  summary: x.summary, body: x.body, photo: x.photo, video: x.video,
  rating: x.rating, code: x.code, created_at: x.created_at, updated_at: x.updated_at,
} : null;

export default {
  async fetch(req, env) {
    const u = new URL(req.url), p = u.pathname;
    const cors = corsHeaders(req, env);
    const json = (x, s = 200, extra = {}) => J(x, s, { ...cors, ...extra });

    // Preflight CORS (GitHub Pages -> Worker)
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
        },
      });
    }

    try {
      const store = db(env);
      // Sesión de administrador: cookie httpOnly con un token aleatorio
      // cuyo hash vive en admin_sessions (nunca el token en claro).
      const getAdmin = async () => {
        const t = cookieVal(req, SESSION_COOKIE);
        if (!t) return null;
        return await store.one(
          'SELECT a.id,a.username FROM admin_sessions s JOIN admin_users a ON s.admin_id=a.id WHERE s.token_hash=? AND s.expires_at>?',
          [await sha(t), Date.now()]) || null;
      };
      const newSession = async adminId => {
        const sid = rand();
        await store.run('INSERT INTO admin_sessions(token_hash,admin_id,expires_at) VALUES(?,?,?)', [await sha(sid), adminId, Date.now() + SESSION_TTL_MS]);
        return sid;
      };
      const sessionCookie = sid => SESSION_COOKIE + '=' + sid + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000);
      const requireAdmin = async () => {
        const adm = await getAdmin();
        if (!adm) return { error: json({ error: 'Inicia sesión en /admin' }, 401) };
        return { adm };
      };

      // ---- Salud ----
      if (p === '/api/health' && req.method === 'GET') {
        let storeOk = false;
        let adminConfigured = false;
        try { await store.one('SELECT 1 AS ok'); storeOk = true; } catch {}
        try { adminConfigured = !!(await store.one('SELECT 1 AS x FROM admin_users LIMIT 1')); } catch {}
        return json({
          ok: true, service: 'la-reviu-api', store: storeKind(env), storeOk,
          adminConfigured,
          resendConfigured: !!env.RESEND_API_KEY,
        });
      }

      // ---- Auth de administrador: usuario + contraseña (solo /admin) ----
      // El cliente envía passwordHash = SHA-256 hex de la contraseña; el
      // servidor guarda SHA-256 de ese hash. La contraseña en claro nunca
      // viaja ni se guarda.
      if (p === '/api/auth/status' && req.method === 'GET') {
        const configured = !!(await store.one('SELECT 1 AS x FROM admin_users LIMIT 1').catch(() => null));
        const adm = await getAdmin();
        return json({ configured, authenticated: !!adm, username: adm?.username || null });
      }
      if (p === '/api/auth/setup' && req.method === 'POST') {
        const existing = await store.one('SELECT 1 AS x FROM admin_users LIMIT 1').catch(() => null);
        if (existing) return json({ error: 'El acceso de administrador ya está creado' }, 403);
        const d = await req.json().catch(() => ({}));
        const username = clean(d.username, 40).toLowerCase();
        const passwordHash = clean(d.passwordHash, 64).toLowerCase();
        if (!USERNAME_RE.test(username)) return json({ error: 'Usuario inválido: 3-40 caracteres (letras, números, punto, guion y guion bajo)' }, 400);
        if (!HASH_RE.test(passwordHash)) return json({ error: 'Contraseña inválida' }, 400);
        const id = crypto.randomUUID();
        await store.run(
          'INSERT INTO admin_users(id,username,password_hash,created_at) VALUES(?,?,?,?)',
          [id, username, await sha(passwordHash), new Date().toISOString()]);
        const sid = await newSession(id);
        return json({ ok: true, username }, 201, { 'set-cookie': sessionCookie(sid) });
      }
      if (p === '/api/auth/login' && req.method === 'POST') {
        const d = await req.json().catch(() => ({}));
        const username = clean(d.username, 40).toLowerCase();
        const passwordHash = clean(d.passwordHash, 64).toLowerCase();
        const row = await store.one('SELECT id,username,password_hash FROM admin_users WHERE username=?', [username]).catch(() => null);
        if (!row || !HASH_RE.test(passwordHash) || !safeEqual(row.password_hash, await sha(passwordHash))) {
          return json({ error: 'Usuario o contraseña incorrectos' }, 401);
        }
        const sid = await newSession(row.id);
        return json({ ok: true, username: row.username }, 200, { 'set-cookie': sessionCookie(sid) });
      }
      if (p === '/api/auth/me' && req.method === 'GET') {
        const adm = await getAdmin();
        return json({ user: adm ? { id: adm.id, username: adm.username, admin: true } : null });
      }
      if (p === '/api/auth/change-password' && req.method === 'POST') {
        const { error, adm } = await requireAdmin();
        if (error) return error;
        const d = await req.json().catch(() => ({}));
        const currentHash = clean(d.currentPasswordHash, 64).toLowerCase();
        const newHash = clean(d.newPasswordHash, 64).toLowerCase();
        if (!HASH_RE.test(currentHash) || !HASH_RE.test(newHash)) return json({ error: 'Contraseña inválida' }, 400);
        if (currentHash === newHash) return json({ error: 'La contraseña nueva debe ser distinta a la actual' }, 400);
        const row = await store.one('SELECT password_hash FROM admin_users WHERE id=?', [adm.id]);
        if (!row || !safeEqual(row.password_hash, await sha(currentHash))) {
          return json({ error: 'La contraseña actual no coincide' }, 401);
        }
        await store.run('UPDATE admin_users SET password_hash=? WHERE id=?', [await sha(newHash), adm.id]);
        // Cierra las demás sesiones del administrador; la actual sigue.
        const t = cookieVal(req, SESSION_COOKIE);
        await store.run('DELETE FROM admin_sessions WHERE admin_id=? AND token_hash!=?', [adm.id, t ? await sha(t) : '']);
        return json({ ok: true });
      }
      if (p === '/api/auth/logout' && req.method === 'POST') {
        const t = cookieVal(req, SESSION_COOKIE);
        if (t) await store.run('DELETE FROM admin_sessions WHERE token_hash=?', [await sha(t)]);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json', ...cors, 'set-cookie': SESSION_COOKIE + '=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0' },
        });
      }

      // ---- Solicitud pública: "Solicita una Reviú" ----
      if (p === '/api/requests' && req.method === 'POST') {
        const d = await req.json().catch(() => ({}));
        const nombre = clean(d.nombre, 80);
        const contacto = clean(d.contacto, 100);
        const lugar = clean(d.lugar, 100);
        const categoria = clean(d.categoria, 30);
        const mensaje = clean(d.mensaje, 1000);
        if (nombre.length < 2) return json({ error: 'Tu nombre es obligatorio (mínimo 2 caracteres)' }, 400);
        if (contacto.length < 3) return json({ error: 'El contacto es obligatorio (correo o teléfono)' }, 400);
        if (lugar.length < 2) return json({ error: 'El nombre del lugar es obligatorio' }, 400);
        if (!CATEGORIES.includes(categoria)) return json({ error: 'Categoría inválida. Usa: ' + CATEGORIES.join(', ') }, 400);
        if (mensaje.length < 1) return json({ error: 'Cuéntanos qué hace especial al lugar' }, 400);
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await store.run(
          'INSERT INTO requests(id,nombre,contacto,lugar,categoria,mensaje,estado,created_at) VALUES(?,?,?,?,?,?,?,?)',
          [id, nombre, contacto, lugar, categoria, mensaje, 'Pendiente', now]);
        // El aviso por correo no debe tumbar la solicitud: si Resend falla
        // o no está configurado, la solicitud YA quedó guardada.
        let email = { sent: false, reason: 'Resend no configurado' };
        try { email = await notifyOwner(env, { nombre, contacto, lugar, categoria, mensaje }); }
        catch (e) { email = { sent: false, reason: String(e.message || e).slice(0, 200) }; }
        return json({ ok: true, id, emailSent: email.sent, emailError: email.sent ? undefined : email.reason }, 201);
      }

      // ---- Reseñas públicas: solo estado publicado ----
      if (p === '/api/reviews' && req.method === 'GET') {
        const cat = clean(u.searchParams.get('categoria'), 30);
        const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '50', 10) || 50, 1), 100);
        let sql = "SELECT * FROM reviews WHERE status='publicado'";
        const args = [];
        if (cat) {
          if (!CATEGORIES.includes(cat)) return json({ error: 'Categoría inválida' }, 400);
          sql += ' AND category=?'; args.push(cat);
        }
        sql += ' ORDER BY created_at DESC LIMIT ?'; args.push(limit);
        const rows = await store.all(sql, args);
        return json({ items: rows.map(pubReview) });
      }
      const reviewMatch = p.match(/^\/api\/reviews\/([^/]+)$/);
      if (reviewMatch && req.method === 'GET') {
        const row = await store.one("SELECT * FROM reviews WHERE id=? AND status='publicado'", [decodeURIComponent(reviewMatch[1])]);
        if (!row) return json({ error: 'Reseña no encontrada' }, 404);
        return json({ item: pubReview(row) });
      }

      // ---- Studio: solicitudes (solo dueño) ----
      if (p === '/api/studio/requests' && req.method === 'GET') {
        const { error } = await requireAdmin();
        if (error) return error;
        const estado = clean(u.searchParams.get('estado'), 30);
        const limit = Math.min(Math.max(parseInt(u.searchParams.get('limit') || '200', 10) || 200, 1), 500);
        let sql = 'SELECT * FROM requests';
        const args = [];
        if (estado) {
          if (!REQUEST_STATES.includes(estado)) return json({ error: 'Estado inválido' }, 400);
          sql += ' WHERE estado=?'; args.push(estado);
        }
        sql += ' ORDER BY created_at DESC LIMIT ?'; args.push(limit);
        return json({ items: await store.all(sql, args) });
      }
      const reqStatusMatch = p.match(/^\/api\/studio\/requests\/([^/]+)\/status$/);
      if (reqStatusMatch && req.method === 'POST') {
        const { error } = await requireAdmin();
        if (error) return error;
        const d = await req.json().catch(() => ({}));
        const estado = clean(d.estado, 30);
        if (!REQUEST_STATES.includes(estado)) return json({ error: 'Estado inválido. Usa: ' + REQUEST_STATES.join(', ') }, 400);
        const r = await store.run('UPDATE requests SET estado=? WHERE id=?', [estado, decodeURIComponent(reqStatusMatch[1])]);
        if (!r.affected) return json({ error: 'Solicitud no encontrada' }, 404);
        return json({ ok: true });
      }
      const reqDelMatch = p.match(/^\/api\/studio\/requests\/([^/]+)$/);
      if (reqDelMatch && req.method === 'DELETE') {
        const { error } = await requireAdmin();
        if (error) return error;
        const r = await store.run('DELETE FROM requests WHERE id=?', [decodeURIComponent(reqDelMatch[1])]);
        if (!r.affected) return json({ error: 'Solicitud no encontrada' }, 404);
        return json({ ok: true });
      }

      // ---- Studio: reseñas CRUD (solo dueño) ----
      if (p === '/api/studio/reviews' && req.method === 'GET') {
        const { error } = await requireAdmin();
        if (error) return error;
        const status = clean(u.searchParams.get('status'), 20);
        let sql = 'SELECT * FROM reviews';
        const args = [];
        if (status) {
          if (!REVIEW_STATES.includes(status)) return json({ error: 'Estado inválido' }, 400);
          sql += ' WHERE status=?'; args.push(status);
        }
        sql += ' ORDER BY created_at DESC LIMIT 200';
        return json({ items: await store.all(sql, args) });
      }
      if (p === '/api/studio/reviews' && req.method === 'POST') {
        const { error } = await requireAdmin();
        if (error) return error;
        const d = await req.json().catch(() => ({}));
        const v = validateReview(d);
        if (v.error) return json({ error: v.error }, 400);
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const code = clean(d.code, 20) || ('LR-' + String(Math.floor(100 + Math.random() * 900)));
        await store.run(
          'INSERT INTO reviews(id,title,place,category,summary,body,photo,video,rating,code,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [id, v.title, v.place, v.category, v.summary, v.body, v.photo, v.video, v.rating, code, v.status, now, now]);
        return json({ ok: true, id }, 201);
      }
      const studioReviewMatch = p.match(/^\/api\/studio\/reviews\/([^/]+)$/);
      if (studioReviewMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
        const { error } = await requireAdmin();
        if (error) return error;
        const id = decodeURIComponent(studioReviewMatch[1]);
        if (req.method === 'DELETE') {
          const r = await store.run('DELETE FROM reviews WHERE id=?', [id]);
          if (!r.affected) return json({ error: 'Reseña no encontrada' }, 404);
          return json({ ok: true });
        }
        const d = await req.json().catch(() => ({}));
        const v = validateReview(d);
        if (v.error) return json({ error: v.error }, 400);
        const now = new Date().toISOString();
        const r = await store.run(
          'UPDATE reviews SET title=?,place=?,category=?,summary=?,body=?,photo=?,video=?,rating=?,code=?,status=?,updated_at=? WHERE id=?',
          [v.title, v.place, v.category, v.summary, v.body, v.photo, v.video, v.rating, clean(d.code, 20) || null, v.status, now, id]);
        if (!r.affected) return json({ error: 'Reseña no encontrada' }, 404);
        return json({ ok: true });
      }

      // ---- Studio: métricas ----
      if (p === '/api/studio/stats' && req.method === 'GET') {
        const { error } = await requireAdmin();
        if (error) return error;
        const counts = {};
        for (const s of REQUEST_STATES) {
          const row = await store.one('SELECT COUNT(*) AS n FROM requests WHERE estado=?', [s]);
          counts[s] = row?.n ?? 0;
        }
        const pub = await store.one("SELECT COUNT(*) AS n FROM reviews WHERE status='publicado'");
        const draft = await store.one("SELECT COUNT(*) AS n FROM reviews WHERE status='borrador'");
        const totalReq = await store.one('SELECT COUNT(*) AS n FROM requests');
        return json({
          requests: { total: totalReq?.n ?? 0, byState: counts },
          reviews: { publicado: pub?.n ?? 0, borrador: draft?.n ?? 0 },
        });
      }

      return json({ error: 'Ruta no encontrada' }, 404);
    } catch (e) {
      const status = e.status || 500;
      return J({ error: status === 503 ? e.message : 'Error interno' }, status);
    }
  },
};

// Validación compartida de reseñas (crear y editar). Devuelve los campos
// limpios o { error }.
function validateReview(d) {
  const title = clean(d.title ?? d.nombre, 120);
  const place = clean(d.place ?? d.lugar ?? d.title, 120);
  const category = clean(d.category ?? d.categoria, 30);
  const summary = clean(d.summary ?? d.notas, 500);
  const body = clean(d.body ?? d.contenido, 5000);
  const photo = clean(d.photo, 500);
  const video = clean(d.video, 500);
  const status = clean(d.status ?? d.estado, 20) || 'borrador';
  let rating = d.rating === null || d.rating === undefined || d.rating === '' ? null : Math.floor(Number(d.rating));
  if (!title) return { error: 'El título es obligatorio' };
  if (!CATEGORIES.includes(category)) return { error: 'Categoría inválida. Usa: ' + CATEGORIES.join(', ') };
  if (!REVIEW_STATES.includes(status)) return { error: "Estado inválido. Usa 'borrador' o 'publicado'" };
  if (rating !== null && (rating < 1 || rating > 5)) return { error: 'La calificación debe ser de 1 a 5 (o vacía)' };
  if (photo && !/^https?:\/\//.test(photo)) return { error: 'La foto debe ser una URL https://' };
  if (video && !/^https?:\/\//.test(video)) return { error: 'El video debe ser una URL https://' };
  return { title, place, category, summary, body, photo: photo || null, video: video || null, rating, status };
}
