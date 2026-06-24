-- App-level settings shared by every device (mobile + desktop).
-- Used to store the single admin credential so that the Admin vs User role
-- distinction is enforced server-side and stays consistent across devices,
-- rather than being a per-device flag that could be bypassed.
--
-- Keys used by the app:
--   admin_salt   random salt for the password hash
--   admin_hash   sha256(admin_salt + ':' + password)
--   admin_secret random server secret used to derive opaque session tokens
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
