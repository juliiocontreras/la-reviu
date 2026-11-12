# La Reviú — Bitácora de experiencias

Historias, sabores y destinos que vale la pena descubrir: restaurantes, bares,
viajes y festivales. Un solo `index.html` + `logo-reviu.svg`.

## En vivo

- **Sitio:** https://la-reviu.pages.dev/ (Cloudflare Pages, proyecto `la-reviu`)
- **API:** https://la-reviu.juliiocontreras.workers.dev/api/health (Cloudflare Worker + D1)

## Cómo se publica

El repo es la fuente, pero el despliegue en vivo NO es automático todavía:
`git push` a `main` no redespliega Pages. Para publicar un cambio:

```sh
cp index.html logo-reviu.svg /tmp/la-reviu-deploy/
npx wrangler pages deploy /tmp/la-reviu-deploy --project-name la-reviu --commit-dirty=true
```

(Pendiente: conectar el proyecto de Pages al repo en el dashboard de
Cloudflare para que cada push a `main` despliegue solo, como
`redboy-dating-app`. GitHub Pages no está activado.)

## Backend (`worker/`)

Worker Cloudflare `la-reviu` + D1 `la-reviu`
(`e85f2197-22ce-4b98-9a7a-1d82302a9458`):

- `POST /api/requests` — guarda la solicitud y avisa a Julio por Resend
  (requiere el secreto `RESEND_API_KEY` en el Worker).
- `GET /api/reviews` — reseñas publicadas.
- `GET /api/auth/google/start` — Studio solo para el dueño
  (`juliiocontreras@gmail.com`); requiere `GOOGLE_CLIENT_ID` y
  `GOOGLE_CLIENT_SECRET` en el Worker y el redirect
  `https://la-reviu.juliiocontreras.workers.dev/api/auth/google/callback`
  en Google Cloud Console.
- `GET /api/studio/*` — CRUD de solicitudes y reseñas (solo dueño).

Despliegue del Worker: `python3 worker/deploy-worker.py` (ver `worker/README.md`).
El frontend guarda en `localStorage` solo como respaldo offline; la API es la
fuente cuando responde.

## Primera reseña real

No hay ninguna todavía: las tarjetas actuales son inspiración (Unsplash).
El modelo está en `reviews-schema.json` y lo que falta de Julio en
`PRIMERA-RESENA-PENDIENTE.md`. Cuando llegue el material, la reseña se crea
en Studio (pestaña Contenidos) con estado Publicado.

## Video del hero

El boarding pass del hero referencia `julio-reviu.mp4`, que **no está en el
repo**: Julio lo compartió en la sesión donde se construyó el sitio y nunca
llegó a git. El video tiene fallback elegante (poster + mensaje). Cuando
Julio lo vuelva a subir, guardarlo como `julio-reviu.mp4` (+ poster),
verificar que reproduce en vivo y pushearlo.

## Dominio

No hay dominio `lareviu` registrado. Ver `DOMINIO.md` (en la meta del
proyecto, no en este repo) para los valores DNS exactos cuando Julio elija
el nombre.
