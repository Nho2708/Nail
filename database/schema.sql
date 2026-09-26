-- =====================================================================
-- Nail Art Studio — PostgreSQL schema (tested on PostgreSQL 16/17, Neon)
-- Idempotent: the server runs this file on every start; re-running never
-- drops data. No sample data — the catalogue is entered in the admin panel.
-- =====================================================================

-- ---------- users & roles ----------
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(160) NOT NULL UNIQUE,
  password_hash VARCHAR(200) NOT NULL,
  full_name     VARCHAR(60)  NOT NULL,
  phone         VARCHAR(15),
  role          VARCHAR(10)  NOT NULL DEFAULT 'customer' CHECK (role IN ('admin', 'customer')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      CHAR(64)    PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_expires ON sessions (expires_at);

-- ---------- catalogue ----------
CREATE TABLE IF NOT EXISTS categories (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(40) NOT NULL,
  sort_order INTEGER     NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS colors (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(40) NOT NULL,
  hex        CHAR(7)     NOT NULL CHECK (hex ~ '^#[0-9A-Fa-f]{6}$'),
  finish     VARCHAR(10) NOT NULL DEFAULT 'gloss' CHECK (finish IN ('gloss', 'matte', 'chrome', 'cateye')),
  sort_order INTEGER     NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS services (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(80)  NOT NULL,
  description  VARCHAR(300),
  price_from   INTEGER      NOT NULL DEFAULT 0  CHECK (price_from >= 0),
  duration_min INTEGER      NOT NULL DEFAULT 60 CHECK (duration_min >= 0),
  image_url    VARCHAR(300),
  sort_order   INTEGER      NOT NULL DEFAULT 0,
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE
);
-- menu section heading a service is listed under, e.g. "Sơn gel", "Nối móng"
ALTER TABLE services ADD COLUMN IF NOT EXISTS group_name VARCHAR(40);

CREATE TABLE IF NOT EXISTS designs (
  id          SERIAL PRIMARY KEY,
  title       VARCHAR(80)  NOT NULL,
  description VARCHAR(500),
  image_url   VARCHAR(300) NOT NULL,
  thumb_url   VARCHAR(300),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  color_id    INTEGER REFERENCES colors(id)     ON DELETE SET NULL,
  price       INTEGER      NOT NULL DEFAULT 0 CHECK (price >= 0),
  is_featured BOOLEAN      NOT NULL DEFAULT FALSE,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  views       INTEGER      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------- bookings & consultation requests ----------
CREATE TABLE IF NOT EXISTS bookings (
  id            SERIAL PRIMARY KEY,
  kind          VARCHAR(10)  NOT NULL DEFAULT 'booking' CHECK (kind IN ('booking', 'consult')),
  user_id       INTEGER REFERENCES users(id)    ON DELETE SET NULL,
  full_name     VARCHAR(60)  NOT NULL,
  phone         VARCHAR(15)  NOT NULL,
  email         VARCHAR(160),
  booking_date  DATE,
  booking_time  CHAR(5),
  service_id    INTEGER REFERENCES services(id) ON DELETE SET NULL,
  design_id     INTEGER REFERENCES designs(id)  ON DELETE SET NULL,
  color_id      INTEGER REFERENCES colors(id)   ON DELETE SET NULL,
  custom_color  CHAR(7),
  note          VARCHAR(500),
  status        VARCHAR(10)  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'done', 'cancelled')),
  notify_result VARCHAR(1000),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ck_bookings_schedule CHECK (kind = 'consult' OR (booking_date IS NOT NULL AND booking_time IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_bookings_slot ON bookings (booking_date, booking_time);
CREATE INDEX IF NOT EXISTS ix_bookings_user ON bookings (user_id);

-- ---------- visit analytics ----------
CREATE TABLE IF NOT EXISTS visits (
  id         BIGSERIAL PRIMARY KEY,
  visitor_id VARCHAR(64)  NOT NULL,
  path       VARCHAR(200) NOT NULL,
  referrer   VARCHAR(300),
  device     VARCHAR(10),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_visits_created ON visits (created_at);

-- ---------- theme & notification settings (key → JSON value) ----------
CREATE TABLE IF NOT EXISTS settings (
  setting_key   VARCHAR(60) PRIMARY KEY,
  setting_value TEXT        NOT NULL
);

-- ---------- uploaded images (kept in the DB so free hosts without a disk keep them) ----------
CREATE TABLE IF NOT EXISTS images (
  id           VARCHAR(48) PRIMARY KEY,   -- file name, e.g. "k3j9…a1.webp"; served at /img/<id>
  content_type VARCHAR(40) NOT NULL,
  data         BYTEA       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
