import type { Command, Device, HomeData, Schedule, ScheduleBlock } from "./types";

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
  light("govee_floor", "Floor Lamp", { online: true, power: true, brightness: 70, color: "#ffb15e", color_temp_k: 2200 }, "Living room"),
  light("govee_strip", "Kitchen Strip Light", { online: true, power: false, brightness: 80, color: "#ff6804", color_temp_k: null }, "Kitchen"),
  light("govee_kl", "Kitchen Left", { online: true, power: true, brightness: 40, color: "#ffb969", color_temp_k: 3000 }, "Kitchen"),
  light("govee_km", "Kitchen Middle", { online: true, power: true, brightness: 40, color: "#ffb969", color_temp_k: 3000 }, "Kitchen"),
  light("govee_kr", "Kitchen Right", { online: false, power: true, brightness: 1, color: "#ffb969", color_temp_k: 3000 }, "Kitchen"),
  light("govee_closet", "Closet", { online: false, power: true, brightness: 100, color: "#ff001c", color_temp_k: null }, "Bedroom"),
  light("govee_tv", "TV Backlight", { online: true, power: true, brightness: 55, color: "#5b6cff", color_temp_k: null }, "Living room"),
];

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
