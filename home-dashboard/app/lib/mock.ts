import type { Analytics, Command, Device, HomeData, Schedule, ScheduleBlock } from "./types";

// Sample data shaped exactly like the home function's response, for local development.
const now = () => new Date().toISOString();

let devices: Device[] = [
  {
    id: "rheem_sample", kind: "water_heater", provider: "rheem", name: "Heat Pump Water Heater", enabled: true, recorded_at: now(),
    capabilities: { modes: ["off", "energy_saver", "heat_pump", "high_demand", "electric", "vacation"], supports_power: true, setpoint_min_f: 110, setpoint_max_f: 140 },
    state: { connected: true, power: true, mode: "energy_saver", setpoint_f: 120, running: "Running", tank_pct: 72, alert_count: 0, away: false, vacation: false },
  },
  {
    id: "tv", kind: "tv", provider: "tv", name: "Living Room TV", room: "Living room", enabled: true, recorded_at: now(),
    capabilities: { apps: [
      { pkg: "com.netflix.ninja", name: "Netflix" }, { pkg: "com.amazon.firetv.youtube", name: "YouTube" },
      { pkg: "com.amazon.firebat", name: "Prime Video" }, { pkg: "com.hbo.hbonow", name: "HBO Max" },
      { pkg: "com.disney.disneyplus", name: "Disney+" }, { pkg: "com.spotify.tv.android", name: "Spotify" },
    ], actions: ["launch", "home", "back", "volume", "sleep"] },
    state: { online: true, screen: "on", app: "com.netflix.ninja", app_name: "Netflix", volume: 12, max_volume: 30, muted: false, version: "1.0" },
  },
  ...(process.env.HOME_MOCK_NO_RING ? [] : [{
    id: "ring_1", kind: "camera", provider: "ring", name: "Living Room", room: "Living room", enabled: true, recorded_at: now(),
    capabilities: { modes: ["disarmed", "home", "away"], battery: false },
    state: { online: true, battery: null, on_battery: false, charging: null, motion_enabled: true, mode: "home", wifi: null,
      events: [
        { t: new Date(Date.now() - 22 * 60_000).toISOString(), kind: "motion", person: true },
        { t: new Date(Date.now() - 135 * 60_000).toISOString(), kind: "motion", person: null },
        { t: new Date(Date.now() - 410 * 60_000).toISOString(), kind: "on_demand", person: null },
      ] },
  } as Device]),
  ...(process.env.HOME_MOCK_NO_CONED ? [] : [mockMeter()]),
  light("govee_floor", "Floor Lamp", { online: true, power: true, brightness: 70, color: "#ffb15e", color_temp_k: 2200 }, "Living room"),
  light("govee_strip", "Kitchen Strip Light", { online: true, power: false, brightness: 80, color: "#ff6804", color_temp_k: null }, "Kitchen"),
  light("govee_kl", "Kitchen Left", { online: true, power: true, brightness: 40, color: "#ffb969", color_temp_k: 3000 }, "Kitchen"),
  light("govee_km", "Kitchen Middle", { online: true, power: true, brightness: 40, color: "#ffb969", color_temp_k: 3000 }, "Kitchen"),
  light("govee_kr", "Kitchen Right", { online: false, power: true, brightness: 1, color: "#ffb969", color_temp_k: 3000 }, "Kitchen"),
  light("govee_closet", "Closet", { online: false, power: true, brightness: 100, color: "#ff001c", color_temp_k: null }, "Bedroom"),
  light("govee_tv", "TV Backlight", { online: true, power: true, brightness: 55, color: "#5b6cff", color_temp_k: null }, "Living room"),
];

// A sample Con Edison meter shaped like a real account: a cycle that just started (no cost so far or
// forecast yet), the previous cycle's bill not posted, daily kWh without cost, and no live reads.
function mockMeter(): Device {
  const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
  const daily = Array.from({ length: 35 }, (_, i) => {
    const n = 35 - i, wd = new Date(Date.now() - n * 86400_000).getDay();
    const kwh = Math.round((6.4 + 1.6 * Math.sin(i / 3) + (wd === 0 || wd === 6 ? 1.8 : 0)) * 100) / 100;
    return { d: day(n), kwh, cost: null };
  });
  return {
    id: "coned_electric", kind: "meter", provider: "coned", name: "Con Edison", enabled: true, recorded_at: new Date(Date.now() - 40 * 60_000).toISOString(),
    capabilities: { live: false, cost_by_day: false },
    state: {
      connected: true,
      bill: { start: day(0), end: day(-31), as_of: day(-1), kwh_so_far: 0, cost_so_far: null, kwh_forecast: null, cost_forecast: null, typical_kwh: 422, typical_cost: null },
      last_bill: { start: day(60), end: day(30), kwh: 222, cost: 97.08 },
      bills: [{ start: day(60), end: day(30), kwh: 222, cost: 97.08 }, { start: day(365), end: day(332), kwh: 464, cost: 182.06 }],
      daily, live: null,
      // Two full days of hourly reads ending last midnight: a standby floor, a morning bump and an evening peak.
      hourly: Array.from({ length: 48 }, (_, i) => {
        const end = new Date(); end.setHours(0, 0, 0, 0);
        const t = new Date(end.getTime() - (48 - i) * 3600_000), h = t.getHours();
        const kwh = 0.14 + (h >= 7 && h < 9 ? 0.25 : 0) + (h >= 18 && h < 23 ? 0.45 + 0.15 * Math.sin(h) : 0) + (h >= 12 && h < 16 ? 0.08 : 0);
        return { t: t.toISOString(), kwh: Math.round(kwh * 1000) / 1000 };
      }),
    },
  } as Device;
}

function light(id: string, name: string, state: any, room: string): Device {
  return {
    id, kind: "light", provider: "govee", name, room, enabled: true, recorded_at: now(), state,
    capabilities: { power: true, color: true, brightness: { min: 1, max: 100 }, color_temp_k: { min: 2200, max: 6500 } },
  };
}

export function mockData(): HomeData {
  const heater = devices.find((d) => d.kind === "water_heater")!;
  const history = {
    [heater.id]: Array.from({ length: 48 }, (_, i) => ({
      t: new Date(Date.now() - (47 - i) * 30 * 60_000).toISOString(),
      state: { ...heater.state, tank_pct: Math.round(55 + 40 * Math.abs(Math.sin(i / 7))) },
    })),
  };
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const activity = [
    { id: 5, device_id: "govee_kl", device_name: "Kitchen Left", command: { action: "brightness", value: 40 }, source: "ui", status: "done", t: ago(35) },
    { id: 4, device_id: "govee_tv", device_name: "TV Backlight", command: { action: "color", hex: "#5b6cff" }, source: "ui", status: "done", t: ago(95) },
    { id: 3, device_id: "rheem_sample", device_name: "Heat Pump Water Heater", command: { action: "set_state", setpoint: 135 }, source: "schedule", status: "done", t: ago(240) },
    { id: 2, device_id: "govee_floor", device_name: "Floor Lamp", command: { action: "power", on: true }, source: "ui", status: "done", t: ago(300) },
    { id: 1, device_id: "rheem_sample", device_name: "Heat Pump Water Heater", command: { action: "set_state", setpoint: 135 }, source: "schedule", status: "done", t: ago(900) },
  ];
  return { devices, history, activity, mock: true };
}

export function mockCommand(id: string, c: Command) {
  devices = devices.map((d) => {
    if (d.id !== id || !d.state) return d;
    const s: any = { ...d.state };
    if (c.action === "power") { s.power = c.on; if (d.kind === "water_heater") s.mode = c.on ? "energy_saver" : "off"; }
    if (c.action === "brightness") s.brightness = c.value;
    if (c.action === "color") { s.color = c.hex; s.color_temp_k = null; }
    if (c.action === "color_temp") s.color_temp_k = c.kelvin;
    if (c.action === "scene") s.power = true;
    if (c.action === "set_setpoint") s.setpoint_f = c.value;
    if (c.action === "set_mode") { s.mode = c.mode; if (d.kind === "water_heater") s.power = c.mode !== "off"; }
    if (c.action === "launch") { s.app = c.app; s.app_name = (d.capabilities as any).apps?.find((a: any) => a.pkg === c.app)?.name ?? c.app; }
    if (c.action === "home") { s.app = "app.tvdashboard"; s.app_name = "Dashboard"; }
    if (c.action === "sleep") s.screen = "off";
    if (c.action === "volume" && typeof s.volume === "number") {
      if (c.dir === "mute") s.muted = !s.muted;
      else s.volume = Math.max(0, Math.min(s.max_volume ?? 30, s.volume + (c.dir === "up" ? 1 : -1)));
    }
    return { ...d, state: s } as Device;
  });
  return { ok: true, mock: true };
}

// ---------- sample schedule ----------

let blocks: ScheduleBlock[] = [0, 1, 2, 3, 4, 5, 6].flatMap((day) => [
  { day, slot: "Morning", start: "07:00", stop: "12:00", command: { action: "set_state", mode: "heat_pump", setpoint: day === 4 ? 140 : 135 } },
  { day, slot: "Evening", start: "18:00", stop: "23:00", command: { action: "set_state", mode: day === 0 ? "energy_saver" : "heat_pump", setpoint: day === 4 ? 140 : 135 } },
]);
let scheduleOn = false;

export function mockSchedule(deviceId: string): Schedule {
  const now = new Date();
  const nowW = now.getDay() * 1440 + now.getHours() * 60 + now.getMinutes();
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const since = (a: number, b: number) => ((a - b) % 10080 + 10080) % 10080;
  const startW = (b: ScheduleBlock) => b.day * 1440 + m(b.start);
  const dur = (b: ScheduleBlock) => (m(b.stop) > m(b.start) ? m(b.stop) - m(b.start) : m(b.stop) + 1440 - m(b.start));
  const active = blocks.find((b) => since(nowW, startW(b)) < dur(b)) ?? null;
  const next = [...blocks].sort((a, b) => since(startW(a), nowW) - since(startW(b), nowW)).find((b) => b !== active) ?? null;
  return { device_id: deviceId, name: "Heat Pump Water Heater", enabled: scheduleOn, time_zone: "America/New_York", blocks, active, next, mock: true };
}

export function mockSaveSchedule(deviceId: string, next: ScheduleBlock[]) {
  blocks = next;
  return mockSchedule(deviceId);
}

export function mockEnableSchedule(deviceId: string, enabled: boolean) {
  scheduleOn = enabled;
  return mockSchedule(deviceId);
}

// A drawn stand in for a camera snapshot.
export function mockSnapshot() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<defs><radialGradient id="a" cx="22%" cy="62%" r="45%"><stop offset="0" stop-color="#f59e0b" stop-opacity=".6"/><stop offset="1" stop-color="#f59e0b" stop-opacity="0"/></radialGradient>
<radialGradient id="b" cx="78%" cy="70%" r="35%"><stop offset="0" stop-color="#6366f1" stop-opacity=".5"/><stop offset="1" stop-color="#6366f1" stop-opacity="0"/></radialGradient>
<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b231d"/><stop offset="1" stop-color="#0f0c0a"/></linearGradient></defs>
<rect width="640" height="360" fill="url(#g)"/><rect width="640" height="360" fill="url(#a)"/><rect width="640" height="360" fill="url(#b)"/>
<rect x="51" y="230" width="538" height="80" rx="28" fill="#3a2e25" opacity=".85"/><rect x="90" y="200" width="100" height="50" rx="12" fill="#4a3a2e"/>
<rect x="420" y="65" width="190" height="120" rx="6" fill="#000" opacity=".7"/></svg>`;
  return { image: new TextEncoder().encode(svg).buffer as ArrayBuffer, takenMs: Date.now() - 60_000, svg: true };
}

// Sample History tab data: a year of daily kWh with a summer peak, a week of lights, water heater and
// TV, a few camera events and commands.
export function mockAnalytics(days = 14): Analytics {
  const day = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
  const energy = Array.from({ length: 395 }, (_, i) => {
    const n = 395 - i, dt = new Date(Date.now() - n * 86400_000);
    const season = 1 + 0.9 * Math.max(0, Math.cos(((dt.getMonth() - 6.5) / 12) * 2 * Math.PI)) + 0.6 * Math.max(0, Math.cos(((dt.getMonth() - 0.5) / 12) * 2 * Math.PI));
    const weekend = dt.getDay() === 0 || dt.getDay() === 6 ? 1.6 : 0;
    return { d: day(n), kwh: Math.round((5.4 * season + weekend + 1.2 * Math.sin(i / 2.3)) * 100) / 100, cost: null };
  });
  const span = Math.min(days, 14);
  const lights = Array.from({ length: span }, (_, i) => day(span - 1 - i)).flatMap((d, i) => [
    { d, room: "Kitchen", hours: Math.round((4 + 2.5 * Math.abs(Math.sin(i))) * 100) / 100 },
    { d, room: "Living room", hours: Math.round((4.5 + 2 * Math.abs(Math.cos(i))) * 100) / 100 },
    { d, room: "Bedroom", hours: Math.round((0.3 + 0.4 * Math.abs(Math.sin(i * 2))) * 100) / 100 },
  ]);
  const heater = Array.from({ length: span }, (_, i) => ({ d: day(span - 1 - i), tank_avg: 88 + (i % 3) * 4, tank_min: 62 + (i % 4) * 6, heating: Math.round((1.2 + Math.abs(Math.sin(i)) * 1.3) * 100) / 100, element: 0.25 + (i % 2) * 0.1, off: 18 }));
  const tv = Array.from({ length: span }, (_, i) => ({ d: day(span - 1 - i), hours: Math.round((1.5 + 3 * Math.abs(Math.sin(i * 1.7))) * 100) / 100 }));
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const camera = [22, 135, 410, 900, 1600, 2300, 3100].map((m, i) => ({ camera: "Living Room", t: at(m), kind: i === 2 ? "on_demand" : "motion", person: i % 3 === 0 ? true : null }));
  const act = (id: number, min: number, device_id: string, device_name: string, kind: string, command: Record<string, unknown>, source = "ui") =>
    ({ id, device_id, device_name, kind, command, source, status: "done", t: at(min) });
  const activity = [
    act(20, 30, "tv", "Living Room TV", "tv", { action: "volume", dir: "down" }), act(19, 30.1, "tv", "Living Room TV", "tv", { action: "volume", dir: "down" }),
    act(18, 30.2, "tv", "Living Room TV", "tv", { action: "volume", dir: "down" }),
    act(17, 95, "govee_kl", "Kitchen Left", "light", { action: "power", on: false }), act(16, 95, "govee_km", "Kitchen Middle", "light", { action: "power", on: false }),
    act(15, 95, "govee_kr", "Kitchen Right", "light", { action: "power", on: false }),
    act(14, 240, "rheem_sample", "Heat Pump Water Heater", "water_heater", { action: "set_state", mode: "off" }, "schedule"),
    act(13, 380, "tv", "Living Room TV", "tv", { action: "launch", app: "com.netflix.ninja" }),
    act(12, 400, "govee_floor", "Floor Lamp", "light", { action: "brightness", value: 40 }),
    act(11, 900, "rheem_sample", "Heat Pump Water Heater", "water_heater", { action: "set_state", mode: "energy_saver", setpoint: 135 }, "schedule"),
    act(10, 1500, "govee_tv", "TV Backlight", "light", { action: "color", hex: "#5b6cff" }),
  ];
  return { days, energy, lights, heater, tv, camera, activity, mock: true };
}
