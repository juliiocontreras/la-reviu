# La Reviú — Backend (Cloudflare Worker + D1)

Backend real para la bitácora de Julio (`juliiocontreras/la-reviu`).
Patrón tomado de TecnicosMX (`~/workspace/tecnicosmx-rebuild/worker-turso.js`
y `worker.js`): sesión por cookie y aviso por Resend. Diferencia clave:
**sin Google OAuth**: el acceso de administrador es solo usuario +
contraseña (uso interno, solo Julio), creado por él mismo en `/admin`
(setup de primer uso). El frontend sigue en Pages (`index.html`, que este
Worker NO toca ni sirve): el Worker solo expone `/api/*` y el navegador lo
llama desde otro origen, por eso hay CORS.

## Archivos

| Archivo | Qué es |
|---|---|
| `worker.js` | Worker ES module: API pública + auth usuario/contraseña + Studio (admin) |
| `schema.sql` | Tablas `requests`, `reviews`, `admin_users`, `admin_sessions` (D1/SQLite, válido también en Turso) |
| `auth-flow.test.mjs` | Prueba local del flujo de auth (setup/login/logout/cambio de contraseña) contra SQLite en memoria: `node worker/auth-flow.test.mjs` (24 checks) |
| `wrangler.toml` | Config de deploy (D1 + `ALLOWED_ORIGIN`; secretos fuera del archivo) |
| `cf_deploy.py` | Deploy por API de Cloudflare (patrón TecnicosMX). **Sin ejecutar aún** |
| `api-client-snippet.js` | Funciones fetch para pegar en `index.html`: solicitudes, reseñas públicas y CRUD de Studio, con respaldo offline en `localStorage` |

## Endpoints

Públicos:

- `GET /api/health` → `{ ok, service, store: 'd1'|'turso'|'none', storeOk, adminConfigured, resendConfigured }`
- `POST /api/requests` `{ nombre, contacto, lugar, categoria, mensaje }` → valida los 5 campos, guarda la solicitud y avisa a Julio por correo. Si Resend falla o no está configurado, la solicitud **queda guardada igual** y la respuesta trae `emailSent: false` + `emailError`.
- `GET /api/reviews?categoria=&limit=` → solo reseñas con `status='publicado'`, más recientes primero.
- `GET /api/reviews/:id` → una reseña publicada.

Auth (usuario + contraseña, solo `/admin`, sin Google):

- `GET /api/auth/status` → `{ configured, authenticated, username }`
- `POST /api/auth/setup` `{ username, passwordHash }` → crea el acceso de
  administrador **solo si aún no existe** (si ya existe: 403). El cliente
  envía `passwordHash` = SHA-256 hex de la contraseña; el servidor guarda
  SHA-256 de ese hash. La contraseña en claro nunca viaja ni se guarda.
  Al crear el acceso también inicia sesión (cookie).
- `POST /api/auth/login` `{ username, passwordHash }` → sesión en cookie
  `reviu_session` (HttpOnly, Secure, 7 días). Credenciales incorrectas: 401.
- `GET /api/auth/me` → `{ user: { username, admin: true } | null }`
- `POST /api/auth/change-password` `{ currentPasswordHash, newPasswordHash }`
  (con sesión; cierra las demás sesiones del administrador)
- `POST /api/auth/logout` → borra la sesión y la cookie.

Studio — solo el administrador con sesión (sin sesión: **401**):

- `GET /api/studio/requests?estado=` · `POST /api/studio/requests/:id/status` `{ estado }` · `DELETE /api/studio/requests/:id`
- `GET /api/studio/reviews?status=` · `POST /api/studio/reviews` · `PUT /api/studio/reviews/:id` · `DELETE /api/studio/reviews/:id`
- `GET /api/studio/stats` → conteos de solicitudes por estado y de reseñas borrador/publicado.

Validación: categorías `Restaurante, Bar, Turismo, Festival, Viaje, Otro` (las mismas de `index.html`); estados de solicitud `Pendiente, En contacto, En producción, Publicado, Cerrado`; estados de reseña `borrador, publicado`. Las fotos/videos de reseñas son URLs `https://` externas: La Reviú no sube archivos (no hay R2).

## Viabilidad D1 (verificado 2026-11-11)

**Sí, viable.** El token de Cloudflare registrado tiene el permiso `#d1:edit` y la lectura `GET /accounts/0e75afd1ae301052497d802bf284ee23/d1/database` devolvió `success: true` con 4 bases existentes (`ribbon-catalog`, `tecnicosmx`, `shinext-operations`, `idg-office-rent`). Ninguna se llama `la-reviu`: hay que crearla (paso 1). No se creó en esta tarea porque el despliegue no estaba autorizado.

## Turso como fallback

No hay credenciales Turso reutilizables para La Reviú: en `~/workspace/tecnicosmx-rebuild/` solo existe la URL de la base **de TecnicosMX** y el token solo como binding `inherit` en `cf_deploy_turso.py` (el valor vive como secreto del Worker `tecnicosmx-staging`, no hay ningún archivo `.env` ni `~/.turso` con el valor). Reutilizar esa base mezclaría los datos de dos proyectos. El Worker incluye de todos modos el adaptador Turso (pipeline Hrana v2, mismo código que TecnicosMX): si algún día D1 falla, basta con crear una base Turso nueva llamada `la-reviu`, poner `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` como secretos y **quitar** el binding D1; el Worker detecta el almacén solo (`store: 'd1'` o `'turso'` en `/api/health`).

## Despliegue (pasos que faltan — nada desplegado aún)

1. **Crear la base D1** (depende de permisos de Cloudflare, ya verificados; lo puede hacer el agente con el helper):
   ```bash
   python3 ~/workspace/custom-connectors/custom.cloudflare/bin/cloudflare.py api-get --path /accounts/0e75afd1ae301052497d802bf284ee23/d1/database
   # Crear: POST /accounts/<id>/d1/database {"name":"la-reviu"}  (o `wrangler d1 create la-reviu`)
   # Anotar el UUID que devuelve y ponerlo en wrangler.toml y cf_deploy.py (D1_ID).
   ```
2. **Aplicar el esquema**: `wrangler d1 execute la-reviu --file=schema.sql` (o la API `POST /d1/database/<id>/query` por sentencias, como `cf_migrate.py` de TecnicosMX). El esquema es idempotente: al re-ejecutarlo solo añade las tablas nuevas (`admin_users`, `admin_sessions`).
3. **Secretos en el Worker nuevo** (depende de quien tenga acceso a las consolas; los valores **no** están en este repo):
   - `RESEND_API_KEY`: la misma clave que ya usa TecnicosMX (dominio remitente `noreply@tapmarketing.site`, verificado en Resend).
   - Sin secretos de Google: el acceso de administrador lo crea Julio mismo
     en `/admin` (setup de primer uso); no hay claves OAuth que configurar.
   - Ponerlos con `wrangler secret put <NOMBRE>` **antes** del primer deploy: en un Worker nuevo los bindings `inherit` de `cf_deploy.py` no tienen nada que heredar.
4. **Desplegar**: `python3 cf_deploy.py` (o `wrangler deploy`) y verificar `GET /api/health` en el subdominio del Worker.
5. **Activar GitHub Pages** en el repo `juliiocontreras/la-reviu` (hoy da 404) para que `ALLOWED_ORIGIN` apunte al sitio real; si cambia la URL del frontend, actualizar `ALLOWED_ORIGIN`.
6. **Conectar el frontend**: el agente que edita `index.html` pega `api-client-snippet.js` (poner la URL real del Worker en `REVIU_API_BASE`) y conecta el formulario, las tarjetas y el Studio. El formulario actual marca la solicitud como "demo local": al conectarlo, ese texto debe cambiar. Nota: el `mensaje` del formulario hoy no es obligatorio en el HTML; el Worker lo exige (mín. 1 carácter) — al conectar, marcarlo `required`.

## Correos

- Aviso de solicitud nueva: de `La Reviú <noreply@tapmarketing.site>` a `juliiocontreras@gmail.com` vía Resend (`RESEND_API_KEY` por entorno, nunca en el código). **No se envió ningún correo de prueba real en esta tarea.**
- El remitente usa `tapmarketing.site` porque el plan de Resend solo permite 3 dominios verificados y ya están ocupados (`tapmarketing.site`, `redboy.gay`, `jobia.site`); mismo motivo que en TecnicosMX.

## Qué quedó bloqueado

- **Nada de código**: el Worker, el esquema, el snippet y el script de deploy están listos y validados en local (ver abajo).
- **Despliegue**: no autorizado en esta tarea. Falta crear la D1 `la-reviu`, poner los 3 secretos, añadir el redirect de Google y desplegar (pasos 1–4).
- **Google OAuth**: eliminado en la reestructura 2026-11-12. El acceso es
  solo usuario + contraseña en `/admin`; no hay redirect que añadir en
  Google Cloud Console ni claves OAuth que configurar.
- **GitHub Pages**: hoy 404; sin él no hay origen público al que apuntar `ALLOWED_ORIGIN` (el Worker funcionaría igual en su subdominio `workers.dev`).

## Validación local (2026-11-11)

- `node --check worker.js` y `node --check api-client-snippet.js`: sintaxis OK.
- `schema.sql` ejecutado en SQLite local: crea las 4 tablas + índices sin errores; inserción de prueba de solicitud y reseña OK (base desechable, no se guarda).
- `node worker/auth-flow.test.mjs`: 24 checks PASS (setup de primer uso y su
  bloqueo tras el primer uso, login correcto/incorrecto, sesión y Studio
  401/200, cambio de contraseña, logout, Google OAuth 404, regresión de
  solicitudes y reseñas públicas).
- Sin despliegue real y sin correos enviados: `/api/health` en vivo queda pendiente del paso 4.
