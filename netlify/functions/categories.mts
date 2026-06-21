// Shared categories API. Backed by Netlify Database (Postgres) so every device
// reads and writes the same category list.
import type { Context, Config } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { requireAdmin } from "../lib/admin.mts";

export default async (req: Request, context: Context) => {
  const db = getDatabase();
  const id = context.params.id ? Number(context.params.id) : null;

  try {
    if (req.method === "GET") {
      const rows = await db.sql`SELECT * FROM categories ORDER BY name`;
      return Response.json(rows);
    }

    // Creating, editing and deleting categories is an admin-only action.
    if (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") {
      const denied = await requireAdmin(db, req);
      if (denied) return denied;
    }

    if (req.method === "POST") {
      const b = await req.json();
      if (!b.name || !b.unit) {
        return new Response("name and unit are required", { status: 400 });
      }
      const [row] = await db.sql`
        INSERT INTO categories (name, unit, icon, color)
        VALUES (${b.name}, ${b.unit}, ${b.icon || "📦"}, ${b.color || "#4361ee"})
        RETURNING *`;
      return Response.json(row, { status: 201 });
    }

    if (req.method === "PUT" && id != null) {
      const b = await req.json();
      const [row] = await db.sql`
        UPDATE categories
        SET name = ${b.name}, unit = ${b.unit}, icon = ${b.icon}, color = ${b.color}
        WHERE id = ${id}
        RETURNING *`;
      return Response.json(row || {});
    }

    if (req.method === "DELETE" && id != null) {
      await db.sql`DELETE FROM categories WHERE id = ${id}`;
      return new Response(null, { status: 204 });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (e) {
    return new Response(String((e as Error)?.message || e), { status: 500 });
  }
};

export const config: Config = {
  path: ["/api/categories", "/api/categories/:id"],
};
