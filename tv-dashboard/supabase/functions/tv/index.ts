// tv: remote control for the Fire TV, through the TV app's always running Home service.
//
// The dashboard queues commands; the TV app holds a long poll open, runs what arrives, and reports
// back with what's on screen. Nothing needs a port open at home.
//
// Dashboard (header x-home-key, checked against home_config.api_key_sha256):
//   POST /tv {"action":"command","device_id":"tv","command":{...}}   queue it, wait briefly for the result
//        commands: {"action":"launch","app":"com.netflix.ninja"}    (one of the device's apps)
//                  {"action":"home"} {"action":"back"} {"action":"sleep"}
//                  {"action":"wake"}                            (turns the screen on; works while the TV sleeps)
//                  {"action":"open","name":"CBS News"}         (an installed app whose name contains this)
//                  {"action":"volume","dir":"up"|"down"|"mute"} or {"action":"volume","level":5}
//   POST /tv {"action":"poll"}                                        nothing to poll; the TV reports itself
//
// TV app (header x-tv-key, checked against tv_config.config.tv_key_sha256):
//   GET  /tv                    waits up to 25 s for commands, returns {"commands":[{id, command}]}
//   GET  /tv?screen=off         the same, but only wake and SwitchBot Bot commands
//   POST /tv {"action":"report","state":{...},"results":[{"id":1,"ok":true,"error":null}],
//             "ble":[{"mac":"..","mode":"pressMode","on":false,"battery":90,"rssi":-70}]}
//
// SwitchBot relay: the TV app stands in for a SwitchBot Hub. Bots it hears over Bluetooth are added
// as switch devices (provider switchbot, provider_ref.via "tv"); the switchbot function queues their
// commands with a "ble" part, which the TV picks up here alongside its own.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const DEVICE = "tv";
const WAIT_MS = 25_000;     // how long the TV's request stays open when there's nothing to do
const EXPIRE_S = 60;        // commands the TV hasn't picked up in this long are dropped (TV off)
const ACTIONS = new Set(["launch", "home", "back", "volume", "sleep", "wake", "open"]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function homeKeyOk(req: Request) {
  const key = req.headers.get("x-home-key");
  if (!key) return false;
  const { data } = await db.from("home_config").select("api_key_sha256").eq("id", 1).single();
  return !!data && data.api_key_sha256 === (await sha256(key));
}

async function tvKeyOk(req: Request) {
  const key = req.headers.get("x-tv-key");
  if (!key) return false;
  const { data } = await db.from("tv_config").select("config").eq("id", 1).single();
  return !!data?.config?.tv_key_sha256 && data.config.tv_key_sha256 === (await sha256(key));
}

// ---------- dashboard side ----------

async function command(id: string, cmd: any, source = "ui") {
  if (id !== DEVICE) throw new Error("unknown TV");
  if (!ACTIONS.has(cmd?.action)) throw new Error("unknown command; use launch, open, home, back, volume, wake or sleep");
  if (cmd.action === "open" && (typeof cmd.name !== "string" || cmd.name.trim().length < 2)) throw new Error("open needs an app name, like CBS News");
  if (cmd.action === "volume" && !["up", "down", "mute"].includes(cmd.dir) && !(Number.isInteger(cmd.level) && cmd.level >= 0 && cmd.level <= 100)) {
    throw new Error("volume needs dir up, down or mute, or a level from 0 to 100");
  }
  if (cmd.action === "launch") {
    const { data: dev } = await db.from("home_devices").select("capabilities").eq("id", DEVICE).single();
    const apps: { pkg: string }[] = dev?.capabilities?.apps ?? [];
    if (!apps.some((a) => a.pkg === cmd.app)) throw new Error("that app isn't on the TV's list");
  }
  const { data: row, error } = await db.from("home_commands")
    .insert({ device_id: DEVICE, command: cmd, source, status: "pending" }).select("id").single();
  if (error) throw error;

  // The TV usually picks it up within a second or two; wait a little so the dashboard can show the result.
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    const { data: c } = await db.from("home_commands").select("status, result").eq("id", row.id).single();
    if (c?.status === "done") return { ok: true, command_id: row.id };
    if (c?.status === "failed") throw new Error(c.result?.error ?? "the TV couldn't do that");
  }
  return { ok: true, command_id: row.id, queued: true };
}

// ---------- TV side ----------

// The devices whose commands the TV runs: itself (unless asleep) and every Bluetooth device it relays
// for (SwitchBot Bots with no hub, Govee lights with no Wi-Fi).
async function relayed(): Promise<string[]> {
  const { data } = await db.from("home_devices").select("id").eq("provider_ref->>via", "tv");
  return (data ?? []).map((d) => d.id);
}

async function takeCommands(asleep: boolean) {
  const now = Date.now();
  const bots = await relayed();
  const ids = [DEVICE, ...bots];
  await db.from("home_commands").update({ status: "expired", completed_at: new Date(now).toISOString() })
    .in("device_id", [DEVICE, ...bots]).eq("status", "pending").lt("requested_at", new Date(now - EXPIRE_S * 1000).toISOString());
  // Asleep: the Bots' commands, and a wake for the TV itself.
  let q = db.from("home_commands").select("id, command").eq("status", "pending");
  q = asleep
    ? q.or(`device_id.in.(${bots.join(",") || "none"}),and(device_id.eq.${DEVICE},command->>action.eq.wake)`)
    : q.in("device_id", ids);
  const { data, error } = await q.order("requested_at", { ascending: true }).limit(10);
  if (error) throw error;
  if (!data?.length) return [];
  // Claim them; only rows still pending are returned, so two open polls never run the same command.
  const { data: claimed, error: e2 } = await db.from("home_commands").update({ status: "sent" })
    .in("id", data.map((c) => c.id)).eq("status", "pending").select("id, command");
  if (e2) throw e2;
  return (claimed ?? []).sort((a, b) => a.id - b.id);
}

async function longPoll(req: Request) {
  const asleep = new URL(req.url).searchParams.get("screen") === "off";
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until && !req.signal.aborted) {
    const cmds = await takeCommands(asleep);
    if (cmds.length) return cmds;
    await sleep(1000);
  }
  return [];
}

const botId = (mac: string) => `switchbot_${mac.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;

async function lastState(id: string) {
  const { data } = await db.from("home_readings").select("state").eq("device_id", id)
    .order("recorded_at", { ascending: false }).limit(1).maybeSingle();
  return (data?.state ?? {}) as Record<string, unknown>;
}

// Govee lights the TV hears, kept in tv_config.config.ble_govee (mac: {name, rssi, t}) so one can be
// picked and added as a light (provider govee, provider_ref {mac, via: "tv", model}).
async function goveeHeard(list: any[]) {
  if (!list.length) return;
  const { data } = await db.from("tv_config").select("config").eq("id", 1).single();
  const config = data?.config ?? {};
  const seen = { ...(config.ble_govee ?? {}) };
  const t = new Date().toISOString();
  for (const g of list) {
    if (typeof g?.mac !== "string" || !/^[0-9A-Fa-f:]{17}$/.test(g.mac)) continue;
    seen[g.mac.toUpperCase()] = { name: typeof g.name === "string" ? g.name.slice(0, 60) : null, rssi: Number.isFinite(g.rssi) ? g.rssi : null, t };
  }
  await db.from("tv_config").update({ config: { ...config, ble_govee: seen } }).eq("id", 1);
}

// A Bot the TV heard: add it the first time (named later in Supabase), then store its state. In
// press mode the Bot can't know if the appliance is on, so power carries over from the last reading,
// until the appliance's own timer would have turned it off (auto_off_min, carried in the readings;
// the towel warmer shuts itself off after 2 hours).
async function botHeard(b: any) {
  if (typeof b?.mac !== "string" || !/^[0-9A-Fa-f:]{17}$/.test(b.mac)) return;
  const id = botId(b.mac);
  await db.from("home_devices").upsert({
    id, kind: "switch", provider: "switchbot", name: "SwitchBot Bot",
    provider_ref: { mac: b.mac.toUpperCase(), via: "tv", type: "Bot" },
    capabilities: { power: true, brightness: null, color: false, color_temp_k: null, press: true, type: "Bot" },
  }, { onConflict: "id", ignoreDuplicates: true });
  const press = b.mode !== "switchMode";
  const last = await lastState(id);
  const autoOff = Number(last.auto_off_min) || null;
  const since = typeof last.on_since === "string" ? Date.parse(last.on_since) : NaN;
  const timedOut = press && last.power === true && autoOff !== null && Date.now() - since > autoOff * 60_000;
  const power = press ? (timedOut ? false : typeof last.power === "boolean" ? last.power : null) : !!b.on;
  await db.from("home_readings").insert({
    device_id: id, source: "device",
    state: {
      online: true,
      power,
      on_since: power ? last.on_since ?? null : null,
      auto_off_min: autoOff,
      mode: press ? "pressMode" : "switchMode",
      battery: Number.isFinite(b.battery) ? b.battery : null,
      rssi: Number.isFinite(b.rssi) ? b.rssi : null,
      via: "tv", brightness: null, color: null, color_temp_k: null,
    },
  });
}

async function report(body: any) {
  const results: { id: number; ok: boolean; error?: string | null }[] = Array.isArray(body.results) ? body.results : [];
  const ids = [DEVICE, ...(await relayed())];
  for (const r of results) {
    if (typeof r?.id !== "number") continue;
    const { data: row } = await db.from("home_commands").update({
      status: r.ok ? "done" : "failed",
      result: r.ok ? { ok: true } : { error: String(r.error ?? "failed") },
      completed_at: new Date().toISOString(),
    }).eq("id", r.id).in("device_id", ids).select("device_id, command").maybeSingle();
    // A Govee light over Bluetooth can't report back, so it is now what the dashboard asked for.
    if (r.ok && row?.command?.ble?.packets && row.command.patch && typeof row.command.patch === "object") {
      const last = await lastState(row.device_id);
      await db.from("home_readings").insert({ device_id: row.device_id, source: "command", state: { ...last, online: true, ...row.command.patch } });
      continue;
    }
    // A Bot that just tapped (press mode): the appliance is now what the dashboard asked for.
    if (r.ok && row?.command?.ble && typeof row.command.on === "boolean") {
      const last = await lastState(row.device_id);
      await db.from("home_readings").insert({ device_id: row.device_id, source: "command",
        state: { ...last, online: true, power: row.command.on, on_since: row.command.on ? new Date().toISOString() : null } });
    }
  }
  const heard = Array.isArray(body.ble) ? body.ble.slice(0, 40) : [];
  for (const b of heard.filter((x: any) => !x?.govee)) await botHeard(b);
  await goveeHeard(heard.filter((x: any) => x?.govee));
  if (body.state && typeof body.state === "object") {
    const s = body.state;
    const state = {
      online: true,
      screen: s.screen === "off" ? "off" : "on",
      app: typeof s.app === "string" ? s.app.slice(0, 200) : null,
      app_name: typeof s.app_name === "string" ? s.app_name.slice(0, 100) : null,
      volume: Number.isFinite(s.volume) ? s.volume : null,
      max_volume: Number.isFinite(s.max_volume) ? s.max_volume : null,
      muted: typeof s.muted === "boolean" ? s.muted : null,
      version: typeof s.version === "string" ? s.version.slice(0, 40) : null,
    };
    const { error } = await db.from("home_readings").insert({ device_id: DEVICE, source: "device", state });
    if (error) throw error;
  }
  return { ok: true };
}

Deno.serve(async (req) => {
  try {
    if (req.headers.get("x-tv-key")) {
      if (!(await tvKeyOk(req))) return json({ error: "unauthorized" }, 401);
      if (req.method === "GET") return json({ commands: await longPoll(req) });
      const body = await req.json().catch(() => ({}));
      if (body.action === "report") return json(await report(body));
      return json({ error: "use GET, or POST with action report" }, 400);
    }
    if (!(await homeKeyOk(req))) return json({ error: "unauthorized" }, 401);
    const body = await req.json().catch(() => ({}));
    if (body.action === "poll") return json({ ok: true });
    if (body.action === "command") return json(await command(body.device_id, body.command, body.source ?? "ui"));
    return json({ error: "use POST with action command or poll" }, 400);
  } catch (err) {
    return json({ error: String((err as Error).message ?? err) }, 502);
  }
});
