// govee: read and control Govee lights through the official Govee developer API.
//
// Auth: every request needs the header x-home-key (checked against home_config.api_key_sha256).
// Secret: GOVEE_API_KEY (request it in the Govee Home app).
//
//   GET  /govee                     live state of every light (nothing stored)
//   POST /govee {"action":"poll"}   sync devices into home_devices and store home_readings
//   POST /govee {"action":"command","device_id":"govee_<id>","command":{...}}
//        commands: {"action":"power","on":true}
//                  {"action":"brightness","value":60}         (percent)
//                  {"action":"color","hex":"#ff8800"}
//                  {"action":"color_temp","kelvin":3000}

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

const devices = async (): Promise<Device[]> =>
  ((await govee("/user/devices")).data ?? []).filter((d: Device) => !d.type || d.type === "devices.types.light");

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

// ---------- actions ----------

async function live() {
  const list = await devices();
  return Promise.all(list.map(async (d) => ({
    id: deviceId(d), name: d.deviceName || d.sku, capabilities: capabilities(d), state: await state(d),
  })));
}

async function poll() {
  const list = await devices();
  const out = [];
  for (const d of list) {
    const id = deviceId(d);
    const s = await state(d);
    const { error: e1 } = await db.from("home_devices").upsert({
      id, kind: "light", provider: "govee", name: d.deviceName || d.sku,
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

async function command(id: string, cmd: any, source = "ui") {
  const { data: row, error } = await db.from("home_commands")
    .insert({ device_id: id, command: cmd, source, status: "pending" }).select("id").single();
  if (error) throw error;
  const finish = (status: string, result: unknown) =>
    db.from("home_commands").update({ status, result, completed_at: new Date().toISOString() }).eq("id", row.id);

  try {
    const d = (await devices()).find((x) => deviceId(x) === id);
    if (!d) throw new Error(`light ${id} not found on the Govee account`);
    let res;
    if (cmd?.action === "power") {
      res = await control(d, "powerSwitch", cmd.on ? 1 : 0);
    } else if (cmd?.action === "brightness") {
      const r = range(cap(d, "brightness")) ?? { min: 1, max: 100 };
      res = await control(d, "brightness", Math.min(r.max, Math.max(r.min, Math.round(Number(cmd.value)))));
    } else if (cmd?.action === "color") {
      const hex = String(cmd.hex ?? "").replace("#", "");
      if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new Error("color needs hex like #ff8800");
      res = await control(d, "colorRgb", parseInt(hex, 16));
    } else if (cmd?.action === "color_temp") {
      const r = range(cap(d, "colorTemperatureK")) ?? { min: 2000, max: 9000 };
      res = await control(d, "colorTemperatureK", Math.min(r.max, Math.max(r.min, Math.round(Number(cmd.kelvin)))));
    } else {
      throw new Error("unknown command; use power, brightness, color or color_temp");
    }
    await finish("done", { govee: res?.capability ?? res });
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
    if (body.action === "command") return json(await command(body.device_id, body.command, body.source ?? "ui"));
    return json({ error: "use GET, or POST with action poll or command" }, 400);
  } catch (err) {
    return json({ error: String((err as Error).message ?? err) }, 502);
  }
});
