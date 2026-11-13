# La Reviú — Bitácora de experiencias

Historias, sabores y destinos que vale la pena descubrir: restaurantes, bares,
viajes y festivales. Un solo `index.html` + `logo-reviu.svg`.

## En vivo

- **Sitio:** https://la-reviu.pages.dev/ (Cloudflare Pages, proyecto `la-reviu`)
- **Panel de administración:** https://la-reviu.pages.dev/admin (solo Julio)
- **API:** https://la-reviu.juliiocontreras.workers.dev/api/health (Cloudflare Worker + D1)

## Estructura del sitio

Navegación superior con 4 pestañas: **Portada**, **Revius**, **Tienda**,
**Solicita** (la pestaña dice solo "Solicita"; la sección se sigue llamando
"Solicita una Reviú").

- **Revius** es una sola pestaña que integra tres sub-secciones con
  sub-navegación interna: **Reseñas** (buscador + filtros por categoría,
  alimentadas de `GET /api/reviews`), **Lugares** (índice real por categoría)
  y **Lives** (qué sigue + estado cuando no hay live programado).
- **Tienda:** merch en preparación, sin catálogo fingido. Incluye un
  formulario "Avísame cuando haya merch" (nombre + contacto) que guarda un
  aviso en la API como solicitud con `[AVISO MERCH]`, para que Julio sepa
  a quién avisar cuando las piezas estén listas.
- **Solicita una reviú:** formulario que guarda en la API (con respaldo
  offline en `localStorage`) y muestra seguimiento ("Tus solicitudes").

## Upgrade 4.0 (todo el sitio, 2026-11-12)

- **Diseño:** pie con navegación rápida (Portada · Revius · Tienda ·
  Solicita), compartir y Facebook; jerarquía y estados pulidos en todas las
  secciones; misma marca (amarillo #ffd02a, tinta, papel, boletos).
- **Contenido y secciones:** Lives y Tienda ya no son callejones sin salida:
  cada una tiene un formulario de aviso ("Avísame del próximo live" /
  "Avísame cuando haya merch") que reutiliza `POST /api/requests` con
  `[AVISO LIVE]` / `[AVISO MERCH]` en el mensaje. Sin fechas ni lives
  inventados: si no hay live programado, se dice así y se ofrece el aviso.
- **Funciones:** SEO (canonical, Open Graph, Twitter Card, JSON-LD
  WebSite/Organization con datos reales), rendimiento (preload del póster
  del hero, preconnect a la API y a Unsplash), compartir real (Web Share
  API con respaldo de copiar enlace) en el hero, en cada reseña publicada
  y en el pie, accesibilidad (`aria-current` en pestaña y sub-navegación
  activas), y PWA (`site.webmanifest` + iconos 192/512 PNG generados del
  logo oficial + `apple-touch-icon` 180).
- **Pestaña del menú:** "Solicita una reviú" se acortó a solo "Solicita"
  (pedido de Julio 2026-11-12 19:19 CST; solo el menú, la sección y los
  botones conservan el nombre completo).

## Panel de administración (`/admin`)

El panel (lugares, solicitudes, contenidos, colaboraciones, métricas) **no
está en el menú**: solo se activa cuando la URL es `/admin` (o `#admin`
como respaldo). Fuera de `/admin` el panel ni siquiera está en el DOM: ni
pestaña, ni enlace, ni botón visible.

Acceso solo con **usuario + contraseña** (uso interno, solo Julio; sin
Google OAuth):

1. Entra a https://la-reviu.pages.dev/admin.
2. **Primer uso:** la página muestra "Crea tu acceso de administrador".
   Julio elige su usuario y su contraseña ahí mismo. La contraseña se cifra
   en el navegador (SHA-256) antes de enviarse y nunca se guarda en claro;
   el servidor guarda SHA-256 de ese hash en D1. El setup solo funciona una
   vez: si ya existe administrador, queda desactivado para siempre.
3. **Después:** la página pide usuario + contraseña. La sesión dura 7 días
   (cookie httpOnly). La contraseña se cambia desde el propio panel, con la
   sesión iniciada.
4. La contraseña la crea Julio mismo; nunca se inventa ni se pide por chat.

Endpoints (ver `worker/README.md`): `GET /api/auth/status`,
`POST /api/auth/setup`, `POST /api/auth/login`, `GET /api/auth/me`,
`POST /api/auth/change-password`, `POST /api/auth/logout`.

## Cómo se publica

El repo es la fuente, pero el despliegue en vivo NO es automático todavía:
`git push` a `main` no redespliega Pages. Para publicar un cambio:

```sh
python3 ~/workspace/la-reviu-deploy.py
```
El script copia `index.html`, `logo-reviu.svg`, `julio-reviu.mp4`,
`julio-reviu.webp`, `julio-reviu.webm`, `site.webmanifest` e iconos a un
directorio de staging y despliega con
`npx wrangler pages deploy <dir> --project-name la-reviu --commit-dirty=true`.

(El token va por surrogate con la credencial `custom.cloudflare`; la API
directa de manifest falla porque wrangler usa hashes BLAKE3, no SHA-256.
Pendiente: conectar el proyecto de Pages al repo en el dashboard de
Cloudflare para que cada push a `main` despliegue solo, como
`redboy-dating-app`. GitHub Pages no está activado.)

## Backend (`worker/`)

Worker Cloudflare `la-reviu` + D1 `la-reviu`
(`e85f2197-22ce-4b98-9a7a-1d82302a9458`):

- `POST /api/requests` — guarda la solicitud y avisa a Julio por Resend
  (requiere el secreto `RESEND_API_KEY` en el Worker; sin él, la solicitud
  se guarda igual y el aviso queda pendiente).
- `GET /api/reviews` — reseñas publicadas.
- `GET /api/auth/*` — acceso de administrador (usuario + contraseña, ver
  arriba). Sin Google OAuth.
- `GET /api/studio/*` — CRUD de solicitudes y reseñas (solo con sesión de
  administrador; sin sesión: 401).

Despliegue del Worker: `python3 worker/deploy-worker.py` (ver
`worker/README.md`). Migraciones D1: `wrangler d1 execute la-reviu
--file=worker/schema.sql` (idempotente; añade solo lo que falte).
Prueba local del flujo de auth: `node worker/auth-flow.test.mjs`
(24 checks PASS).

El frontend guarda en `localStorage` solo como respaldo offline; la API es la
fuente cuando responde.

## Primera reseña real

No hay ninguna todavía: las tarjetas actuales son inspiración (Unsplash).
El modelo está en `reviews-schema.json` y lo que falta de Julio en
`PRIMERA-RESENA-PENDIENTE.md`. Cuando llegue el material, la reseña se crea
en `/admin` (Contenidos) con estado Publicado.

## Video del hero

El boarding pass del hero usa `julio-reviu.mp4` (10 s, 720x1080, video de
Julio en sesión de fotos), con poster local `julio-reviu.webp` y respaldo
`julio-reviu.webm` (VP9, para navegadores sin códec h264). Está en el
repo desde el commit 29097f2 y verificado en vivo 2026-11-11 23:27 CST
(`/julio-reviu.mp4` → 200 video/mp4, 722,404 B exactos). El video tiene
fallback elegante (poster + mensaje) si no carga.

## Reglas de diseño (de Julio)

- **Títulos y textos siempre en negro/tinta (#1c1b19), nunca azul.**
  Regla general desde 2026-11-11 23:28 CST, no solo de este sitio. El único
  azul que había era el outline de focus `#276d89`, cambiado a tinta; los
  fondos azulados (`#d6eaf0`, `#e5eef1`) y el confeti azul (`#9dd9e2`) se
  pasaron a tonos cálidos de la misma paleta. Los enlaces heredan el color
  (`a{color:inherit}`), nunca el azul por defecto del navegador.
- **Sin barras de desplazamiento visibles en ningún lado** (regla general):
  el scroll sigue funcionando, solo se oculta la barra.
- **Sin emojis como iconografía** (regla global desde 2026-11-11): los
  iconos son SVG de línea (estilo Feather, clase `.ic`); nunca emojis en
  lugar de iconos. Excepciones: reacciones y contenido de usuarios, y las
  flechas tipográficas (↗ → ↓) y la ✕ de cerrar. Verificación con grep de
  los rangos U+1F000–U+1FAFF y U+2600–U+27BF antes de entregar.

## Dominio

No hay dominio `lareviu` registrado: Julio lo compra después. Ver
`DOMINIO.md` (en la meta del proyecto, no en este repo) para los valores DNS
exactos cuando elija el nombre. El panel de administración seguirá siendo
`/admin` sobre el dominio que elija.
