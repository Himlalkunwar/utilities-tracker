// Shared admin-role helpers for the Camp Utilities Tracker.
//
// The app has exactly two roles:
//   • Admin — can add, edit and delete records and categories.
//   • User  — can view and add records only.
//
// The role is enforced server-side (not just hidden in the UI) so it cannot be
// bypassed from another device. A single admin credential lives in the shared
// `app_settings` table, so the same login works on every device.
import { getDatabase } from "@netlify/database";

type DB = ReturnType<typeof getDatabase>;

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time-ish string comparison to avoid trivially leaking via timing.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function getSettings(db: DB): Promise<Record<string, string>> {
  const rows = (await db.sql`SELECT key, value FROM app_settings`) as any[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

async function setSetting(db: DB, key: string, value: string): Promise<void> {
  await db.sql`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (${key}, ${value}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()`;
}

// Has an admin password been configured yet?
export async function isConfigured(db: DB): Promise<boolean> {
  const s = await getSettings(db);
  return !!s.admin_hash;
}

// The opaque session token handed to a device after a successful login.
// Deterministic (so it survives function cold starts) but unguessable without
// the server secret.
async function tokenFor(secret: string, hash: string): Promise<string> {
  return sha256Hex(secret + ":" + hash);
}

// First-time setup: store the admin credential. Rejected once configured.
export async function setupAdmin(db: DB, password: string): Promise<string | null> {
  if (await isConfigured(db)) return null;
  const salt = crypto.randomUUID() + crypto.randomUUID();
  const secret = crypto.randomUUID() + crypto.randomUUID();
  const hash = await sha256Hex(salt + ":" + password);
  await setSetting(db, "admin_salt", salt);
  await setSetting(db, "admin_secret", secret);
  await setSetting(db, "admin_hash", hash);
  return tokenFor(secret, hash);
}

// Verify a password and, on success, return a fresh session token.
export async function loginAdmin(db: DB, password: string): Promise<string | null> {
  const s = await getSettings(db);
  if (!s.admin_hash || !s.admin_salt || !s.admin_secret) return null;
  const hash = await sha256Hex(s.admin_salt + ":" + password);
  if (!safeEqual(hash, s.admin_hash)) return null;
  return tokenFor(s.admin_secret, s.admin_hash);
}

// Change the admin password (caller must already be an admin). Returns a new
// token because the token is derived from the password hash.
export async function changeAdminPassword(
  db: DB,
  newPassword: string,
): Promise<string | null> {
  const s = await getSettings(db);
  if (!s.admin_salt || !s.admin_secret) return null;
  const hash = await sha256Hex(s.admin_salt + ":" + newPassword);
  await setSetting(db, "admin_hash", hash);
  return tokenFor(s.admin_secret, hash);
}

function bearer(req: Request): string {
  const h = req.headers.get("authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

// Is the caller a valid admin for this request?
export async function isAdmin(db: DB, req: Request): Promise<boolean> {
  const token = bearer(req);
  if (!token) return false;
  const s = await getSettings(db);
  if (!s.admin_hash || !s.admin_secret) return false;
  const expected = await tokenFor(s.admin_secret, s.admin_hash);
  return safeEqual(token, expected);
}

// Gate a mutating handler. Returns a 401/403 Response when the caller is not an
// admin, or null when the request may proceed.
export async function requireAdmin(db: DB, req: Request): Promise<Response | null> {
  if (await isAdmin(db, req)) return null;
  if (!(await isConfigured(db))) {
    return new Response(
      JSON.stringify({ error: "Admin account not set up yet." }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response(
    JSON.stringify({ error: "Admin sign-in required for this action." }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}
