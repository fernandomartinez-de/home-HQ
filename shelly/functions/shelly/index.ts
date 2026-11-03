// shelly: read and control Shelly plugs (the espresso machine) through the Shelly Cloud Control API.
//
// Auth: every request needs the header x-home-key (checked against home_config.api_key_sha256).
// Secrets: SHELLY_AUTH_KEY and SHELLY_SERVER (Shelly app, User settings, Authorization cloud key:
//          the key and the server address, like https://shelly-103-eu.shelly.cloud).
//
//   GET  /shelly                     live state of every device (nothing stored)
//   POST /shelly {"action":"poll"}   sync devices into home_devices and store home_readings
//   POST /shelly {"action":"command","device_id":"shelly_<id>","command":{"action":"power","on":true}}
//
// The cloud allows about one request a second, so the poll reads every device in one call.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authorized(req: Request) {
  const key = req.headers.get("x-home-key");
  if (!key) return false;
  const { data } = await db.from("home_config").select("api_key_sha256").eq("id", 1).single();
  return !!data && data.api_key_sha256 === (await sha256(key));
}

// ---------- Shelly Cloud ----------

const configured = () => !!Deno.env.get("SHELLY_AUTH_KEY") && !!Deno.env.get("SHELLY_SERVER");

async function shelly(path: string, params: Record<string, string> = {}) {
  const key = Deno.env.get("SHELLY_AUTH_KEY");
  const server = (Deno.env.get("SHELLY_SERVER") ?? "").trim().replace(/\/+$/, "");
  if (!key || !server) throw new Error("SHELLY_AUTH_KEY and SHELLY_SERVER secrets are not set");
  const base = /^https?:\/\//.test(server) ? server : `https://${server}`;
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, auth_key: key }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.isok === false) throw new Error(`Shelly ${path}: HTTP ${r.status} ${JSON.stringify(j.errors ?? j.error ?? "")}`);
  return j.data ?? {};
}

// One device's status, Gen2+ ("switch:0") or Gen1 ("relays", "meters").
function read(st: any) {
  const sw = st?.["switch:0"];
  const relay = st?.relays?.[0];
  const power = sw ? !!sw.output : relay ? !!relay.ison : null;
  const watts = sw && typeof sw.apower === "number" ? sw.apower : typeof st?.meters?.[0]?.power === "number" ? st.meters[0].power : null;
  return {
    online: st?._dev_info?.online ?? st?.cloud?.connected ?? true,
    power, watts,
    energy_wh: typeof sw?.aenergy?.total === "number" ? sw.aenergy.total : null,
    brightness: null, color: null, color_temp_k: null,
  };
}

async function all() {
  const data = await shelly("/device/all_status", { show_info: "true" });
  return Object.entries(data.devices_status ?? {}) as [string, any][];
}

const deviceId = (id: string) => `shelly_${id.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;
const caps = { power: true, brightness: null, color: false, color_temp_k: null, watts: true };

// ---------- actions ----------

async function poll() {
  if (!configured()) return { skipped: "SHELLY_AUTH_KEY and SHELLY_SERVER secrets are not set" };
  const list = await all();
  const out = [];
  for (const [sid, st] of list) {
    const id = deviceId(sid);
    const name = st?._dev_info?.name || st?.sys?.device?.name || (list.length === 1 ? "Espresso Machine" : `Shelly ${sid.slice(-4)}`);
    // The name comes from the Shelly app the first time; a name or room set in Home HQ is kept.
    await db.from("home_devices").upsert({
      id, kind: "switch", provider: "shelly", name, provider_ref: { id: sid, gen: st?._dev_info?.gen ?? null }, capabilities: caps,
    }, { onConflict: "id", ignoreDuplicates: true });
    await db.from("home_devices").update({ updated_at: new Date().toISOString() }).eq("id", id);
    const s = read(st);
    const { error } = await db.from("home_readings").insert({ device_id: id, source: "poll", state: s });
    if (error) throw error;
    out.push({ id, name, state: s });
  }
  return out;
}

async function command(id: string, cmd: any, source = "ui") {
  const { data: row, error } = await db.from("home_commands")
    .insert({ device_id: id, command: cmd, source, status: "pending" }).select("id").single();
  if (error) throw error;
  const finish = (status: string, result: unknown) =>
    db.from("home_commands").update({ status, result, completed_at: new Date().toISOString() }).eq("id", row.id);
  try {
    if (cmd?.action !== "power") throw new Error("unknown command; use power");
    const { data: dev } = await db.from("home_devices").select("provider_ref").eq("id", id).maybeSingle();
    const sid = dev?.provider_ref?.id;
    if (!sid) throw new Error(`device ${id} not found`);
    const res = await shelly("/device/relay/control", { id: String(sid), channel: "0", turn: cmd.on ? "on" : "off" });
    await finish("done", { shelly: res });
    // Record the new state right away so the dashboard doesn't wait for the next poll.
    const { data: last } = await db.from("home_readings").select("state").eq("device_id", id).order("recorded_at", { ascending: false }).limit(1).maybeSingle();
    await db.from("home_readings").insert({ device_id: id, source: "command", state: { ...(last?.state ?? {}), online: true, power: !!cmd.on } });
    return { ok: true, command_id: row.id };
  } catch (err) {
    await finish("failed", { error: String((err as Error).message ?? err) });
    throw err;
  }
}

Deno.serve(async (req) => {
  try {
    if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
    if (req.method === "GET") return json({ devices: (await all()).map(([sid, st]) => ({ id: deviceId(sid), state: read(st) })) });
    const body = await req.json().catch(() => ({}));
    if (body.action === "poll") return json({ polled: await poll() });
    if (body.action === "command") return json(await command(body.device_id, body.command, body.source ?? "ui"));
    return json({ error: "use GET, or POST with action poll or command" }, 400);
  } catch (err) {
    return json({ error: String((err as Error).message ?? err) }, 502);
  }
});
