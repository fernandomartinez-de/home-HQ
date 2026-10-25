// tv-dashboard: everything the TV dashboard shows, in one response.
//   whoop      recovery, sleep, strain (whoop_* tables)
//   calendar   personal Google Calendar (iCal link) merged with work events (work_calendar_events)
//   portfolio  stock and crypto holdings from stocks_crypto_history, priced live
//   fitness    today's planned workout (training_plan) and body composition trend
//   nutrition  today's calories burned (whoop_cycles) vs eaten (nutrition_log)
//   gmail      unread count in the Gmail inbox (tv_metrics, pushed by an Apps Script)
//   trains     next subway departures at the configured stop (MTA realtime)
//   settings   location, time zone, trips and station label for the page
// Personal settings live in the private table tv_config, not in this file.
// Access: the caller sends header x-tv-key; only its SHA-256 is stored (tv_config.tv_key_sha256).
// Secrets: GCAL_ICS_URL, plus SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (provided to every function).
import { createClient } from "npm:@supabase/supabase-js@2";
import ICAL from "npm:ical.js@2.1.0";
import GtfsRealtimeBindings from "npm:gtfs-realtime-bindings@1.1.1";

const DAYS_AHEAD = 3;
let TZ = "America/New_York"; // replaced by tv_config.timezone on each request
const db = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type Config = {
  tv_key_sha256: string;
  timezone?: string;
  location?: { lat: number; lon: number };
  trips?: { name: string; start: string; end: string }[];
  subway?: { stop_id: string; name: string; label?: string; routes: string[]; manhattan_next_stop: string; feeds: string[] };
  quote_symbols?: Record<string, string>;
};

async function loadConfig(): Promise<Config> {
  const { data, error } = await db().from("tv_config").select("config").eq("id", 1).single();
  if (error || !data) throw new Error("tv_config missing");
  return data.config as Config;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-tv-key, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Midnight today in the configured time zone, as a UTC Date.
function startOfToday(): Date {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const localAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offset = localAsUtc - now.getTime(); // local minus UTC, in ms
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - offset);
}

async function whoop() {
  const sb = db();
  const [rec, cyc, slp, wk] = await Promise.all([
    sb.from("whoop_recovery")
      .select("recovery_date,recovery_score,hrv_rmssd_milli,resting_heart_rate,spo2_percentage")
      .not("recovery_score", "is", null)
      .order("recovery_date", { ascending: false }).limit(7),
    sb.from("whoop_cycles").select("start_time,strain,calories_kcal")
      .order("start_time", { ascending: false }).limit(2),
    sb.from("whoop_sleep")
      .select("start_time,end_time,duration_minutes,performance_percentage,sleep_efficiency_percentage,rem_sleep_minutes,slow_wave_sleep_minutes")
      .gte("duration_minutes", 180)
      .order("end_time", { ascending: false }).limit(1),
    sb.from("whoop_workouts").select("start_time,sport_name,strain,calories_kcal")
      .order("start_time", { ascending: false }).limit(1),
  ]);
  const r = rec.data ?? [];
  return {
    recovery: r[0] ?? null,
    recoveryTrend: r.slice().reverse().map((x) => ({ date: x.recovery_date, score: x.recovery_score })),
    today: cyc.data?.[0] ?? null,
    yesterday: cyc.data?.[1] ?? null,
    sleep: slp.data?.[0] ?? null,
    lastWorkout: wk.data?.[0] ?? null,
  };
}

// ---------- Portfolio ----------
// Asset names map to market symbols through tv_config.quote_symbols (e.g. Bitcoin -> BTC-USD);
// anything not listed is used as the symbol itself (AAPL, NVDA, ...).
let SYMBOLS: Record<string, string> = {};

async function quote(symbol: string) {
  // Daily closes for the last month plus the live price and previous close.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 tv-dashboard" } });
  if (!r.ok) throw new Error(`quote ${symbol} ${r.status}`);
  const j = await r.json();
  const res = j.chart.result[0];
  const meta = res.meta;
  const ts: number[] = res.timestamp ?? [];
  const closes: (number | null)[] = res.indicators.quote[0].close ?? [];
  const series = ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] }))
    .filter((p) => p.close != null) as { date: string; close: number }[];
  // The last bar is the latest trading day (today while the market is open), so the
  // day over day reference is the close of the bar before it.
  const prevClose = series.length > 1 ? series[series.length - 2].close : (meta.chartPreviousClose as number);
  return { price: meta.regularMarketPrice as number, prevClose, series };
}

async function portfolio() {
  // Stocks and crypto only (retirement accounts and home equity are left out on purpose).
  const sb = db();
  const sc = await sb.from("stocks_crypto_history").select("snapshot_date,asset_type,asset_name,quantity,total_value,cost_basis")
    .in("asset_type", ["Stock", "Crypto"]).order("snapshot_date", { ascending: false }).limit(200);

  // Latest snapshot of each holding
  const latest = new Map<string, any>();
  for (const r of sc.data ?? []) if (!latest.has(r.asset_name)) latest.set(r.asset_name, r);

  const holdings: any[] = [];
  const perAsset: { qty: number; closes: Record<string, number> }[] = [];
  await Promise.all([...latest.values()].map(async (r) => {
    const qty = Number(r.quantity) || 0;
    const symbol = SYMBOLS[r.asset_name] ?? r.asset_name;
    let value = Number(r.total_value) || 0, change = 0, live = false;
    try {
      const q = await quote(symbol);
      value = qty * q.price;
      change = qty * (q.price - q.prevClose);
      live = true;
      const closes: Record<string, number> = {};
      for (const p of q.series) closes[p.date] = p.close;
      perAsset.push({ qty, closes });
    } catch (_) { /* keep the snapshot value */ }
    holdings.push({ name: r.asset_name, type: r.asset_type, value, change, changePct: value - change > 0 ? (change / (value - change)) * 100 : 0, costBasis: Number(r.cost_basis) || 0, live });
  }));

  // Daily total: each holding carries its last close forward over days it has no price (weekends for stocks).
  const allDates = new Set<string>();
  for (const a of perAsset) Object.keys(a.closes).forEach((d) => allDates.add(d));
  const dailyTotals: Record<string, number> = {};
  const lastClose = perAsset.map(() => null as number | null);
  for (const d of [...allDates].sort()) {
    perAsset.forEach((a, i) => { if (a.closes[d] != null) lastClose[i] = a.closes[d]; });
    if (lastClose.some((c) => c == null)) continue; // wait until every holding has a price
    dailyTotals[d] = perAsset.reduce((s, a, i) => s + a.qty * (lastClose[i] as number), 0);
  }

  holdings.sort((a, b) => b.value - a.value);
  const total = holdings.reduce((s, h) => s + h.value, 0);
  const change = holdings.reduce((s, h) => s + h.change, 0);
  const series = Object.keys(dailyTotals).sort().map((d) => ({ date: d, total: Math.round(dailyTotals[d]) }));
  return { total, change, changePct: total - change > 0 ? (change / (total - change)) * 100 : 0, holdings, series };
}

// ---------- Fitness: today's planned workout and body composition ----------
async function fitness() {
  const sb = db();
  const dow = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date());
  const since = new Date(Date.now() - 120 * 86400000).toISOString();
  const [plan, body, last] = await Promise.all([
    sb.from("training_plan").select("dow,training_type,load,notes").eq("dow", dow).maybeSingle(),
    sb.from("body_composition").select("measured_at,weight_kg,body_fat_pct,muscle_mass_kg")
      .gte("measured_at", since).order("measured_at", { ascending: true }),
    sb.from("whoop_workouts").select("start_time,sport_name,strain").order("start_time", { ascending: false }).limit(1),
  ]);
  // One reading per day (the scale often records twice)
  const byDay = new Map<string, any>();
  for (const r of body.data ?? []) {
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(r.measured_at));
    byDay.set(d, { date: d, weight: Number(r.weight_kg), fat: Number(r.body_fat_pct), muscle: Number(r.muscle_mass_kg) });
  }
  const series = [...byDay.values()];
  return {
    today: plan.data ?? null,
    lastWorkout: last.data?.[0] ?? null,
    body: series.length ? { latest: series[series.length - 1], first: series[0], series } : null,
  };
}

// ---------- Calorie balance today: burned (WHOOP) vs eaten (nutrition_log), like Luna's nutrition page ----------
async function nutrition() {
  const sb = db();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const start = startOfToday();
  const [meals, cyc] = await Promise.all([
    sb.from("nutrition_log").select("calories_kcal").eq("logged_date", today),
    sb.from("whoop_cycles").select("start_time,end_time,calories_kcal").order("start_time", { ascending: false }).limit(1),
  ]);
  if (meals.error) throw meals.error;
  const rows = meals.data ?? [];
  const eaten = Math.round(rows.reduce((a, r) => a + Number(r.calories_kcal || 0), 0));
  // A WHOOP cycle runs sleep to sleep, so today's starts with last night's sleep (after 6 pm yesterday)
  const c = cyc.data?.[0];
  const current = c && c.calories_kcal != null && new Date(c.start_time).getTime() >= start.getTime() - 6 * 3600000;
  return { date: today, burned: current ? Math.round(Number(c.calories_kcal)) : null, eaten, meals: rows.length };
}

// ---------- Gmail: unread inbox count, pushed every few minutes by an Apps Script (docs/gmail.md) ----------
async function gmail() {
  const { data, error } = await db().from("tv_metrics").select("value,updated_at").eq("name", "gmail_unread").maybeSingle();
  if (error) throw error;
  return data ? { unread: Number(data.value), updatedAt: data.updated_at } : null;
}

// ---------- Subway: next departures at the configured stop (MTA realtime, no key needed) ----------
async function trains(cfg: NonNullable<Config["subway"]>) {
  const now = Date.now() / 1000;
  const out: { route: string; to: string; mins: number }[] = [];
  await Promise.all(cfg.feeds.map(async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`mta ${r.status}`);
    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(await r.arrayBuffer()));
    for (const ent of feed.entity) {
      const tu = ent.tripUpdate;
      if (!tu) continue;
      const route = tu.trip?.routeId ?? "";
      if (!cfg.routes.includes(route)) continue;
      const stus = tu.stopTimeUpdate ?? [];
      const i = stus.findIndex((u: any) => (u.stopId ?? "").startsWith(cfg.stop_id));
      if (i < 0) continue;
      const u = stus[i];
      const raw: any = u.departure?.time ?? u.arrival?.time;
      const t = raw == null ? 0 : typeof raw === "object" && raw.toNumber ? raw.toNumber() : Number(raw); // protobuf Long
      if (!t || t < now - 30) continue;
      // Direction comes from the next stop on the trip.
      const next = stus[i + 1]?.stopId ?? "";
      const to = next ? (next.startsWith(cfg.manhattan_next_stop) ? "Manhattan" : "Brooklyn") : ((u.stopId ?? "").endsWith("S") ? "Manhattan" : "Brooklyn");
      out.push({ route, to, mins: Math.max(0, Math.round((t - now) / 60)) });
    }
  }));
  out.sort((a, b) => a.mins - b.mins);
  const pick = (to: string) => out.filter((x) => x.to === to).slice(0, 3);
  return { station: cfg.name, label: cfg.label ?? cfg.routes.join(" "), manhattan: pick("Manhattan"), brooklyn: pick("Brooklyn") };
}

type Ev = { title: string; start: string; end: string; allDay: boolean; location?: string; source?: string };

// Work events, pushed every 30 minutes by a Power Automate flow (see docs/power-automate.md).
async function workCalendar(): Promise<Ev[]> {
  const sb = db();
  const winStart = startOfToday();
  const winEnd = new Date(winStart.getTime() + DAYS_AHEAD * 86400000);
  const { data } = await sb.from("work_calendar_events").select("start_time,end_time,title,all_day")
    .lt("start_time", winEnd.toISOString()).gt("end_time", winStart.toISOString()).order("start_time");
  const seen = new Set<string>();
  const out: Ev[] = [];
  for (const r of data ?? []) {
    const k = r.title + r.start_time;
    if (seen.has(k)) continue; // the same meeting can appear twice (forwarded copies)
    seen.add(k);
    out.push(r.all_day
      ? { title: r.title, start: r.start_time.slice(0, 10), end: r.end_time.slice(0, 10), allDay: true, source: "work" }
      : { title: r.title, start: new Date(r.start_time).toISOString(), end: new Date(r.end_time).toISOString(), allDay: false, source: "work" });
  }
  return out;
}

async function calendar(): Promise<Ev[] | { error: string }> {
  const url = Deno.env.get("GCAL_ICS_URL");
  if (!url) return { error: "GCAL_ICS_URL secret is not set" };
  const res = await fetch(url);
  if (!res.ok) return { error: `calendar fetch ${res.status}` };
  const root = new ICAL.Component(ICAL.parse(await res.text()));
  for (const tz of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tz);

  const winStart = startOfToday();
  const winEnd = new Date(winStart.getTime() + DAYS_AHEAD * 86400000);

  const events = root.getAllSubcomponents("vevent").map((v: unknown) => new ICAL.Event(v));
  const masters: any[] = [];
  const exceptions: any[] = [];
  for (const e of events) {
    if (e.isRecurrenceException()) exceptions.push(e);
    else masters.push(e);
  }
  // Moved or edited single occurrences of a recurring event attach to their series.
  const byUid = new Map<string, any>();
  for (const e of masters) if (!byUid.has(e.uid)) byUid.set(e.uid, e);
  for (const x of exceptions) byUid.get(x.uid)?.relateException(x);

  const out: Ev[] = [];
  const push = (summary: string, s: any, e: any, loc?: string, status?: string) => {
    if (status === "CANCELLED") return;
    const allDay = !!s.isDate;
    const sd: Date = s.toJSDate();
    const ed: Date = e ? e.toJSDate() : sd;
    if (allDay) {
      // compare dates as local calendar days
      const sStr = s.toString(); // YYYY-MM-DD
      const eStr = e ? e.toString() : sStr;
      const first = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(winStart);
      const last = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(winEnd.getTime() - 1));
      if (eStr <= first && sStr < first) return;
      if (sStr > last) return;
      out.push({ title: summary, start: sStr, end: eStr, allDay, location: loc });
      return;
    }
    if (ed <= winStart || sd >= winEnd) return;
    out.push({ title: summary, start: sd.toISOString(), end: ed.toISOString(), allDay, location: loc });
  };

  for (const ev of masters) {
    const status = ev.component.getFirstPropertyValue("status");
    if (!ev.isRecurring()) {
      push(ev.summary, ev.startDate, ev.endDate, ev.location, status);
      continue;
    }
    const it = ev.iterator();
    let next: any;
    let guard = 0;
    while ((next = it.next()) && guard++ < 20000) {
      const d = ev.getOccurrenceDetails(next);
      if (d.startDate.toJSDate() >= winEnd) break;
      const st = d.item.component.getFirstPropertyValue("status");
      push(d.item.summary, d.startDate, d.endDate, d.item.location, st);
    }
  }
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  let cfg: Config;
  try { cfg = await loadConfig(); } catch (e) { return json({ error: String(e) }, 500); }
  const key = req.headers.get("x-tv-key") ?? "";
  if (!key || (await sha256(key)) !== cfg.tv_key_sha256) return json({ error: "unauthorized" }, 401);
  TZ = cfg.timezone ?? TZ;
  SYMBOLS = cfg.quote_symbols ?? {};

  const [w, c, p, wk, f, t, n, g] = await Promise.allSettled([
    whoop(), calendar(), portfolio(), workCalendar(), fitness(),
    cfg.subway ? trains(cfg.subway) : Promise.resolve(null), nutrition(), gmail(),
  ]);
  // One calendar list: personal and work, sorted by start.
  let cal: any = c.status === "fulfilled" ? c.value : { error: String(c.reason) };
  const work = wk.status === "fulfilled" ? wk.value : [];
  if (Array.isArray(cal)) cal = cal.map((e) => ({ ...e, source: "personal" })).concat(work);
  else if (work.length) cal = work;
  if (Array.isArray(cal)) cal.sort((a: Ev, b: Ev) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return json({
    generatedAt: new Date().toISOString(),
    settings: { timezone: TZ, location: cfg.location ?? null, trips: cfg.trips ?? [] },
    whoop: w.status === "fulfilled" ? w.value : { error: String(w.reason) },
    calendar: cal,
    portfolio: p.status === "fulfilled" ? p.value : { error: String(p.reason) },
    fitness: f.status === "fulfilled" ? f.value : { error: String(f.reason) },
    trains: t.status === "fulfilled" ? t.value : { error: String(t.reason) },
    nutrition: n.status === "fulfilled" ? n.value : { error: String(n.reason) },
    gmail: g.status === "fulfilled" ? g.value : { error: String(g.reason) },
  });
});
