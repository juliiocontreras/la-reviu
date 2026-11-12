// La Reviú — Cloudflare Worker (ES module)
// Backend real de la bitácora de Julio (juliiocontreras/la-reviu).
// Patrón tomado de TecnicosMX (~/workspace/tecnicosmx-rebuild/worker-turso.js
// y worker.js): Google OAuth con sesión por cookie, admin por correo,
// Resend para avisar al dueño. Diferencias con TecnicosMX:
//   - Almacén PREFERIDO: D1 (binding DB). Sin R2: las fotos/videos de las
//     reseñas son URLs externas (Unsplash, etc.), no se suben archivos.
//   - Fallback documentado: Turso por pipeline HTTP Hrana v2, mismo patrón
//     que TecnicosMX, activo solo si NO hay binding D1 y SÍ hay
//     TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.
//   - El frontend vive en GitHub Pages, NO embebido aquí: este Worker solo
//     sirve /api/*, por eso hay CORS (origen permitido por env).
//
// Bindings / variables de entorno:
//   DB (D1, preferido) | TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (fallback)
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (secretos)
//   RESEND_API_KEY (secreto; heredado del Worker de TecnicosMX solo si se
//   pone con `wrangler secret put` en ESTE Worker — nunca va en el código)
//   ALLOWED_ORIGIN (plain text, opcional; por defecto GitHub Pages de Julio)
//
// Admin: juliiocontreras@gmail.com (único usuario con acceso a Studio).
// Cualquier otro usuario Google autenticado recibe 403 en /api/studio/*.

const ADMIN_EMAIL = 'juliiocontreras@gmail.com';
const NOTIFY_TO = 'juliiocontreras@gmail.com';
const NOTIFY_FROM = 'La Reviú <noreply@tapmarketing.site>'; // Dominio verificado en Resend (plan: solo 3 dominios; la-reviu no cabe sin subir de plan)
const SESSION_COOKIE = 'reviu_session';
const OAUTH_STATE_COOKIE = 'reviu_oauth_state';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días, igual que TecnicosMX
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
        + '<p><a href="https://la-reviu.pages.dev/#studio">Abrir Studio</a></p>',
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
    const u = new URL(req.url), p = u.pathname, origin = u.origin;
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
      const getUser = async () => {
        const t = cookieVal(req, SESSION_COOKIE);
        if (!t) return null;
        return await store.one(
          'SELECT u.id,u.email,u.google_sub FROM auth_sessions s JOIN auth_users u ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?',
          [await sha(t), Date.now()]) || null;
      };
      const isAdmin = usr => !!usr && usr.email === ADMIN_EMAIL && !!usr.google_sub;
      const requireAdmin = async () => {
        const usr = await getUser();
        if (!usr) return { error: json({ error: 'Inicia sesión' }, 401) };
        if (!isAdmin(usr)) return { error: json({ error: 'Solo el dueño de La Reviú puede usar Studio' }, 403) };
        return { usr };
      };

      // ---- Salud ----
      if (p === '/api/health' && req.method === 'GET') {
        let storeOk = false;
        try { await store.one('SELECT 1 AS ok'); storeOk = true; } catch {}
        return json({
          ok: true, service: 'la-reviu-api', store: storeKind(env), storeOk,
          googleConfigured: !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET,
          resendConfigured: !!env.RESEND_API_KEY,
        });
      }

      // ---- Auth Google (igual que TecnicosMX; cookie reviu_session) ----
      if (p === '/api/auth/google/start' && req.method === 'GET') {
        if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ error: 'OAuth no configurado' }, 503);
        const state = rand(), redirect = origin + '/api/auth/google/callback';
        const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
        const r = new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/o/oauth2/v2/auth?' + q } });
        r.headers.append('set-cookie', OAUTH_STATE_COOKIE + '=' + state + '; Path=/api/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600');
        return r;
      }
      if (p === '/api/auth/google/callback' && req.method === 'GET') {
        const state = u.searchParams.get('state'), code = u.searchParams.get('code'), saved = cookieVal(req, OAUTH_STATE_COOKIE);
        if (!state || !code || state !== saved) return json({ error: 'OAuth state inválido' }, 403);
        const t = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: origin + '/api/auth/google/callback', grant_type: 'authorization_code', code }),
        });
        if (!t.ok) return json({ error: 'Google rechazó la autorización' }, 401);
        const token = await t.json();
        const g = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: 'Bearer ' + token.access_token } });
        if (!g.ok) return json({ error: 'No se verificó la identidad' }, 401);
        const id = await g.json();
        if (!id.email_verified || !id.sub || !id.email) return json({ error: 'Correo no verificado' }, 403);
        const email = id.email.toLowerCase();
        let row = await store.one('SELECT id,email,google_sub FROM auth_users WHERE google_sub=?', [id.sub]);
        if (!row) {
          const existing = await store.one('SELECT id,google_sub FROM auth_users WHERE email=?', [email]);
          if (existing?.google_sub && existing.google_sub !== id.sub) return json({ error: 'Cuenta vinculada a otro Google' }, 409);
          const uid = existing?.id || crypto.randomUUID();
          if (existing) await store.run('UPDATE auth_users SET google_sub=?,email_verified=1 WHERE id=?', [id.sub, uid]);
          else await store.run('INSERT INTO auth_users(id,email,password_hash,email_verified,google_sub,created_at) VALUES(?,?,NULL,1,?,?)', [uid, email, id.sub, new Date().toISOString()]);
          row = { id: uid, email };
        }
        const sid = rand();
        await store.run('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', [await sha(sid), row.id, Date.now() + SESSION_TTL_MS]);
        // Vuelve al frontend (GitHub Pages) en la sección Studio. Si el
        // Worker sirve el mismo origen, el hash basta; si no, el cliente
        // debe redirigir con ?studio=1 (ver api-client-snippet.js).
        const back = (env.ALLOWED_ORIGIN || 'https://la-reviu.pages.dev/la-reviu') + '/#studio';
        const r = new Response(null, { status: 302, headers: { location: back } });
        r.headers.append('set-cookie', SESSION_COOKIE + '=' + sid + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000));
        r.headers.append('set-cookie', OAUTH_STATE_COOKIE + '=; Path=/api/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
        return r;
      }
      if (p === '/api/auth/me' && req.method === 'GET') {
        const usr = await getUser();
        return json({ user: usr ? { id: usr.id, email: usr.email, admin: isAdmin(usr) } : null });
      }
      if (p === '/api/auth/logout' && req.method === 'POST') {
        const t = cookieVal(req, SESSION_COOKIE);
        if (t) await store.run('DELETE FROM auth_sessions WHERE token_hash=?', [await sha(t)]);
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
