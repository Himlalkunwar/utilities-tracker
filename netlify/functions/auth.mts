// Auth endpoint for the single admin role.
//   GET  /api/auth            → { configured, isAdmin }   (status for the UI)
//   POST /api/auth {setup}     → first-time admin password; locked once set
//   POST /api/auth {login}     → verify password, return session token
//   POST /api/auth {change}    → admin changes the password (returns new token)
import type { Context, Config } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import {
  isConfigured,
  isAdmin,
  setupAdmin,
  loginAdmin,
  changeAdminPassword,
} from "../lib/admin.mts";

export default async (req: Request, _context: Context) => {
  const db = getDatabase();

  try {
    if (req.method === "GET") {
      return Response.json({
        configured: await isConfigured(db),
        isAdmin: await isAdmin(db, req),
      });
    }

    if (req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const action = b.action;
      const password = typeof b.password === "string" ? b.password : "";

      if (action === "setup") {
        if (password.length < 4) {
          return new Response("Password must be at least 4 characters.", { status: 400 });
        }
        const token = await setupAdmin(db, password);
        if (!token) {
          return new Response("Admin already configured.", { status: 409 });
        }
        return Response.json({ token });
      }

      if (action === "login") {
        const token = await loginAdmin(db, password);
        if (!token) return new Response("Incorrect password.", { status: 401 });
        return Response.json({ token });
      }

      if (action === "change") {
        if (!(await isAdmin(db, req))) {
          return new Response("Admin sign-in required.", { status: 401 });
        }
        const next = typeof b.newPassword === "string" ? b.newPassword : "";
        if (next.length < 4) {
          return new Response("New password must be at least 4 characters.", { status: 400 });
        }
        const token = await changeAdminPassword(db, next);
        if (!token) return new Response("Could not change password.", { status: 500 });
        return Response.json({ token });
      }

      return new Response("Unknown action.", { status: 400 });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (e) {
    return new Response(String((e as Error)?.message || e), { status: 500 });
  }
};

export const config: Config = {
  path: "/api/auth",
};
