import type { Command, Device, HomeData, Schedule, ScheduleBlock } from "./types";

// Sample data shaped exactly like the home function's response, for local development.
const now = () => new Date().toISOString();

let devices: Device[] = [
  {
    id: "rheem_sample", kind: "water_heater", provider: "rheem", name: "Heat Pump Water Heater", enabled: true, recorded_at: now(),
    capabilities: { modes: ["off", "energy_saver", "heat_pump", "high_demand", "electric", "vacation"], supports_power: true, setpoint_min_f: 110, setpoint_max_f: 140 },
    state: { connected: true, power: true, mode: "energy_saver", setpoint_f: 120, running: "Running", tank_pct: 72, alert_count: 0, away: false, vacation: false },
  },
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
  return { devices, history, mock: true };
}

export function mockCommand(id: string, c: Command) {
  devices = devices.map((d) => {
    if (d.id !== id || !d.state) return d;
    const s: any = { ...d.state };
    if (c.action === "power") { s.power = c.on; if (d.kind === "water_heater") s.mode = c.on ? "energy_saver" : "off"; }
    if (c.action === "brightness") s.brightness = c.value;
    if (c.action === "color") { s.color = c.hex; s.color_temp_k = null; }
    if (c.action === "color_temp") s.color_temp_k = c.kelvin;
    if (c.action === "set_setpoint") s.setpoint_f = c.value;
    if (c.action === "set_mode") { s.mode = c.mode; s.power = c.mode !== "off"; }
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
