// Shared records API. Backed by Netlify Database (Postgres) so a record added
// on any device immediately appears on every other device. Photos are stored
// separately in Netlify Blobs (see photos.mts); deleting a record also removes
// its photo.
import type { Context, Config } from "@netlify/functions";
import { getDatabase } from "@netlify/database";
import { getStore } from "@netlify/blobs";
import { requireAdmin } from "../lib/admin.mts";

// Surface the snake_case has_image column as `hasImage`, matching the shape the
// frontend already expects.
function toClient(row: any) {
  if (!row) return row;
  const { has_image, ...rest } = row;
  return { ...rest, hasImage: !!has_image };
}

export default async (req: Request, context: Context) => {
  const db = getDatabase();
  const id = context.params.id ? Number(context.params.id) : null;

  try {
    if (req.method === "GET" && id != null) {
      const [row] = await db.sql`SELECT * FROM records WHERE id = ${id}`;
      if (!row) return new Response("Not found", { status: 404 });
      return Response.json(toClient(row));
    }

    if (req.method === "GET") {
      const rows = await db.sql`SELECT * FROM records ORDER BY recorded_at DESC`;
      return Response.json((rows as any[]).map(toClient));
    }

    if (req.method === "POST") {
      const b = await req.json();
      const recordedAt = b.recorded_at || new Date().toISOString();
      const [row] = await db.sql`
        INSERT INTO records
          (category_id, category_name, quantity, unit, supplier, vehicle_number,
           delivery_date, notes, color, icon, has_image, recorded_at)
        VALUES
          (${b.category_id ?? null}, ${b.category_name ?? null},
           ${b.quantity ?? null}, ${b.unit ?? null}, ${b.supplier ?? null},
           ${b.vehicle_number ?? null}, ${b.delivery_date ?? null},
           ${b.notes ?? null}, ${b.color ?? null}, ${b.icon ?? null},
           ${!!b.hasImage}, ${recordedAt})
        RETURNING *`;
      return Response.json(toClient(row), { status: 201 });
    }

    if (req.method === "PUT" && id != null) {
      const denied = await requireAdmin(db, req);
      if (denied) return denied;
      const b = await req.json();
      const [row] = await db.sql`
        UPDATE records SET
          category_id = ${b.category_id ?? null},
          category_name = ${b.category_name ?? null},
          quantity = ${b.quantity ?? null},
          unit = ${b.unit ?? null},
          supplier = ${b.supplier ?? null},
          vehicle_number = ${b.vehicle_number ?? null},
          delivery_date = ${b.delivery_date ?? null},
          notes = ${b.notes ?? null},
          color = ${b.color ?? null},
          icon = ${b.icon ?? null}
        WHERE id = ${id}
        RETURNING *`;
      return Response.json(toClient(row) || {});
    }

    if (req.method === "DELETE" && id != null) {
      const denied = await requireAdmin(db, req);
      if (denied) return denied;
      await db.sql`DELETE FROM records WHERE id = ${id}`;
      // Best-effort removal of the associated photo.
      try {
        await getStore("camp-photos").delete(`record-${id}`);
      } catch {
        /* photo may not exist */
      }
      return new Response(null, { status: 204 });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (e) {
    return new Response(String((e as Error)?.message || e), { status: 500 });
  }
};

export const config: Config = {
  path: ["/api/records", "/api/records/:id"],
};
