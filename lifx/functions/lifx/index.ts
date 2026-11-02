// lifx: read and control LIFX lights through the official LIFX HTTP API.
//
// Auth: every request needs the header x-home-key (checked against home_config.api_key_sha256).
// Secret: LIFX_TOKEN (a personal access token from cloud.lifx.com, Settings).
//
//   GET  /lifx                     live state of every light (nothing stored)
//   POST /lifx {"action":"poll"}   sync lights into home_devices and store home_readings
//   POST /lifx {"action":"command","device_id":"lifx_<id>","command":{...}}
//        commands: {"action":"power","on":true}
//                  {"action":"brightness","value":60}        (percent)
//                  {"action":"color","hex":"#ff8800"}
//                  {"action":"color_temp","kelvin":3000}
//                  {"action":"scene","name":"Movie"}            (a scene saved in the LIFX app)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const API = "https://api.lifx.com/v1";
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

// ---------- LIFX API ----------

async function lifx(path: string, method = "GET", body?: unknown) {
  const token = Deno.env.get("LIFX_TOKEN");
  if (!token) throw new Error("LIFX_TOKEN secret is not set");
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`LIFX ${path}: HTTP ${r.status} ${j.error ?? ""}`.trim());
  return j;
}

type Bulb = {
  id: string; label: string; connected: boolean; power: "on" | "off"; brightness: number;
  color: { hue: number; saturation: number; kelvin: number };
  group?: { name: string }; location?: { name: string };
  product?: { name?: string; capabilities?: { has_color?: boolean; has_variable_color_temp?: boolean; min_kelvin?: number; max_kelvin?: number } };
};

const lights = async (): Promise<Bulb[]> => await lifx("/lights/all");
const deviceId = (b: Bulb) => `lifx_${b.id.toLowerCase()}`;

function hsvHex(h: number, s: number, v: number) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return `#${[f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function capabilities(b: Bulb) {
  const c = b.product?.capabilities ?? {};
  return {
    power: true,
    brightness: { min: 1, max: 100 },
    color: !!c.has_color,
    color_temp_k: c.has_variable_color_temp ? { min: c.min_kelvin ?? 1500, max: c.max_kelvin ?? 9000 } : null,
  };
}

function state(b: Bulb) {
  const white = (b.color?.saturation ?? 0) < 0.05;
  return {
    online: b.connected,
    power: b.power === "on",
    brightness: Math.max(1, Math.round((b.brightness ?? 0) * 100)),
    color: white ? null : hsvHex(b.color.hue, b.color.saturation, 1),
    color_temp_k: white ? b.color?.kelvin ?? null : null,
  };
}

const setState = (id: string, body: Record<string, unknown>) =>
  lifx(`/lights/id:${id}/state`, "PUT", { duration: 0.5, fast: false, ...body });

async function scene(name: string) {
  const scenes: { uuid: string; name: string }[] = await lifx("/scenes");
  const want = name.trim().toLowerCase();
  const pick = scenes.find((s) => s.name.trim().toLowerCase() === want) ?? scenes.find((s) => s.name.toLowerCase().includes(want));
  if (!pick) throw new Error(`no "${name}" scene in LIFX${scenes.length ? `; there is ${scenes.slice(0, 12).map((s) => s.name).join(", ")}` : ""}`);
  return lifx(`/scenes/scene_id:${pick.uuid}/activate`, "PUT", { duration: 1 });
}

// ---------- actions ----------

async function live() {
  return (await lights()).map((b) => ({ id: deviceId(b), name: b.label, capabilities: capabilities(b), state: state(b) }));
}

async function poll() {
  if (!Deno.env.get("LIFX_TOKEN")) return { skipped: "LIFX_TOKEN secret is not set" };
  const out = [];
  for (const b of await lights()) {
    const id = deviceId(b);
    const { error: e1 } = await db.from("home_devices").upsert({
      id, kind: "light", provider: "lifx", name: b.label,
      provider_ref: { id: b.id, product: b.product?.name ?? null }, capabilities: capabilities(b),
      updated_at: new Date().toISOString(),
    });
    if (e1) throw e1;
    // The LIFX room (group) fills in the room once; a room set by hand is kept.
    if (b.group?.name) await db.from("home_devices").update({ room: b.group.name }).eq("id", id).is("room", null);
    const s = state(b);
    const { error: e2 } = await db.from("home_readings").insert({ device_id: id, source: "poll", state: s });
    if (e2) throw e2;
    out.push({ id, name: b.label, state: s });
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
    const b = (await lights()).find((x) => deviceId(x) === id);
    if (!b) throw new Error(`light ${id} not found on the LIFX account`);
    let res;
    if (cmd?.action === "power") {
      res = await setState(b.id, { power: cmd.on ? "on" : "off" });
    } else if (cmd?.action === "brightness") {
      const v = Math.min(100, Math.max(1, Math.round(Number(cmd.value))));
      res = await setState(b.id, { power: "on", brightness: v / 100 });
    } else if (cmd?.action === "color") {
      const hex = String(cmd.hex ?? "").replace("#", "");
      if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new Error("color needs hex like #ff8800");
      res = await setState(b.id, { power: "on", color: `#${hex}` });
    } else if (cmd?.action === "color_temp") {
      const r = capabilities(b).color_temp_k ?? { min: 1500, max: 9000 };
      const k = Math.min(r.max, Math.max(r.min, Math.round(Number(cmd.kelvin))));
      res = await setState(b.id, { power: "on", color: `kelvin:${k} saturation:0` });
    } else if (cmd?.action === "scene") {
      if (!cmd.name) throw new Error("scene needs a name, like Movie");
      res = await scene(String(cmd.name));
    } else {
      throw new Error("unknown command; use power, brightness, color, color_temp or scene");
    }
    await finish("done", { lifx: res?.results ?? res });
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
