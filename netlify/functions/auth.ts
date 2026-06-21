import type { Config } from "@netlify/functions";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users } from "../../db/schema.js";
import {
  hashPassword,
  verifyPassword,
  signToken,
  requireAuth,
  getConfig,
  setConfig,
  json,
} from "./_lib.js";

const TOKEN_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

async function userCount(): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users);
  return rows.length;
}

// Non-sensitive status shared with the client. The API key itself is never
// returned — only whether one has been configured.
async function publicStatus(principal: any) {
  const model = (await getConfig("model")) || DEFAULT_MODEL;
  const hasKey = !!(await getConfig("api_key"));
  return {
    model,
    hasKey,
    role: principal?.role || null,
    username: principal?.username || null,
  };
}

export default async (req: Request) => {
  // GET → current status (used on boot to decide login vs. setup vs. app).
  if (req.method === "GET") {
    const setup = (await userCount()) === 0;
    const principal = await requireAuth(req);
    return json({ authenticated: !!principal, setup, ...(await publicStatus(principal)) });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* ignore */
  }
  const action = body.action;

  // ── Login ──────────────────────────────────────────────────────────
  if (action === "login") {
    const username = String(body.username || "").toLowerCase().trim();
    const password = String(body.password || "");
    if (!username || !password)
      return json({ error: "Username and password required" }, 400);
    const [u] = await db.select().from(users).where(eq(users.username, username));
    if (!u || !verifyPassword(password, u.passwordHash))
      return json({ error: "Invalid username or password" }, 401);
    const token = await signToken({ username: u.username, role: u.role, exp: Date.now() + TOKEN_TTL });
    return json({ token, ...(await publicStatus(u)) });
  }

  // ── First-run admin registration (only when no users exist) ────────
  if (action === "register") {
    if ((await userCount()) !== 0)
      return json({ error: "Setup already complete" }, 403);
    const username = String(body.username || "").toLowerCase().trim();
    const password = String(body.password || "");
    if (!username || password.length < 6)
      return json({ error: "Username and a password of at least 6 characters are required" }, 400);
    const [u] = await db
      .insert(users)
      .values({ username, passwordHash: hashPassword(password), role: "admin" })
      .returning();
    const token = await signToken({ username: u.username, role: u.role, exp: Date.now() + TOKEN_TTL });
    return json({ token, ...(await publicStatus(u)) });
  }

  // ── Everything below requires an authenticated admin ───────────────
  const principal = await requireAuth(req);
  if (!principal) return json({ error: "Not authenticated" }, 401);
  if (principal.role !== "admin")
    return json({ error: "Administrator access required" }, 403);

  if (action === "saveConfig") {
    if (typeof body.api_key === "string" && body.api_key.trim())
      await setConfig("api_key", body.api_key.trim());
    if (typeof body.model === "string" && body.model)
      await setConfig("model", body.model);
    return json({ ok: true, ...(await publicStatus(principal)) });
  }

  if (action === "clearKey") {
    await setConfig("api_key", "");
    return json({ ok: true, ...(await publicStatus(principal)) });
  }

  if (action === "listUsers") {
    const rows = await db
      .select({ id: users.id, username: users.username, role: users.role, createdAt: users.createdAt })
      .from(users);
    return json({ users: rows });
  }

  if (action === "createUser") {
    const username = String(body.username || "").toLowerCase().trim();
    const password = String(body.password || "");
    if (!username || password.length < 6)
      return json({ error: "Username and a password of at least 6 characters are required" }, 400);
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
    if (existing) return json({ error: "That username already exists" }, 409);
    const role = body.role === "admin" ? "admin" : "user";
    await db.insert(users).values({ username, passwordHash: hashPassword(password), role });
    return json({ ok: true });
  }

  if (action === "deleteUser") {
    const id = parseInt(body.id, 10);
    if (!id) return json({ error: "User id required" }, 400);
    const [target] = await db.select().from(users).where(eq(users.id, id));
    if (!target) return json({ error: "User not found" }, 404);
    if (target.username === principal.username)
      return json({ error: "You cannot delete your own account" }, 400);
    if (target.role === "admin") {
      const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
      if (admins.length <= 1)
        return json({ error: "Cannot delete the last administrator" }, 400);
    }
    await db.delete(users).where(eq(users.id, id));
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
};

export const config: Config = { path: "/api/auth" };
