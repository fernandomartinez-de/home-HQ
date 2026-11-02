// switchbot: read and control SwitchBot Bots, plugs and relay switches through the official
// SwitchBot API (v1.1). Bluetooth devices like the Bot reach the cloud through a SwitchBot Hub.
//
// Auth: every request needs the header x-home-key (checked against home_config.api_key_sha256).
// Secrets: SWITCHBOT_TOKEN and SWITCHBOT_SECRET (SwitchBot app, Profile, Preferences, About:
//          tap App Version 10 times, then Developer Options).
//
//   GET  /switchbot                     live state of every supported device (nothing stored)
//   POST /switchbot {"action":"poll"}   sync devices into home_devices and store home_readings
//   POST /switchbot {"action":"command","device_id":"switchbot_<id>","command":{...}}
//        commands: {"action":"power","on":true}
//                  {"action":"press"}                         (Bot only)
//
// A Bot in press mode only taps its button, so SwitchBot can't say whether the appliance is on.
// For those, power is what the dashboard last asked for, carried from reading to reading.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const API = "https://api.switch-bot.com/v1.1";
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

// ---------- SwitchBot API ----------

const configured = () => !!Deno.env.get("SWITCHBOT_TOKEN") && !!Deno.env.get("SWITCHBOT_SECRET");

async function headers() {
  const token = Deno.env.get("SWITCHBOT_TOKEN");
  const secret = Deno.env.get("SWITCHBOT_SECRET");
  if (!token || !secret) throw new Error("SWITCHBOT_TOKEN and SWITCHBOT_SECRET secrets are not set");
  const t = String(Date.now());
  const nonce = crypto.randomUUID();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token + t + nonce));
  const sign = btoa(String.fromCharCode(...new Uint8Array(mac))).toUpperCase();
  return { Authorization: token, sign, t, nonce, "Content-Type": "application/json" };
}

async function sb(path: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: await headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.statusCode !== 100) throw new Error(`SwitchBot ${path}: HTTP ${r.status} ${j.statusCode ?? ""} ${j.message ?? ""}`.trim());
  return j.body;
}

type Dev = { deviceId: string; deviceName: string; deviceType: string; hubDeviceId?: string; enableCloudService?: boolean };

// Devices that switch something on and off.
const SUPPORTED = /^(Bot|Plug|Plug Mini.*|Relay Switch.*)$/i;
const devices = async (): Promise<Dev[]> =>
  ((await sb("/devices")).deviceList ?? []).filter((d: Dev) => SUPPORTED.test(d.deviceType));

const deviceId = (d: Dev) => `switchbot_${d.deviceId.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;
const isBot = (d: Dev) => /^bot$/i.test(d.deviceType);

async function lastPower(id: string): Promise<boolean | null> {
  const { data } = await db.from("home_readings").select("state").eq("device_id", id)
    .order("recorded_at", { ascending: false }).limit(1).maybeSingle();
  const p = data?.state?.power;
  return typeof p === "boolean" ? p : null;
}

async function state(d: Dev) {
  try {
    const s = await sb(`/devices/${d.deviceId}/status`);
    const press = isBot(d) && s.deviceMode === "pressMode";
    return {
      online: true,
      power: press ? await lastPower(deviceId(d)) : s.power === "on",
      mode: s.deviceMode ?? null,
      battery: typeof s.battery === "number" ? s.battery : null,
      watts: typeof s.weight === "number" ? s.weight : typeof s.power === "number" ? s.power : null,
      brightness: null, color: null, color_temp_k: null,
    };
  } catch (err) {
    return { online: false, power: await lastPower(deviceId(d)), brightness: null, color: null, color_temp_k: null, error: String((err as Error).message ?? err) };
  }
}

const capabilities = (d: Dev) => ({ power: true, brightness: null, color: false, color_temp_k: null, press: isBot(d), type: d.deviceType });

// ---------- actions ----------

async function live() {
  const list = await devices();
  return Promise.all(list.map(async (d) => ({ id: deviceId(d), name: d.deviceName, capabilities: capabilities(d), state: await state(d) })));
}

async function poll() {
  if (!configured()) return { skipped: "SWITCHBOT_TOKEN and SWITCHBOT_SECRET secrets are not set" };
  const out = [];
  for (const d of await devices()) {
    const id = deviceId(d);
    const { error: e1 } = await db.from("home_devices").upsert({
      id, kind: "switch", provider: "switchbot", name: d.deviceName,
      provider_ref: { device: d.deviceId, type: d.deviceType, hub: d.hubDeviceId ?? null }, capabilities: capabilities(d),
      updated_at: new Date().toISOString(),
    });
    if (e1) throw e1;
    const s = await state(d);
    const { error: e2 } = await db.from("home_readings").insert({ device_id: id, source: "poll", state: s });
    if (e2) throw e2;
    out.push({ id, name: d.deviceName, state: s });
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
    const d = (await devices()).find((x) => deviceId(x) === id);
    if (!d) throw new Error(`device ${id} not found on the SwitchBot account`);
    const send = (command: string) => sb(`/devices/${d.deviceId}/commands`, { command, parameter: "default", commandType: "command" });
    let res;
    if (cmd?.action === "power") {
      const s = isBot(d) ? await sb(`/devices/${d.deviceId}/status`) : null;
      // A Bot in press mode can only tap; tap only when it changes what the dashboard thinks is on.
      if (s?.deviceMode === "pressMode") {
        const was = await lastPower(id);
        res = was === !!cmd.on ? { skipped: "already there" } : await send("press");
      } else {
        res = await send(cmd.on ? "turnOn" : "turnOff");
      }
      if (s?.deviceMode === "pressMode") {
        await db.from("home_readings").insert({ device_id: id, source: "command", state: { ...(await state(d)), power: !!cmd.on } });
      }
    } else if (cmd?.action === "press") {
      if (!isBot(d)) throw new Error("press is for a Bot");
      res = await send("press");
    } else {
      throw new Error("unknown command; use power or press");
    }
    await finish("done", { switchbot: res ?? null });
    return { ok: true, command_id: row.id };
  } catch (err) {
    await finish("failed", { error: String((err as Error).message ?? err) });
    throw err;
  }
}

Deno.serve(async (req) => {
  try {
    if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
    if (req.method === "GET") return json({ devices: await live() });
    const body = await req.json().catch(() => ({}));
    if (body.action === "poll") return json({ polled: await poll() });
    if (body.action === "command") return json(await command(body.device_id, body.command, body.source ?? "ui"));
    return json({ error: "use GET, or POST with action poll or command" }, 400);
  } catch (err) {
    return json({ error: String((err as Error).message ?? err) }, 502);
  }
});
