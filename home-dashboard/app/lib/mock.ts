import type { Command, Device, HomeData, Schedule, ScheduleSlot } from "./types";

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

const SLOT_NAMES = ["Morning", "Day", "Evening", "Night"];
const SLOT_TIMES = ["07:00", "12:00", "18:00", "23:00"];
let schedule: ScheduleSlot[] = [0, 1, 2, 3, 4, 5, 6].flatMap((day) =>
  SLOT_NAMES.map((slot, i) => ({
    day, slot, at_time: SLOT_TIMES[i],
    command: { action: "set_state", mode: i % 2 === 0 ? "heat_pump" : "off", setpoint: day === 4 ? 140 : 135 },
  })),
);
let scheduleOn = false;

export function mockSchedule(deviceId: string): Schedule {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const today = schedule.filter((s) => s.day === now.getDay())
    .filter((s) => { const [h, m] = s.at_time.split(":").map(Number); return h * 60 + m <= mins; });
  return {
    device_id: deviceId, name: "Heat Pump Water Heater", enabled: scheduleOn, time_zone: "America/New_York",
    slots: schedule, current: today.at(-1) ?? null, mock: true,
  };
}

export function mockSaveSchedule(deviceId: string, slots: ScheduleSlot[]) {
  schedule = slots;
  return mockSchedule(deviceId);
}

export function mockEnableSchedule(deviceId: string, enabled: boolean) {
  scheduleOn = enabled;
  return mockSchedule(deviceId);
}
