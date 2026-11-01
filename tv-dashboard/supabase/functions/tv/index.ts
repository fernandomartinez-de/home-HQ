// tv: remote control for the Fire TV, through the TV app's always running Home service.
//
// The dashboard queues commands; the TV app holds a long poll open, runs what arrives, and reports
// back with what's on screen. Nothing needs a port open at home.
//
// Dashboard (header x-home-key, checked against home_config.api_key_sha256):
//   POST /tv {"action":"command","device_id":"tv","command":{...}}   queue it, wait briefly for the result
//        commands: {"action":"launch","app":"com.netflix.ninja"}    (one of the device's apps)
//                  {"action":"home"} {"action":"back"} {"action":"sleep"}
//                  {"action":"volume","dir":"up"|"down"|"mute"}
//   POST /tv {"action":"poll"}                                        nothing to poll; the TV reports itself
//
// TV app (header x-tv-key, checked against tv_config.config.tv_key_sha256):
//   GET  /tv                    waits up to 25 s for commands, returns {"commands":[{id, command}]}
//   POST /tv {"action":"report","state":{...},"results":[{"id":1,"ok":true,"error":null}]}

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const DEVICE = "tv";
const WAIT_MS = 25_000;     // how long the TV's request stays open when there's nothing to do
const EXPIRE_S = 60;        // commands the TV hasn't picked up in this long are dropped (TV off)
const ACTIONS = new Set(["launch", "home", "back", "volume", "sleep"]);

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
  if (!ACTIONS.has(cmd?.action)) throw new Error("unknown command; use launch, home, back, volume or sleep");
  if (cmd.action === "volume" && !["up", "down", "mute"].includes(cmd.dir)) throw new Error("volume needs dir up, down or mute");
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

async function takeCommands() {
  const now = Date.now();
  await db.from("home_commands").update({ status: "expired", completed_at: new Date(now).toISOString() })
    .eq("device_id", DEVICE).eq("status", "pending").lt("requested_at", new Date(now - EXPIRE_S * 1000).toISOString());
  const { data, error } = await db.from("home_commands").select("id, command")
    .eq("device_id", DEVICE).eq("status", "pending").order("requested_at", { ascending: true }).limit(10);
  if (error) throw error;
  if (!data?.length) return [];
  // Claim them; only rows still pending are returned, so two open polls never run the same command.
  const { data: claimed, error: e2 } = await db.from("home_commands").update({ status: "sent" })
    .in("id", data.map((c) => c.id)).eq("status", "pending").select("id, command");
  if (e2) throw e2;
  return (claimed ?? []).sort((a, b) => a.id - b.id);
}

async function longPoll(req: Request) {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until && !req.signal.aborted) {
    const cmds = await takeCommands();
    if (cmds.length) return cmds;
    await sleep(1000);
  }
  return [];
}

async function report(body: any) {
  const results: { id: number; ok: boolean; error?: string | null }[] = Array.isArray(body.results) ? body.results : [];
  for (const r of results) {
    if (typeof r?.id !== "number") continue;
    await db.from("home_commands").update({
      status: r.ok ? "done" : "failed",
      result: r.ok ? { ok: true } : { error: String(r.error ?? "failed") },
      completed_at: new Date().toISOString(),
    }).eq("id", r.id).eq("device_id", DEVICE);
  }
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
