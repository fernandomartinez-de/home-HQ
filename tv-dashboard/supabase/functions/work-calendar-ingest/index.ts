// work-calendar-ingest: receives the next few days of a work Outlook calendar from a
// Power Automate flow (docs/power-automate.md) and replaces what is stored.
// Only start, end, title, all day and show-as are kept; nothing else is stored.
// Access: header x-ingest-key; only its SHA-256 is stored (tv_config.ingest_key_sha256).
import { createClient } from "npm:@supabase/supabase-js@2";

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Outlook "Get calendar view of events (V3)" returns UTC times without a zone suffix.
function toIso(t: unknown): string | null {
  if (typeof t !== "string" || !t) return null;
  const s = /[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : t + "Z";
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const cfg = await sb.from("tv_config").select("config").eq("id", 1).single();
  const key = req.headers.get("x-ingest-key") ?? "";
  if (!key || cfg.error || (await sha256(key)) !== cfg.data.config.ingest_key_sha256) return reply({ error: "unauthorized" }, 401);

  // Power Automate sometimes sends JSON as text, or JSON wrapped in a string.
  const raw = (await req.text()).trim();
  let body: any;
  try {
    body = JSON.parse(raw);
    if (typeof body === "string") body = JSON.parse(body);
  } catch {
    return reply({ error: "body must be the JSON list of events", length: raw.length }, 400);
  }
  const list: any[] = Array.isArray(body) ? body : Array.isArray(body?.value) ? body.value : Array.isArray(body?.events) ? body.events : [];

  const rows = list.map((e) => ({
    start_time: toIso(e.start ?? e.Start),
    end_time: toIso(e.end ?? e.End),
    title: String(e.subject ?? e.title ?? e.Subject ?? "Busy").slice(0, 200),
    all_day: e.isAllDay === true || e.isAllDay === "true" || e.isAllDay === "True",
    show_as: e.showAs ?? e.ShowAs ?? null,
  })).filter((r) => r.start_time && r.end_time && r.show_as !== "free");

  // Replace everything: the flow always sends the full upcoming window.
  const del = await sb.from("work_calendar_events").delete().gte("id", 0);
  if (del.error) return reply({ error: del.error.message }, 500);
  if (rows.length) {
    const ins = await sb.from("work_calendar_events").insert(rows);
    if (ins.error) return reply({ error: ins.error.message }, 500);
  }
  return reply({ stored: rows.length });
});
