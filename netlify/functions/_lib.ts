import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appConfig } from "../../db/schema.js";

// ── Password hashing (scrypt, no external deps) ──────────────────────
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const dk = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${dk}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, dk] = (stored || "").split(":");
  if (!salt || !dk) return false;
  const expected = Buffer.from(dk, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ── Server-only config (key/value) ───────────────────────────────────
export async function getConfig(key: string): Promise<string | null> {
  const [row] = await db.select().from(appConfig).where(eq(appConfig.key, key));
  return row ? row.value : null;
}

export async function setConfig(key: string, value: string): Promise<void> {
  await db
    .insert(appConfig)
    .values({ key, value })
    .onConflictDoUpdate({ target: appConfig.key, set: { value } });
}

// Session-signing secret, generated once and stored server-side.
async function getSecret(): Promise<string> {
  let s = await getConfig("session_secret");
  if (!s) {
    s = randomBytes(32).toString("hex");
    await db
      .insert(appConfig)
      .values({ key: "session_secret", value: s })
      .onConflictDoNothing();
    s = (await getConfig("session_secret")) || s;
  }
  return s;
}

// ── Signed session tokens (HMAC over a base64url JSON payload) ────────
const encode = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString("base64url");

export async function signToken(payload: Record<string, unknown>): Promise<string> {
  const secret = await getSecret();
  const body = encode(payload);
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export async function verifyToken(token?: string | null): Promise<any | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const secret = await getSecret();
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export async function requireAuth(req: Request): Promise<any | null> {
  return verifyToken(bearer(req));
}

export const json = (data: unknown, status = 200) =>
  Response.json(data, { status });
