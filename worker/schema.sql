-- La Reviú — esquema D1 (SQLite). Compatible también con Turso/libSQL.
-- Aplicar con: wrangler d1 execute la-reviu --file=schema.sql
-- (o con la API REST de Cloudflare: POST /accounts/{id}/d1/database/{db}/query)
-- Idempotente: se puede ejecutar más de una vez sin duplicar nada.

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  contacto TEXT NOT NULL,
  lugar TEXT NOT NULL,
  categoria TEXT NOT NULL CHECK (categoria IN ('Restaurante','Bar','Turismo','Festival','Viaje','Otro')),
  mensaje TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'Pendiente'
    CHECK (estado IN ('Pendiente','En contacto','En producción','Publicado','Cerrado')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_requests_estado ON requests(estado);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at DESC);

-- Reseñas editoriales. Solo status='publicado' se sirve en GET /api/reviews.
-- photo/video son URLs externas (Unsplash, etc.): La Reviú NO sube archivos
-- (a diferencia de TecnicosMX, que usa R2). code es el código del boleto
-- (p. ej. FOOD-01) que muestra el frontend.
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  place TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL CHECK (category IN ('Restaurante','Bar','Turismo','Festival','Viaje','Otro')),
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  photo TEXT,
  video TEXT,
  rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  code TEXT,
  status TEXT NOT NULL DEFAULT 'borrador' CHECK (status IN ('borrador','publicado')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_category ON reviews(category);

-- Auth Google (mismo modelo que TecnicosMX: sin contraseña, solo Google).
CREATE TABLE IF NOT EXISTS auth_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  google_sub TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
