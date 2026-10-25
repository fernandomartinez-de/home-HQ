// tv-metrics-ingest: receives small live numbers for the TV dashboard and stores them in tv_metrics.
// Today: gmail_unread, sent every few minutes by a Google Apps Script (docs/gmail.md).
// Body: {"gmail_unread": 12}. Only names on the allowlist are stored, and only the number.
// Access: header x-metrics-key; only its SHA-256 is stored (tv_config.metrics_key_sha256).
import { createClient } from "npm:@supabase/supabase-js@2";

const ALLOWED = ["gmail_unread"];

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const cfg = await sb.from("tv_config").select("config").eq("id", 1).single();
  const key = req.headers.get("x-metrics-key") ?? "";
  if (!key || cfg.error || (await sha256(key)) !== cfg.data.config.metrics_key_sha256) return reply({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply({ error: "body must be JSON like {\"gmail_unread\": 12}" }, 400); }
  const now = new Date().toISOString();
  const rows = ALLOWED.filter((n) => typeof body?.[n] === "number" && isFinite(body[n] as number))
    .map((n) => ({ name: n, value: body[n] as number, updated_at: now }));
  if (!rows.length) return reply({ error: "nothing to store", allowed: ALLOWED }, 400);
  const { error } = await sb.from("tv_metrics").upsert(rows);
  if (error) return reply({ error: error.message }, 500);
  return reply({ ok: true, stored: rows.map((r) => r.name) });
});
