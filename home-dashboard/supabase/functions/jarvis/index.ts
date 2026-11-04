// jarvis: voice control for Home HQ. Takes what was said, lets Claude read every device's live state
// and run commands or modes, and answers with one short sentence to speak back.
//
// Auth: header x-home-key (checked against home_config.api_key_sha256).
// Secret: ANTHROPIC_API_KEY (console.anthropic.com, API keys). Optional JARVIS_MODEL.
//
//   POST /jarvis {"text":"movie mode"}            -> {"reply":"Movie mode is on.","did":[...]}
//   POST /jarvis {"text":"...","history":[...]}   history: earlier {role, content} turns, for follow ups
//   GET  /jarvis?text=movie%20mode                 same, handy for a quick test
//
// Used by the mic button in Home HQ and by an Apple Shortcut ("Hey Siri, Jarvis").
// Unlocking the front door is left to the dashboard on purpose: a voice request can't unlock it.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MODEL = Deno.env.get("JARVIS_MODEL") ?? "claude-haiku-5-5";
const TZ = "America/New_York";
const MAX_TURNS = 4;

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

// ---------- devices ----------

type Dev = { id: string; kind: string; provider: string; name: string; room: string | null; state: any; capabilities: any };

async function devices(): Promise<Dev[]> {
  const [{ data: latest, error: e1 }, { data: meta, error: e2 }] = await Promise.all([
    db.from("home_device_latest").select("id, kind, provider, name, room, state").eq("enabled", true),
    db.from("home_devices").select("id, capabilities"),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  const caps = new Map((meta ?? []).map((m) => [m.id, m.capabilities ?? {}]));
  return (latest ?? []).map((d) => ({ ...d, capabilities: caps.get(d.id) ?? {} })) as Dev[];
}

// What Claude sees about each device: only the fields that matter for answering and controlling.
function describe(d: Dev) {
  const s = d.state ?? {};
  const c = d.capabilities ?? {};
  const out: Record<string, unknown> = { id: d.id, kind: d.kind, name: d.name, room: d.room };
  if (s.online === false) out.online = false;
  if (d.kind === "light" || d.kind === "switch") {
    Object.assign(out, { on: s.power ?? null, brightness: s.brightness ?? undefined, color: s.color ?? undefined, kelvin: s.color_temp_k ?? undefined });
    if (typeof s.watts === "number") out.watts = s.watts;
    if (c.brightness) out.can = [c.brightness ? "brightness" : "", c.color ? "color" : "", c.color_temp_k ? "color_temp" : ""].filter(Boolean);
    if (Array.isArray(c.scenes) && c.scenes.length) out.scenes = c.scenes.slice(0, 25).map((x: any) => (typeof x === "string" ? x : x?.name)).filter(Boolean);
  } else if (d.kind === "water_heater") {
    Object.assign(out, { mode: s.mode, setpoint_f: s.setpoint_f ?? s.setpoint, hot_water_pct: s.hot_water_pct ?? s.tank_pct, running: s.running ?? s.heating, modes: c.modes, setpoint_range_f: [c.setpoint_min_f, c.setpoint_max_f] });
  } else if (d.kind === "tv") {
    Object.assign(out, { screen: s.screen ?? null, app: s.app_name ?? null, volume: s.volume ?? null, apps: (c.apps ?? []).map((a: any) => a.name).filter(Boolean) });
  } else if (d.kind === "lock") {
    Object.assign(out, { locked: s.locked, state: s.lock_state, door: s.door, battery: s.battery });
  } else if (d.kind === "camera") {
    const ev = Array.isArray(s.events) ? s.events.slice(0, 3).map((e: any) => ({ t: e.t, kind: e.kind, person: e.person ?? undefined })) : [];
    Object.assign(out, { ring_mode: s.mode ?? null, recent_events_utc: ev });
  } else if (d.kind === "meter") {
    const b = s.bill ?? {};
    Object.assign(out, { bill_so_far: b.cost_so_far, bill_forecast: b.cost_forecast, kwh_so_far: b.kwh_so_far });
  } else {
    out.state = s;
  }
  return out;
}

// ---------- running commands ----------

async function run(d: Dev, command: any, key: string) {
  const r = await fetch(`${URL_BASE}/functions/v1/${d.provider}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-home-key": key },
    body: JSON.stringify({ action: "command", device_id: d.id, command, source: "api" }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

// Commands for one device run in order (power, then brightness, then color); devices run side by side.
async function runAll(list: { device_id: string; command: any }[], devs: Dev[], key: string) {
  const byId = new Map(devs.map((d) => [d.id, d]));
  const groups = new Map<string, any[]>();
  const results: { device: string; command: any; ok: boolean; error?: string }[] = [];
  for (const a of list) {
    const d = byId.get(a.device_id);
    if (!d) { results.push({ device: a.device_id, command: a.command, ok: false, error: "no such device" }); continue; }
    if (d.kind === "lock" && a.command?.action !== "lock") {
      results.push({ device: d.name, command: a.command, ok: false, error: "unlocking by voice is turned off; use the Home HQ app" });
      continue;
    }
    if (!groups.has(d.id)) groups.set(d.id, []);
    groups.get(d.id)!.push(a.command);
  }
  await Promise.all([...groups].map(async ([id, cmds]) => {
    const d = byId.get(id)!;
    for (const c of cmds) {
      try { await run(d, c, key); results.push({ device: d.name, command: c, ok: true }); }
      catch (err) { results.push({ device: d.name, command: c, ok: false, error: String((err as Error).message ?? err) }); }
    }
  }));
  return results;
}

const isLight = (d: Dev) => d.kind === "light" && d.state?.online !== false;
const inLiving = (d: Dev) => /^living/i.test(d.room ?? "");

// The header modes, done here so Siri can use them too. Morning, Day and Night are saved routines.
async function runMode(mode: string, devs: Dev[], key: string) {
  if (["Morning", "Day", "Night"].includes(mode)) {
    const r = await fetch(`${URL_BASE}/functions/v1/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-home-key": key },
      body: JSON.stringify({ action: "routine", name: mode, background: true }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
    return [{ device: "routine", command: { routine: body.started ?? mode }, ok: true }];
  }
  const list: { device_id: string; command: any }[] = [];
  const off = (d: Dev) => { if (d.state?.power !== false) list.push({ device_id: d.id, command: { action: "power", on: false } }); };
  if (mode === "Movie") {
    for (const d of devs.filter(isLight)) {
      if (inLiving(d) && /tv|backlight/i.test(d.name)) list.push({ device_id: d.id, command: { action: "power", on: true } }, { device_id: d.id, command: { action: "scene", name: "Movie" } });
      else if (inLiving(d) && /lamp/i.test(d.name) && !/coffee/i.test(d.name)) list.push({ device_id: d.id, command: { action: "power", on: true } }, { device_id: d.id, command: { action: "brightness", value: d.capabilities?.brightness?.min ?? 1 } });
      else if (/coffee/i.test(d.name)) list.push({ device_id: d.id, command: { action: "power", on: true } }, { device_id: d.id, command: { action: "brightness", value: 15 } }, { device_id: d.id, command: { action: "color", hex: "#ff8448" } });
      else off(d);
    }
    return runAll(list, devs, key);
  }
  if (["Sleep", "Out", "Vacation"].includes(mode)) {
    devs.filter(isLight).forEach(off);
    const tv = devs.find((d) => d.kind === "tv");
    if (tv && tv.state?.screen !== "off") list.push({ device_id: tv.id, command: { action: "sleep" } });
    const heater = devs.find((d) => d.kind === "water_heater");
    if (mode === "Vacation" && heater) {
      list.push({ device_id: heater.id, command: { action: "power", on: false } });
      await fetch(`${URL_BASE}/functions/v1/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-home-key": key },
        body: JSON.stringify({ action: "enable", device_id: heater.id, enabled: false }),
      }).catch(() => null);
    }
    return runAll(list, devs, key);
  }
  throw new Error(`unknown mode ${mode}`);
}

// ---------- Claude ----------

const TOOLS = [
  {
    name: "control_devices",
    description: "Send commands to devices. Batch every command for the request into one call. Commands by kind:\n" +
      "light: {action:'power',on}, {action:'brightness',value:1..100}, {action:'color',hex:'#rrggbb'}, {action:'color_temp',kelvin}, {action:'scene',name} (a Govee scene name, like Movie). Turning a light on and setting it: power first, then brightness, then color.\n" +
      "switch (plugs, the towel warmer Bot): {action:'power',on}.\n" +
      "water_heater: {action:'set_setpoint',value} in F within its range, {action:'power',on}, {action:'set_mode',mode} (one of its modes).\n" +
      "tv: {action:'wake'}, {action:'sleep'}, {action:'home'}, {action:'back'}, {action:'open',name:'<app name>'}, {action:'volume',level:0..100} or {action:'volume',dir:'up'|'down'|'mute'}. To watch something when the screen is off: wake, then open.\n" +
      "lock: {action:'lock'} only. Unlocking by voice is not allowed.",
    input_schema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: { type: "object", properties: { device_id: { type: "string" }, command: { type: "object" } }, required: ["device_id", "command"] },
        },
      },
      required: ["actions"],
    },
  },
  {
    name: "run_mode",
    description: "Run one of the home's modes. Morning, Day and Night are saved routines (lights in set colors; Morning also turns the TV on to the news). " +
      "Movie: TV backlight on its Movie scene, floor lamp at its lowest, coffee station lamp at 15%, everything else off. " +
      "Sleep and Out: every light off and the TV off. Vacation: like Out, plus the water heater off and its schedule paused.",
    input_schema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["Morning", "Day", "Night", "Movie", "Sleep", "Out", "Vacation"] } },
      required: ["mode"],
    },
  },
];

function systemPrompt(devs: Dev[]) {
  const now = new Date().toLocaleString("en-US", { timeZone: TZ, weekday: "long", hour: "numeric", minute: "2-digit" });
  return `You are Jarvis, the voice of Home HQ, a home control app for an apartment in Brooklyn. It is ${now}.
Do what is asked using the tools, or answer from the device states below. Your reply is spoken aloud by Siri or the iPad:
one short sentence, two at most, plain words, no lists, no markdown, no emoji, no dashes. Sound calm and a little dry, like a capable butler.
Match devices by name and room ("kitchen lights" means every light in the Kitchen; "lights" with no room means the room the request implies, or all lights if it says "all").
Colors: pick a sensible hex ("warm" is around #ff8448, "red" #ff1805, "white" use color_temp 4000). If a request is unclear or no device fits, say so briefly instead of guessing wildly.
If something failed, say what failed. Never claim you did something you didn't. The AC is not connected yet.
Devices right now (on: null means unknown):
${devs.map((d) => JSON.stringify(describe(d))).join("\n")}`;
}

async function claude(body: unknown) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY secret is not set");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Claude: ${j?.error?.message ?? `HTTP ${r.status}`}`);
  return j;
}

async function ask(text: string, history: any[], key: string) {
  const devs = await devices();
  const system = systemPrompt(devs);
  const messages: any[] = [
    ...history.filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string").slice(-6),
    { role: "user", content: text },
  ];
  const did: any[] = [];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await claude({ model: MODEL, max_tokens: 600, system, tools: TOOLS, messages });
    const uses = (res.content ?? []).filter((b: any) => b.type === "tool_use");
    if (!uses.length || res.stop_reason !== "tool_use") {
      const reply = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
      return { reply: reply || "Done.", did };
    }
    messages.push({ role: "assistant", content: res.content });
    const results = await Promise.all(uses.map(async (u: any) => {
      try {
        const out = u.name === "run_mode" ? await runMode(String(u.input?.mode), devs, key)
          : u.name === "control_devices" ? await runAll(Array.isArray(u.input?.actions) ? u.input.actions : [], devs, key)
          : [{ ok: false, error: `unknown tool ${u.name}` }];
        did.push(...out);
        return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) };
      } catch (err) {
        return { type: "tool_result", tool_use_id: u.id, content: String((err as Error).message ?? err), is_error: true };
      }
    }));
    messages.push({ role: "user", content: results });
  }
  return { reply: "That took more steps than I expected; check Home HQ to see what changed.", did };
}

Deno.serve(async (req) => {
  try {
    const key = req.headers.get("x-home-key");
    if (!(await authorized(key))) return json({ error: "unauthorized" }, 401);
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const text = String(body.text ?? url.searchParams.get("text") ?? "").trim().slice(0, 500);
    if (!text) return json({ error: "say something: POST {\"text\":\"...\"}" }, 400);
    const out = await ask(text, Array.isArray(body.history) ? body.history : [], key!);
    return json({ text, ...out });
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    return json({ error: msg, reply: /ANTHROPIC_API_KEY/.test(msg) ? "My Claude key isn't set up yet." : "Sorry, something went wrong on my end." }, 502);
  }
});
