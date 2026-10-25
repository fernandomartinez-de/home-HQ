// schedules: weekly time blocks for any appliance, run by Home HQ.
//
// A block has a day, a start, a stop and a command (for the water heater: mode and temperature).
// At the start the command runs; at the stop the device turns off, unless another block starts
// right then. Outside all blocks the device is off. A stop earlier than the start runs past midnight.
//
// Auth: header x-home-key (checked against home_config.api_key_sha256).
//
//   GET  /schedules?device_id=...        blocks, whether the schedule is on, the active block, the next change
//   PUT  /schedules {"device_id","blocks":[{"day":0..6 (0 = Sunday),"start":"HH:MM","stop":"HH:MM","command":{...}}]}
//                                        replace the device's whole schedule
//   POST /schedules {"action":"enable","device_id","enabled":true,"apply_now":true}
//                                        turn the schedule on or off; optionally apply what should be happening now
//   POST /schedules {"action":"tick"}    run every start and stop that just came due (pg_cron, every minute)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const DEFAULT_TZ = "America/New_York";
const WEEK = 7 * 1440;
const DUE_WINDOW_MIN = 5;   // a start or stop counts as due for 5 minutes, so a late tick still runs it
const RERUN_GUARD_MIN = 10; // never run the same start or stop twice within 10 minutes
const MAX_BLOCKS_PER_DAY = 4;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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

// ---------- time ----------

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Minutes since Sunday 00:00, local time.
function nowInWeek(tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  return WEEKDAY[p.weekday] * 1440 + Number(p.hour) * 60 + Number(p.minute);
}

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const since = (now: number, at: number) => ((now - at) % WEEK + WEEK) % WEEK; // minutes since `at`, wrapping

const label = (start: string) => {
  const m = toMin(start);
  return m < 720 ? "Morning" : m < 1020 ? "Afternoon" : m < 1260 ? "Evening" : "Night";
};

type Row = {
  id: number; device_id: string; slot: string | null; days: number[]; at_time: string; end_time: string | null;
  time_zone: string; command: any; enabled: boolean; last_run_at: string | null; last_end_run_at: string | null;
};

// A block placed on the week: where it starts and how long it lasts, in minutes.
function place(r: Row) {
  const start = toMin(r.at_time.slice(0, 5));
  const stop = toMin((r.end_time ?? r.at_time).slice(0, 5));
  const startW = r.days[0] * 1440 + start;
  const dur = stop > start ? stop - start : stop + 1440 - start;
  return { startW, dur, stopW: (startW + dur) % WEEK };
}

const isActive = (r: Row, now: number) => { const p = place(r); return since(now, p.startW) < p.dur; };

// What "off" means for the kind of command a block uses.
function offCommand(command: any) {
  if (command?.action === "set_state") return { action: "set_state", mode: "off" };
  return { action: "power", on: false };
}

// ---------- data ----------

async function device(id: string) {
  const { data, error } = await db.from("home_devices").select("id, provider, name, schedule_enabled").eq("id", id).single();
  if (error || !data) throw new Error(`unknown device ${id}`);
  return data;
}

async function rows(deviceId: string): Promise<Row[]> {
  const { data, error } = await db.from("home_schedules").select("*").eq("device_id", deviceId);
  if (error) throw error;
  return ((data ?? []) as Row[]).filter((r) => r.enabled && r.days?.length && r.end_time);
}

const view = (r: Row) => ({
  id: r.id, day: r.days[0], slot: r.slot ?? label(r.at_time), start: r.at_time.slice(0, 5),
  stop: (r.end_time ?? r.at_time).slice(0, 5), command: r.command,
});

async function run(provider: string, deviceId: string, command: unknown, key: string) {
  const r = await fetch(`${URL_BASE}/functions/v1/${provider}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-home-key": key },
    body: JSON.stringify({ action: "command", device_id: deviceId, command, source: "schedule" }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

// ---------- actions ----------

async function getSchedule(deviceId: string) {
  const d = await device(deviceId);
  const list = await rows(deviceId);
  const tz = list[0]?.time_zone ?? DEFAULT_TZ;
  const now = nowInWeek(tz);
  const active = list.find((r) => isActive(r, now)) ?? null;
  // The next block to start, measured from now.
  const upcoming = [...list].sort((a, b) => since(place(a).startW, now) - since(place(b).startW, now))
    .find((r) => r !== active) ?? null;
  return {
    device_id: d.id, name: d.name, enabled: d.schedule_enabled, time_zone: tz,
    blocks: list.map(view).sort((a, b) => a.day - b.day || a.start.localeCompare(b.start)),
    active: active ? view(active) : null,
    next: upcoming ? view(upcoming) : null,
  };
}

async function saveSchedule(deviceId: string, blocks: any[]) {
  await device(deviceId);
  if (!Array.isArray(blocks)) throw new Error("blocks must be a list");
  const clean = blocks.map((b) => {
    const day = Number(b.day);
    if (!(day >= 0 && day <= 6)) throw new Error("day must be 0 (Sunday) to 6 (Saturday)");
    for (const t of [b.start, b.stop]) if (!/^\d{1,2}:\d{2}$/.test(String(t))) throw new Error("times must look like 07:00");
    if (b.start === b.stop) throw new Error(`A ${DAY_NAMES[day]} block starts and stops at the same time.`);
    if (!b.command?.action) throw new Error("each block needs a command");
    return {
      device_id: deviceId, name: label(b.start), slot: label(b.start), days: [day], at_time: b.start, end_time: b.stop,
      time_zone: b.time_zone ?? DEFAULT_TZ, command: b.command, enabled: true,
    };
  });
  for (let day = 0; day < 7; day++) {
    if (clean.filter((c) => c.days[0] === day).length > MAX_BLOCKS_PER_DAY) {
      throw new Error(`${DAY_NAMES[day]} has more than ${MAX_BLOCKS_PER_DAY} blocks.`);
    }
  }
  // No two blocks may overlap anywhere in the week (including blocks that run past midnight).
  const placed = clean.map((c) => ({ c, p: place({ ...c, id: 0, last_run_at: null, last_end_run_at: null } as Row) }));
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i].p, b = placed[j].p;
      if (since(b.startW, a.startW) < a.dur || since(a.startW, b.startW) < b.dur) {
        throw new Error(`Two blocks overlap on ${DAY_NAMES[placed[i].c.days[0]]} or ${DAY_NAMES[placed[j].c.days[0]]}. Adjust their times.`);
      }
    }
  }
  const { error: e1 } = await db.from("home_schedules").delete().eq("device_id", deviceId);
  if (e1) throw e1;
  if (clean.length) {
    const { error: e2 } = await db.from("home_schedules").insert(clean);
    if (e2) throw e2;
  }
  return getSchedule(deviceId);
}

async function setEnabled(deviceId: string, enabled: boolean, applyNow: boolean, key: string) {
  const d = await device(deviceId);
  const { error } = await db.from("home_devices").update({ schedule_enabled: enabled }).eq("id", deviceId);
  if (error) throw error;
  let applied: unknown = null;
  if (enabled && applyNow) {
    const list = await rows(deviceId);
    if (list.length) {
      const now = nowInWeek(list[0].time_zone ?? DEFAULT_TZ);
      const active = list.find((r) => isActive(r, now));
      const command = active ? active.command : offCommand(list[0].command);
      await run(d.provider, deviceId, command, key);
      applied = active ? view(active) : "off";
    }
  }
  return { ...(await getSchedule(deviceId)), applied };
}

async function tick(key: string) {
  const { data: devices, error } = await db.from("home_devices").select("id, provider").eq("schedule_enabled", true);
  if (error) throw error;
  const ran: unknown[] = [];
  const recently = (t: string | null) => !!t && Date.now() - Date.parse(t) < RERUN_GUARD_MIN * 60_000;

  for (const d of devices ?? []) {
    const list = await rows(d.id);
    if (!list.length) continue;
    const now = nowInWeek(list[0].time_zone ?? DEFAULT_TZ);

    // Stops first, so a stop and the next block's start in the same minute end with the block on.
    for (const r of list) {
      const p = place(r);
      if (since(now, p.stopW) >= DUE_WINDOW_MIN || recently(r.last_end_run_at)) continue;
      await db.from("home_schedules").update({ last_end_run_at: new Date().toISOString() }).eq("id", r.id);
      if (list.some((o) => o !== r && isActive(o, now))) continue; // another block takes over
      try {
        await run(d.provider, d.id, offCommand(r.command), key);
        ran.push({ device_id: d.id, block: view(r), event: "stop", ok: true });
      } catch (err) {
        ran.push({ device_id: d.id, block: view(r), event: "stop", ok: false, error: String((err as Error).message ?? err) });
      }
    }

    for (const r of list) {
      const p = place(r);
      if (since(now, p.startW) >= DUE_WINDOW_MIN || recently(r.last_run_at)) continue;
      // Mark first, so a slow appliance can't make the next tick run it again.
      await db.from("home_schedules").update({ last_run_at: new Date().toISOString() }).eq("id", r.id);
      try {
        await run(d.provider, d.id, r.command, key);
        ran.push({ device_id: d.id, block: view(r), event: "start", ok: true });
      } catch (err) {
        ran.push({ device_id: d.id, block: view(r), event: "start", ok: false, error: String((err as Error).message ?? err) });
      }
    }
  }
  return { ran };
}

Deno.serve(async (req) => {
  try {
    const key = req.headers.get("x-home-key");
    if (!(await authorized(key))) return json({ error: "unauthorized" }, 401);
    if (req.method === "GET") {
      const id = new URL(req.url).searchParams.get("device_id");
      if (!id) return json({ error: "device_id is required" }, 400);
      return json(await getSchedule(id));
    }
    const body = await req.json().catch(() => ({}));
    if (req.method === "PUT") return json(await saveSchedule(body.device_id, body.blocks));
    if (body.action === "enable") return json(await setEnabled(body.device_id, !!body.enabled, !!body.apply_now, key!));
    if (body.action === "tick") return json(await tick(key!));
    return json({ error: "use GET, PUT, or POST with action enable or tick" }, 400);
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    return json({ error: msg }, /overlap|same time|more than|must|needs/.test(msg) ? 400 : 502);
  }
});
