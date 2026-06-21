import type { Config } from "@netlify/functions";
import { requireAuth, getConfig, json } from "./_lib.js";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const PROMPT =
  'Analyze this camp utility delivery image. Return ONLY valid JSON: {"quantity":number_or_null,"unit":"liters|kg|m3|kWh|null","category":"Fuel (Diesel)|Fuel (Petrol)|Water|LPG|Sewage|Waste|Electricity|Other","supplier":"name_or_null","vehicle_number":"plate_or_null","delivery_date":"YYYY-MM-DD_or_null","notes":"other_info_or_null"}';

// Proxies image extraction to Anthropic using the server-stored API key, so
// the key is never exposed to the browser. Any authenticated user may call it.
export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const principal = await requireAuth(req);
  if (!principal) return json({ error: "Not authenticated" }, 401);

  const apiKey = await getConfig("api_key");
  if (!apiKey)
    return json({ error: "The administrator has not configured the API key yet." }, 400);
  const model = (await getConfig("model")) || DEFAULT_MODEL;

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* ignore */
  }
  const { dataBase64, mimeType } = body;
  if (!dataBase64 || !mimeType) return json({ error: "No image provided" }, 400);

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mimeType, data: dataBase64 } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
    });
    const data: any = await r.json();
    if (data.error) return json({ error: data.error.message || "AI request failed" }, 502);
    const text = (data.content?.[0]?.text || "").trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return json({ error: "Could not parse AI response" }, 502);
    return json({ fields: JSON.parse(match[0]) });
  } catch (e: any) {
    return json({ error: e?.message || "AI request failed" }, 502);
  }
};

export const config: Config = { path: "/api/extract" };
