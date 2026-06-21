-- Shared backend schema for the Camp Utilities Tracker.
-- Records and categories live here so every device (mobile + desktop) reads
-- and writes the same data instead of an isolated per-device localStorage copy.

CREATE TABLE IF NOT EXISTS categories (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  unit       TEXT NOT NULL,
  icon       TEXT DEFAULT '📦',
  color      TEXT DEFAULT '#4361ee',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS records (
  id             SERIAL PRIMARY KEY,
  category_id    INTEGER,
  category_name  TEXT,
  quantity       DOUBLE PRECISION,
  unit           TEXT,
  supplier       TEXT,
  vehicle_number TEXT,
  delivery_date  TEXT,
  notes          TEXT,
  color          TEXT,
  icon           TEXT,
  has_image      BOOLEAN DEFAULT FALSE,
  recorded_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_records_recorded_at ON records (recorded_at DESC);

-- Seed the default categories once, server-side, so they are shared by all
-- devices and never duplicated by client-side seeding.
INSERT INTO categories (name, unit, icon, color)
SELECT * FROM (VALUES
  ('Fuel (Diesel)', 'Liters', '⛽', '#e63946'),
  ('Fuel (Petrol)', 'Liters', '🛢', '#f77f00'),
  ('Water',         'Liters', '💧', '#0077b6'),
  ('LPG',           'kg',     '🔥', '#f4a261'),
  ('Sewage',        'm3',     '🚽', '#6d6875'),
  ('Waste',         'kg',     '🗑', '#588157'),
  ('Electricity',   'kWh',    '⚡', '#ffd60a')
) AS seed(name, unit, icon, color)
WHERE NOT EXISTS (SELECT 1 FROM categories);
