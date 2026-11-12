# Primera reseña real de La Reviú — PENDIENTE

**Estado (2026-11-11): NO hay primera reseña publicable.** No se encontró material
verificable suficiente. No se inventó ningún lugar, visita ni opinión.

## Qué se investigó

1. **Enlace de Facebook del sitio** — https://www.facebook.com/share/17upptsN2F/?mibextid=wwXIfr
   Resuelve al perfil personal de Julio Contreras (@JuliioContrerasMX, cuenta
   profesional, 153,115 seguidores). La lectura de la página solo devuelve el
   perfil; **no se pudo ver ningún post concreto** sobre un restaurante, bar,
   viaje o festival. No hay texto citable ni foto aprovechable desde ahí.
2. **Búsquedas web en español** — "La Reviú", "La Reviu Julio", "La Reviu
   Saltillo", "Julio Contreras Saltillo restaurante reseña video Facebook",
   "juliiocontreras la-reviu github pages". Ningún resultado habla de La Reviú
   como bitácora ni de una reseña de Julio. Los resultados de comida en
   Saltillo son de **otros creadores** (Donde ir Saltillo, El Blog del Gordo,
   La Panza es Primero, Ando Hambriento, etc.) y **no se pueden atribuir a
   Julio ni a La Reviú**.
3. **TikTok @lareviu** — https://www.tiktok.com/@lareviu/video/7594822293612760342
   Existe una cuenta "LaReviu" (bio: "🔎 Lo encuentro, lo pruebo y te lo
   cuento"). Su video más visible es una **publicidad pagada de un proyector
   portátil XGIMI Vibe One** (publicado 2026-01-13, 2.7 M de reproducciones,
   247,000 likes), no una experiencia de lugar. Además **no está verificado
   que esa cuenta sea de Julio**. Por ambas razones no sirve como primera
   reseña de la bitácora.
4. **Repo local** — `~/workspace/la-reviu/` solo contiene `index.html` y
   `logo-reviu.svg`. Confirmado: las 3 tarjetas ("Sabores por descubrir" /
   "Una noche diferente" / "Rumbo a otra historia") son **inspiración con
   fotos de Unsplash**, repetidas en Portada, Reseñas y Destinos. La propia
   sección Reseñas lo advierte: *"Las tarjetas de inspiración son ejemplos
   visuales, no reseñas verificadas."* El video `julio-reviu.mp4` referenciado
   en la portada **no está en el repo** y tampoco está `/sdk.js`.

## Lo que Julio debe enviar (lista exacta)

Para publicar la primera reseña real, Julio debe enviar **todo** lo siguiente.
Nada de esto existe hoy en forma verificable:

1. **Nombre del lugar** — nombre exacto como se anuncia (y ciudad, ej. Saltillo).
2. **Categoría** — Restaurante, Bar, Turismo, Festival o Viaje.
3. **Fecha de la visita** — día real en que fue (AAAA-MM-DD).
4. **Qué probó / qué destacó** — platos, bebidas o actividades concretas, con
   su opinión real: qué le gustó y qué no.
5. **Calificación** — del 1 al 5 (puede usar .5).
6. **Fotos y/o video reales de la visita** — archivos tomados por Julio en el
   lugar (no fotos de stock ni de otros creadores). Indicar cuál es la foto
   principal.
7. **Dirección o referencia para llegar** (opcional, solo si Julio la confirma).
8. **Precio aproximado por persona en MXN** (opcional, solo si Julio lo confirma).
9. **Enlace al post original** (opcional) — si ya lo publicó en su Facebook
   (@JuliioContrerasMX) o TikTok, pasar la URL del post para citar la fuente.

## Cómo se publicará cuando llegue el material

1. Se crea un registro real en `reviews-schema.json` (con `id` LR-2026-001,
   `estado: "borrador"`, y todos los campos con datos reales, no "PENDIENTE").
2. Se borra el registro `LR-0000-PLANTILLA` de ese mismo archivo.
3. Las fotos/video se guardan en el repo (carpetas `fotos/` y `videos/`).
4. Julio aprueba el texto final y el estado pasa a `"publicado"`.
5. Solo entonces el otro agente (único escritor de `index.html`) sustituye
   las tarjetas placeholder por la reseña real.

## Archivos de este trabajo

- `reviews-schema.json` — modelo de datos + 1 registro PLANTILLA VACÍA.
- `PRIMERA-RESENA-PENDIENTE.md` — este archivo.

**Prohibido:** inventar visitas, lugares, platos, opiniones, fotos o fechas.
Sin el material de Julio, la primera reseña sigue pendiente.
