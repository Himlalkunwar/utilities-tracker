// Shared photo storage. Receipt/meter images are too large for the database,
// so they live in Netlify Blobs keyed by record id. Storing them server-side
// (rather than per-device IndexedDB) means photos sync across devices too.
import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

export default async (req: Request, context: Context) => {
  const id = context.params.id;
  if (!id) return new Response("Missing id", { status: 400 });

  const store = getStore("camp-photos");
  const key = `record-${id}`;

  try {
    if (req.method === "GET") {
      const dataUrl = await store.get(key, { type: "text" });
      if (!dataUrl) return new Response("Not found", { status: 404 });
      return Response.json({ dataUrl });
    }

    if (req.method === "PUT" || req.method === "POST") {
      const { dataUrl } = await req.json();
      if (!dataUrl) return new Response("dataUrl required", { status: 400 });
      await store.set(key, dataUrl);
      return new Response(null, { status: 204 });
    }

    if (req.method === "DELETE") {
      await store.delete(key);
      return new Response(null, { status: 204 });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (e) {
    return new Response(String((e as Error)?.message || e), { status: 500 });
  }
};

export const config: Config = {
  path: "/api/photos/:id",
};
