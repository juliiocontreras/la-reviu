// Prueba local del Worker de La Reviú contra SQLite en memoria.
// Ejecutar: node worker/auth-flow.test.mjs  (Node 22+ con node:sqlite).
// Cubre el flujo completo de /admin: setup de primer uso, login, sesión,
// cambio de contraseña, y que Google OAuth ya no existe.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf-8'));

// Fake del binding D1 con la misma forma que usa worker.js
const DB = {
  prepare(sql) {
    const stmt = db.prepare(sql);
    return {
      bind(...args) {
        return {
          first: () => stmt.get(...args) ?? null,
          all: () => ({ results: stmt.all(...args) }),
          run: () => {
            const info = stmt.run(...args);
            return { meta: { changes: info.changes } };
          },
        };
      },
    };
  },
};

const worker = (await import('./worker.js')).default;
const env = { DB, ALLOWED_ORIGIN: 'https://la-reviu.pages.dev' };
const sha = s => createHash('sha256').update(s).digest('hex');

let cookie = '';
const call = async (path, opts = {}) => {
  const headers = { ...(opts.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const res = await worker.fetch(new Request('https://la-reviu.test' + path, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', ...headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }), env);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, setCookie };
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, JSON.stringify(extra)); }
};

const pwHash = sha('contrasena-de-prueba-123');

// 1. Salud: sin administrador todavía
let r = await call('/api/health');
check('health 200 + adminConfigured false', r.status === 200 && r.data.adminConfigured === false, r);
check('health sin googleConfigured', !('googleConfigured' in r.data), r.data);

// 2. Status: no configurado
r = await call('/api/auth/status');
check('status configured=false', r.status === 200 && r.data.configured === false, r);

// 3. Setup con usuario inválido -> 400
r = await call('/api/auth/setup', { method: 'POST', body: { username: 'ab', passwordHash: pwHash } });
check('setup usuario corto -> 400', r.status === 400, r);

// 4. Setup válido -> 201 + sesión
r = await call('/api/auth/setup', { method: 'POST', body: { username: 'Julio', passwordHash: pwHash } });
check('setup válido -> 201', r.status === 201 && r.data.username === 'julio', r);
check('setup emite cookie de sesión', !!r.setCookie && r.setCookie.startsWith('reviu_session='), r.setCookie);
const adminCookie = cookie;

// 5. Segundo setup -> 403 (desactivado para siempre)
cookie = '';
r = await call('/api/auth/setup', { method: 'POST', body: { username: 'otro', passwordHash: pwHash } });
check('segundo setup -> 403', r.status === 403, r);

// 6. Status ahora configurado
r = await call('/api/auth/status');
check('status configured=true', r.data.configured === true, r);

// 7. /api/studio/* sin sesión -> 401
r = await call('/api/studio/requests');
check('studio sin sesión -> 401', r.status === 401, r);

// 8. /api/auth/me con sesión -> admin
cookie = adminCookie;
r = await call('/api/auth/me');
check('me con sesión -> admin', r.status === 200 && r.data.user?.admin === true && r.data.user?.username === 'julio', r);

// 9. Studio con sesión -> 200
r = await call('/api/studio/requests');
check('studio con sesión -> 200 []', r.status === 200 && Array.isArray(r.data.items), r);

// 10. Login con contraseña incorrecta -> 401
cookie = '';
r = await call('/api/auth/login', { method: 'POST', body: { username: 'julio', passwordHash: sha('incorrecta-123') } });
check('login incorrecto -> 401', r.status === 401, r);

// 11. Login correcto -> 200 + cookie
r = await call('/api/auth/login', { method: 'POST', body: { username: 'julio', passwordHash: pwHash } });
check('login correcto -> 200', r.status === 200 && r.data.username === 'julio', r);
const loginCookie = cookie;

// 12. Cambio de contraseña con actual incorrecta -> 401
r = await call('/api/auth/change-password', { method: 'POST', body: { currentPasswordHash: sha('no-es-esta-123'), newPasswordHash: sha('nueva-contrasena-456') } });
check('change-password actual incorrecta -> 401', r.status === 401, r);

// 13. Cambio de contraseña correcto -> 200
r = await call('/api/auth/change-password', { method: 'POST', body: { currentPasswordHash: pwHash, newPasswordHash: sha('nueva-contrasena-456') } });
check('change-password correcto -> 200', r.status === 200, r);

// 14. La contraseña vieja ya no entra; la nueva sí
cookie = '';
r = await call('/api/auth/login', { method: 'POST', body: { username: 'julio', passwordHash: pwHash } });
check('login con contraseña vieja -> 401', r.status === 401, r);
r = await call('/api/auth/login', { method: 'POST', body: { username: 'julio', passwordHash: sha('nueva-contrasena-456') } });
check('login con contraseña nueva -> 200', r.status === 200, r);

// 15. Logout -> me null
r = await call('/api/auth/logout', { method: 'POST' });
check('logout -> 200', r.status === 200, r);
cookie = '';
r = await call('/api/auth/me');
check('me tras logout -> null', r.status === 200 && r.data.user === null, r);

// 16. Google OAuth eliminado
r = await call('/api/auth/google/start');
check('google/start -> 404', r.status === 404, r);
r = await call('/api/auth/google/callback?state=x&code=y');
check('google/callback -> 404', r.status === 404, r);

// 17. Regresión: solicitud pública y reseñas siguen funcionando
r = await call('/api/requests', { method: 'POST', body: { nombre: 'Prueba', contacto: 'prueba@example.com', lugar: 'Lugar de prueba', categoria: 'Bar', mensaje: 'Hola' } });
check('POST /api/requests -> 201', r.status === 201 && r.data.ok === true, r);
r = await call('/api/reviews');
check('GET /api/reviews -> 200 []', r.status === 200 && Array.isArray(r.data.items), r);

// 18. La sesión vieja del setup sigue válida tras el cambio de contraseña
cookie = loginCookie;
r = await call('/api/auth/me');
check('sesión de login sigue válida tras change-password', r.status === 200 && r.data.user?.admin === true, r);

console.log(`\n${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
