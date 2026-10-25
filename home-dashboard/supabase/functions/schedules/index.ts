// schedules: Rheem style weekly schedules for any appliance, run by Home HQ.
//
// Auth: header x-home-key (checked against home_config.api_key_sha256).
//
//   GET  /schedules?device_id=...        the device's slots, whether its schedule is on, the current slot
//   PUT  /schedules {"device_id","slots":[{"day":0..6 (0 = Sunday),"slot","at_time":"HH:MM","command":{...}}]}
//                                        replace the device's whole schedule
//   POST /schedules {"action":"enable","device_id","enabled":true,"apply_now":true}
//                                        turn the schedule on or off; optionally apply the current slot now
//   POST /schedules {"action":"tick"}    run every slot that just came due (pg_cron, every minute)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL_BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const DEFAULT_TZ = "America/New_York";
const DUE_WINDOW_MIN = 5;   // a slot counts as due for 5 minutes, so a late tick still runs it
const RERUN_GUARD_MIN = 10; // never run the same slot twice within 10 minutes

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

function localNow(tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return { day: WEEKDAY[parts.weekday], minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const toMinutes = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

type Row = { id: number; device_id: string; slot: string | null; days: number[]; at_time: string; time_zone: string; command: any; enabled: boolean; last_run_at: string | null };

// The slot in effect right now: the latest one today that has started, else the last one before today.
function currentSlot(rows: Row[], tz: string) {
  const now = localNow(tz);
  const key = (r: Row) => {
    const back = (now.day - r.days[0] + 7) % 7; // how many days ago this slot's day was
    const mins = toMinutes(r.at_time);
    const daysAgo = back === 0 && mins > now.minutes ? 7 : back;
    return daysAgo * 1440 + (now.minutes - mins);
  };
  return rows.filter((r) => r.enabled && r.days?.length).sort((a, b) => key(a) - key(b))[0] ?? null;
}

// ---------- data ----------

async function device(id: string) {
  const { data, error } = await db.from("home_devices").select("id, provider, name, schedule_enabled").eq("id", id).single();
  if (error || !data) throw new Error(`unknown device ${id}`);
  return data;
}

async function rows(deviceId: string): Promise<Row[]> {
  const { data, error } = await db.from("home_schedules").select("*").eq("device_id", deviceId)
    .order("at_time", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Row[];
}

const view = (r: Row) => ({
  id: r.id, day: r.days[0], slot: r.slot ?? r.at_time.slice(0, 5), at_time: r.at_time.slice(0, 5),
  command: r.command, enabled: r.enabled, last_run_at: r.last_run_at,
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
  const cur = currentSlot(list, tz);
  return {
    device_id: d.id, name: d.name, enabled: d.schedule_enabled, time_zone: tz,
    slots: list.map(view).sort((a, b) => a.day - b.day || a.at_time.localeCompare(b.at_time)),
    current: cur ? view(cur) : null,
  };
}

async function saveSchedule(deviceId: string, slots: any[]) {
  await device(deviceId);
  if (!Array.isArray(slots) || slots.length > 7 * 12) throw new Error("slots must be a list of up to 84 entries");
  const clean = slots.map((s) => {
    const day = Number(s.day);
    if (!(day >= 0 && day <= 6)) throw new Error("day must be 0 (Sunday) to 6 (Saturday)");
    if (!/^\d{1,2}:\d{2}$/.test(String(s.at_time))) throw new Error("at_time must look like 07:00");
    if (!s.command?.action) throw new Error("each slot needs a command");
    return {
      device_id: deviceId, name: String(s.slot ?? s.at_time), slot: s.slot ?? null, days: [day],
      at_time: s.at_time, time_zone: s.time_zone ?? DEFAULT_TZ, command: s.command, enabled: s.enabled ?? true,
    };
  });
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
  let applied = null;
  if (enabled && applyNow) {
    const list = await rows(deviceId);
    const cur = currentSlot(list, list[0]?.time_zone ?? DEFAULT_TZ);
    if (cur) {
      await run(d.provider, deviceId, cur.command, key);
      await db.from("home_schedules").update({ last_run_at: new Date().toISOString() }).eq("id", cur.id);
      applied = view(cur);
    }
  }
  return { ...(await getSchedule(deviceId)), applied };
}

async function tick(key: string) {
  const { data: devices, error } = await db.from("home_devices").select("id, provider").eq("schedule_enabled", true);
  if (error) throw error;
  const ran: unknown[] = [];
  for (const d of devices ?? []) {
    for (const r of await rows(d.id)) {
      if (!r.enabled || !r.days?.length) continue;
      const now = localNow(r.time_zone ?? DEFAULT_TZ);
      if (r.days[0] !== now.day) continue;
      const late = now.minutes - toMinutes(r.at_time);
      if (late < 0 || late >= DUE_WINDOW_MIN) continue;
      if (r.last_run_at && Date.now() - Date.parse(r.last_run_at) < RERUN_GUARD_MIN * 60_000) continue;
      // Mark first, so a slow appliance can't make the next tick run it again.
      await db.from("home_schedules").update({ last_run_at: new Date().toISOString() }).eq("id", r.id);
      try {
        await run(d.provider, d.id, r.command, key);
        ran.push({ device_id: d.id, slot: r.slot, ok: true });
      } catch (err) {
        ran.push({ device_id: d.id, slot: r.slot, ok: false, error: String((err as Error).message ?? err) });
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
    if (req.method === "PUT") return json(await saveSchedule(body.device_id, body.slots));
    if (body.action === "enable") return json(await setEnabled(body.device_id, !!body.enabled, !!body.apply_now, key!));
    if (body.action === "tick") return json(await tick(key!));
    return json({ error: "use GET, PUT, or POST with action enable or tick" }, 400);
  } catch (err) {
    return json({ error: String((err as Error).message ?? err) }, 502);
  }
});
