// home: one read endpoint for the Home Dashboard.
//
// Auth: header x-home-key (checked against home_config.api_key_sha256).
//
//   GET  /home                         every device with its latest state
//   GET  /home?history=24              ...plus readings and commands from the last N hours (max 168)
//   GET  /home?analytics=14            History tab data for the last N days (max 90): see home_analytics
//   POST /home {"action":"refresh"}    poll every appliance now, then return devices
//
// Commands go straight to the appliance functions (rheem, govee, ac).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const PROVIDERS = ["rheem", "govee", "ring", "lifx", "switchbot"]; // add "ac" once the ESP32 bridge exists

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authorized(key: string | null) {
  if (!key) return false;
  const { data } = await db.from("home_config").select("api_key_sha256").eq("id", 1).single();
  return !!data && data.api_key_sha256 === (await sha256(key));
}

async function devices() {
  const [{ data: latest, error: e1 }, { data: meta, error: e2 }] = await Promise.all([
    db.from("home_device_latest").select("*").eq("enabled", true),
    db.from("home_devices").select("id, capabilities, updated_at"),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  const caps = new Map((meta ?? []).map((m) => [m.id, m.capabilities]));
  return (latest ?? [])
    .map((d) => ({ ...d, capabilities: caps.get(d.id) ?? {} }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

async function history(hours: number) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data, error } = await db.from("home_readings")
    .select("device_id, recorded_at, state").gte("recorded_at", since)
    .order("recorded_at", { ascending: true }).limit(20000);
  if (error) throw error;
  const out: Record<string, { t: string; state: unknown }[]> = {};
  for (const r of data ?? []) (out[r.device_id] ??= []).push({ t: r.recorded_at, state: r.state });
  return out;
}

// The command log, newest first, with each device's name, for the dashboard's activity list.
async function activity(hours: number) {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const { data, error } = await db.from("home_commands")
    .select("id, device_id, command, source, status, requested_at, home_devices(name)")
    .gte("requested_at", since).order("requested_at", { ascending: false }).limit(25);
  if (error) throw error;
  return (data ?? []).map((c) => ({
    id: c.id, device_id: c.device_id, command: c.command, source: c.source, status: c.status, t: c.requested_at,
    device_name: (c.home_devices as { name?: string } | null)?.name ?? c.device_id,
  }));
}

Deno.serve(async (req) => {
  try {
    const key = req.headers.get("x-home-key");
    if (!(await authorized(key))) return json({ error: "unauthorized" }, 401);

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body.action !== "refresh") return json({ error: "POST supports action refresh" }, 400);
      const results = await Promise.allSettled(PROVIDERS.map((p) =>
        fetch(`${URL_BASE}/functions/v1/${p}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-home-key": key! },
          body: JSON.stringify({ action: "poll" }),
        }).then(async (r) => ({ provider: p, ok: r.ok, status: r.status, body: r.ok ? undefined : await r.text() }))
      ));
      return json({ refreshed: results.map((r) => r.status === "fulfilled" ? r.value : { error: String(r.reason) }), devices: await devices() });
    }

    const url = new URL(req.url);
    if (url.searchParams.has("analytics")) {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get("analytics")) || 14));
      const { data, error } = await db.rpc("home_analytics", { p_days: days });
      if (error) throw error;
      return json(data);
    }
    const h = Math.min(168, Math.max(0, Number(url.searchParams.get("history") ?? 0) || 0));
    if (!h) return json({ devices: await devices() });
    // The activity list is a nice to have; if it fails, the dashboard still loads.
    const [d, hist, act] = await Promise.all([devices(), history(h), activity(h).catch(() => [])]);
    return json({ devices: d, history: hist, activity: act });
  } catch (err) {
    return json({ error: String((err as Error).message ?? err) }, 502);
  }
});
