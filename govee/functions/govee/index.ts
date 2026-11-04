// govee: read and control Govee lights and smart plugs through the official Govee developer API.
//
// Auth: every request needs the header x-home-key (checked against home_config.api_key_sha256).
// Secret: GOVEE_API_KEY (request it in the Govee Home app).
//
//   GET  /govee                     live state of every light (nothing stored)
//   POST /govee {"action":"poll"}   sync devices into home_devices and store home_readings
//   POST /govee {"action":"list"}   every device on the account, including ones poll skips
//   POST /govee {"action":"command","device_id":"govee_<id>","command":{...}}
//        commands: {"action":"power","on":true}
//                  {"action":"brightness","value":60}         (percent)
//                  {"action":"color","hex":"#ff8800"}
//                  {"action":"color_temp","kelvin":3000}
//                  {"action":"scene","name":"Movie"}             (any scene the light offers in the Govee app)
//
// Bluetooth-only Govee lights (the bedframe strip) aren't in the Govee cloud. The TV app reaches
// them over Bluetooth instead (provider_ref {mac, via: "tv"}): commands become Govee's 20 byte
// Bluetooth packets, queued for the TV like the SwitchBot relay. They can't report state, so the
// dashboard shows what was last asked for.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const API = "https://openapi.api.govee.com/router/api/v1";
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

// ---------- Govee API ----------

async function govee(path: string, body?: unknown) {
  const key = Deno.env.get("GOVEE_API_KEY");
  if (!key) throw new Error("GOVEE_API_KEY secret is not set");
  const r = await fetch(`${API}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Govee-API-Key": key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code && j.code !== 200)) {
    throw new Error(`Govee ${path}: HTTP ${r.status} ${j.msg ?? j.message ?? ""}`.trim());
  }
  return j;
}

type Cap = { type: string; instance: string; parameters?: any };
type Device = { sku: string; device: string; deviceName?: string; type?: string; capabilities: Cap[] };

// Lights and smart plugs. Govee groups (sku like "SameModeGroup") have no state of their own, so skip them.
const TYPES = ["devices.types.light", "devices.types.socket"];
const devices = async (): Promise<Device[]> =>
  ((await govee("/user/devices")).data ?? []).filter((d: Device) =>
    (!d.type || TYPES.includes(d.type)) && !/group/i.test(d.sku));

const deviceId = (d: Device) => `govee_${d.device.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;
const cap = (d: Device, instance: string) => d.capabilities.find((c) => c.instance.toLowerCase() === instance.toLowerCase());
const range = (c?: Cap) => c?.parameters?.range ? { min: c.parameters.range.min, max: c.parameters.range.max } : null;

function capabilities(d: Device) {
  return {
    power: !!cap(d, "powerSwitch"),
    brightness: range(cap(d, "brightness")),
    color: !!cap(d, "colorRgb"),
    color_temp_k: range(cap(d, "colorTemperatureK")),
  };
}

async function state(d: Device) {
  try {
    return await readState(d);
  } catch (err) {
    // Some devices (e.g. Bluetooth only models) list fine but have no cloud state.
    return { online: null, power: null, brightness: null, color: null, color_temp_k: null, error: String((err as Error).message ?? err) };
  }
}

async function readState(d: Device) {
  const j = await govee("/device/state", { requestId: crypto.randomUUID(), payload: { sku: d.sku, device: d.device } });
  const caps: { instance: string; state?: { value: unknown } }[] = j.payload?.capabilities ?? [];
  const v = (inst: string) => caps.find((c) => c.instance.toLowerCase() === inst.toLowerCase())?.state?.value;
  const rgb = v("colorRgb");
  const kelvin = v("colorTemperatureK");
  return {
    online: v("online") ?? null,
    power: v("powerSwitch") === undefined ? null : v("powerSwitch") === 1,
    brightness: typeof v("brightness") === "number" ? v("brightness") : null,
    color: typeof rgb === "number" ? `#${rgb.toString(16).padStart(6, "0")}` : null,
    color_temp_k: typeof kelvin === "number" && kelvin > 0 ? kelvin : null,
  };
}

async function control(d: Device, instance: string, value: unknown) {
  const c = cap(d, instance);
  if (!c) throw new Error(`${d.deviceName ?? d.sku} does not support ${instance}`);
  return govee("/device/control", {
    requestId: crypto.randomUUID(),
    payload: { sku: d.sku, device: d.device, capability: { type: c.type, instance: c.instance, value } },
  });
}

// Every scene a light offers: the built in list on the device, the dynamic scenes Govee serves
// separately, and the user's own DIY scenes. Each comes with the capability to send it through.
async function sceneOptions(d: Device) {
  const out: { name: string; value: unknown; type: string; instance: string }[] = [];
  const add = (c?: Cap) => (c?.parameters?.options ?? []).forEach((o: any) =>
    o?.name && out.push({ name: String(o.name), value: o.value, type: c!.type, instance: c!.instance }));
  d.capabilities.filter((c) => /scene/i.test(c.instance)).forEach(add);
  for (const path of ["/device/scenes", "/device/diy-scenes"]) {
    try {
      const j = await govee(path, { requestId: crypto.randomUUID(), payload: { sku: d.sku, device: d.device } });
      (j.payload?.capabilities ?? []).forEach(add);
    } catch { /* not every light has both lists */ }
  }
  return out;
}

async function scene(d: Device, name: string) {
  const options = await sceneOptions(d);
  const want = name.trim().toLowerCase();
  const pick = options.find((o) => o.name.trim().toLowerCase() === want) ?? options.find((o) => o.name.toLowerCase().includes(want));
  if (!pick) throw new Error(`${d.deviceName ?? d.sku} has no "${name}" scene${options.length ? `; it has ${options.slice(0, 12).map((o) => o.name).join(", ")}` : ""}`);
  return govee("/device/control", {
    requestId: crypto.randomUUID(),
    payload: { sku: d.sku, device: d.device, capability: { type: pick.type, instance: pick.instance, value: pick.value } },
  });
}

// ---------- actions ----------

async function live() {
  const list = await devices();
  return Promise.all(list.map(async (d) => ({
    id: deviceId(d), name: d.deviceName || d.sku, capabilities: capabilities(d), state: await state(d),
  })));
}

async function poll() {
  const list = await devices();
  // A plug powering lights is a light; a kind set by hand (like "plug" for an appliance) is kept.
  const { data: known } = await db.from("home_devices").select("id, kind").eq("provider", "govee");
  const kindOf = new Map((known ?? []).map((k) => [k.id, k.kind]));
  const out = [];
  for (const d of list) {
    const id = deviceId(d);
    const s = await state(d);
    const { error: e1 } = await db.from("home_devices").upsert({
      id, kind: kindOf.get(id) ?? "light", provider: "govee", name: d.deviceName || d.sku,
      provider_ref: { sku: d.sku, device: d.device }, capabilities: capabilities(d),
      updated_at: new Date().toISOString(),
    });
    if (e1) throw e1;
    const { error: e2 } = await db.from("home_readings").insert({ device_id: id, source: "poll", state: s });
    if (e2) throw e2;
    out.push({ id, name: d.deviceName || d.sku, state: s });
  }
  return out;
}

// ---------- Bluetooth-only lights, through the TV ----------

// 0x33 command packets, zero padded to 19 bytes, XOR checksum last.
function packet(bytes: number[]) {
  const b = new Array(20).fill(0);
  bytes.forEach((v, i) => { b[i] = v & 0xff; });
  b[19] = b.slice(0, 19).reduce((x, y) => x ^ y, 0);
  return b.map((v) => v.toString(16).padStart(2, "0")).join("");
}

function kelvinRgb(k: number) {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const bl = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return [r, g, bl].map((v) => Math.max(0, Math.min(255, Math.round(v))));
}

// Models differ in how they take brightness (0 to 255 or 0 to 100) and color (mode 0x02, 0x0D or 0x15);
// provider_ref.bright_max and provider_ref.color_mode pin them once known, otherwise both color modes are sent.
function blePackets(ref: any, cmd: any) {
  if (cmd?.action === "power") return { packets: [packet([0x33, 0x01, cmd.on ? 1 : 0])], patch: { power: !!cmd.on } };
  if (cmd?.action === "brightness") {
    const pct = Math.min(100, Math.max(1, Math.round(Number(cmd.value))));
    const max = Number(ref?.bright_max) || 255;
    return { packets: [packet([0x33, 0x04, Math.max(1, Math.round((pct * max) / 100))])], patch: { brightness: pct, power: true } };
  }
  let rgb: number[] | null = null;
  let patch: Record<string, unknown> = {};
  if (cmd?.action === "color") {
    const hex = String(cmd.hex ?? "").replace("#", "");
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new Error("color needs hex like #ff8800");
    rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    patch = { color: `#${hex.toLowerCase()}`, color_temp_k: null, power: true };
  } else if (cmd?.action === "color_temp") {
    const k = Math.min(9000, Math.max(2000, Math.round(Number(cmd.kelvin))));
    rgb = kelvinRgb(k);
    patch = { color: null, color_temp_k: k, power: true };
  }
  if (!rgb) throw new Error("this light takes power, brightness, color or color_temp");
  // 0x02 and 0x0D are whole strip color modes; 0x15 is the RGBIC one (all segments, like the H617A).
  const modes: number[] = ref?.color_mode ? [Number(ref.color_mode)] : [0x02, 0x0d, 0x15];
  const colorPacket = (m: number) => m === 0x15
    ? packet([0x33, 0x05, 0x15, 0x01, ...rgb!, 0, 0, 0, 0, 0, 0xff, 0x7f])
    : packet([0x33, 0x05, m, ...rgb!]);
  return { packets: modes.map(colorPacket), patch };
}

async function relay(id: string, ref: any, cmd: any, source: string) {
  const { packets, patch } = blePackets(ref, cmd);
  const command = { ...cmd, ble: { mac: ref.mac, packets }, patch };
  const { data: row, error } = await db.from("home_commands").insert({ device_id: id, command, source, status: "pending" }).select("id").single();
  if (error) throw error;

  // Merge patch with last known state so we preserve fields like brightness when toggling power.
  const mergedPatch = async () => {
    const { data: prev } = await db.from("home_readings").select("state").eq("device_id", id).order("recorded_at", { ascending: false }).limit(1).maybeSingle();
    return { ...(prev?.state ?? {}), ...patch };
  };

  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const { data: c } = await db.from("home_commands").select("status, result").eq("id", row.id).single();
    if (c?.status === "done") {
      // Store the assumed state so Jarvis and the dashboard know what was last commanded.
      await db.from("home_readings").insert({ device_id: id, source: "command", state: await mergedPatch() }).catch(() => null);
      return { ok: true, command_id: row.id };
    }
    if (c?.status === "failed") throw new Error(c.result?.error ?? "the TV couldn't reach the light");
    if (c?.status === "expired") throw new Error("the TV didn't pick it up (is it unplugged?)");
  }
  // Queued but not confirmed yet — still store the assumed state as best effort.
  await db.from("home_readings").insert({ device_id: id, source: "command", state: await mergedPatch() }).catch(() => null);
  return { ok: true, command_id: row.id, queued: true };
}

async function command(id: string, cmd: any, source = "ui") {
  const { data: dev } = await db.from("home_devices").select("provider_ref").eq("id", id).maybeSingle();
  if (dev?.provider_ref?.via === "tv") return relay(id, dev.provider_ref, cmd, source);
  const { data: row, error } = await db.from("home_commands")
    .insert({ device_id: id, command: cmd, source, status: "pending" }).select("id").single();
  if (error) throw error;
  const finish = (status: string, result: unknown) =>
    db.from("home_commands").update({ status, result, completed_at: new Date().toISOString() }).eq("id", row.id);

  try {
    const d = (await devices()).find((x) => deviceId(x) === id);
    if (!d) throw new Error(`device ${id} not found on the Govee account`);
    let res;
    let patch: Record<string, unknown> = {};
    if (cmd?.action === "power") {
      res = await control(d, "powerSwitch", cmd.on ? 1 : 0);
      patch = { power: !!cmd.on };
    } else if (cmd?.action === "brightness") {
      const r = range(cap(d, "brightness")) ?? { min: 1, max: 100 };
      const val = Math.min(r.max, Math.max(r.min, Math.round(Number(cmd.value))));
      res = await control(d, "brightness", val);
      patch = { brightness: val, power: true };
    } else if (cmd?.action === "color") {
      const hex = String(cmd.hex ?? "").replace("#", "");
      if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new Error("color needs hex like #ff8800");
      res = await control(d, "colorRgb", parseInt(hex, 16));
      patch = { color: `#${hex.toLowerCase()}`, color_temp_k: null, power: true };
    } else if (cmd?.action === "color_temp") {
      const r = range(cap(d, "colorTemperatureK")) ?? { min: 2000, max: 9000 };
      const val = Math.min(r.max, Math.max(r.min, Math.round(Number(cmd.kelvin))));
      res = await control(d, "colorTemperatureK", val);
      patch = { color: null, color_temp_k: val, power: true };
    } else if (cmd?.action === "scene") {
      if (!cmd.name) throw new Error("scene needs a name, like Movie");
      res = await scene(d, String(cmd.name));
      patch = { power: true };
    } else {
      throw new Error("unknown command; use power, brightness, color, color_temp or scene");
    }
    await finish("done", { govee: res?.capability ?? res });
    // Store the assumed state so the dashboard and Jarvis reflect the change immediately.
    // Merge with the last known state so we don't lose fields like brightness when toggling power.
    if (Object.keys(patch).length) {
      const { data: prev } = await db.from("home_readings").select("state").eq("device_id", id).order("recorded_at", { ascending: false }).limit(1).maybeSingle();
      const merged = { ...(prev?.state ?? {}), ...patch };
      await db.from("home_readings").insert({ device_id: id, source: "command", state: merged }).catch(() => null);
    }
    return { ok: true, command_id: row.id };
  } catch (err) {
    await finish("failed", { error: String((err as Error).message ?? err) });
    throw err;
  }
}

Deno.serve(async (req) => {
  try {
    if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
    if (req.method === "GET") return json({ lights: await live() });
    const body = await req.json().catch(() => ({}));
    if (body.action === "poll") return json({ polled: await poll() });
    if (body.action === "list") {
      // Everything on the account, including what poll skips (groups, unsupported types).
      const all: Device[] = (await govee("/user/devices")).data ?? [];
      return json({ devices: all.map((d) => ({ name: d.deviceName, sku: d.sku, type: d.type ?? null, caps: d.capabilities.map((c) => c.instance) })) });
    }
    if (body.action === "command") return json(await command(body.device_id, body.command, body.source ?? "ui"));
    return json({ error: "use GET, or POST with action poll or command" }, 400);
  } catch (err) {
    return json({ error: String((err as Error).message ?? err) }, 502);
  }
});
