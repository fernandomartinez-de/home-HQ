export type LightState = {
  online: boolean | null;
  power: boolean | null;
  brightness: number | null;
  color: string | null;
  color_temp_k: number | null;
  error?: string;
};

export type LightCaps = {
  power: boolean;
  color: boolean;
  brightness: { min: number; max: number } | null;
  color_temp_k: { min: number; max: number } | null;
};

export type HeaterState = {
  connected: boolean;
  power: boolean | null;
  mode: string | null;
  setpoint_f: number | null;
  running: string | null;
  tank_pct: number | null;
  alert_count: number;
  away: boolean;
  vacation: boolean;
};

export type HeaterCaps = {
  modes: string[];
  supports_power: boolean;
  setpoint_min_f: number | null;
  setpoint_max_f: number | null;
};

type Base = { id: string; name: string; provider: string; enabled: boolean; recorded_at: string | null; room?: string | null };
export type Light = Base & { kind: "light"; state: LightState | null; capabilities: LightCaps };
export type Heater = Base & { kind: "water_heater"; state: HeaterState | null; capabilities: HeaterCaps };
export type AC = Base & { kind: "ac"; state: Record<string, unknown> | null; capabilities: Record<string, unknown> };
export type TvState = {
  online: boolean;
  screen: "on" | "off";
  app: string | null;
  app_name: string | null;
  volume: number | null;
  max_volume: number | null;
  muted: boolean | null;
  version: string | null;
};
export type TvCaps = { apps: { pkg: string; name: string }[]; actions: string[] };
export type TV = Base & { kind: "tv"; state: TvState | null; capabilities: TvCaps };
export type CameraEvent = { t: string | null; kind: string | null; person: boolean | null };
export type CameraState = {
  online: boolean;
  battery: number | null;
  on_battery: boolean;
  charging: boolean | null;
  motion_enabled: boolean;
  mode: string | null;
  wifi: string | null;
  events: CameraEvent[];
};
export type CameraCaps = { modes: string[]; battery: boolean };
export type Camera = Base & { kind: "camera"; state: CameraState | null; capabilities: CameraCaps };
export type MeterBill = { start: string; end: string; kwh: number | null; cost: number | null };
export type MeterState = {
  connected: boolean;
  bill: {
    start: string; end: string; as_of: string | null;
    kwh_so_far: number | null; cost_so_far: number | null;
    kwh_forecast: number | null; cost_forecast: number | null;
    typical_kwh: number | null; typical_cost: number | null;
  } | null;
  last_bill: MeterBill | null;
  bills: MeterBill[];
  daily: { d: string; kwh: number | null; cost: number | null }[];
  hourly: { t: string; kwh: number | null }[];
  live: { t: string; kw: number | null; today_kwh: number | null; reads: { t: string; kwh: number | null }[] } | null;
  errors?: string[];
};
export type Meter = Base & { kind: "meter"; state: MeterState | null; capabilities: { live?: boolean; cost_by_day?: boolean } };
// A plug, relay or SwitchBot Bot: on and off only. Shaped like a light so it can share the light tile.
export type Switch = Base & { kind: "switch"; state: (LightState & { mode?: string | null; battery?: number | null; watts?: number | null }) | null; capabilities: LightCaps & { press?: boolean; type?: string } };
// A smart lock (the front door, through the SwitchBot hub).
export type LockState = { online?: boolean; locked: boolean | null; lock_state: string | null; door: string | null; battery: number | null };
export type SmartLock = Base & { kind: "lock"; state: LockState | null; capabilities: { lock?: boolean; unlock?: boolean; door?: boolean; battery?: boolean } };
export type Device = Light | Heater | AC | TV | Camera | Meter | Switch | SmartLock;

// One command from the home_commands log, newest first.
export type Activity = {
  id: number;
  device_id: string;
  device_name: string;
  command: Record<string, any>;
  source: string;
  status: string;
  t: string;
};

// History tab data from home_analytics (days are calendar days in New York, "YYYY-MM-DD").
export type Analytics = {
  days: number;
  energy: { d: string; kwh: number | null; cost: number | null }[];
  lights: { d: string; room: string; hours: number }[];
  heater: { d: string; tank_avg: number | null; tank_min: number | null; heating: number | null; element: number | null; off: number | null }[];
  tv: { d: string; hours: number }[];
  camera: { camera: string; t: string; kind: string | null; person: boolean | null }[];
  activity: (Activity & { kind: string | null })[];
  mock?: boolean;
};

export type HomeData = {
  devices: Device[];
  history?: Record<string, { t: string; state: any }[]>;
  activity?: Activity[];
  mock?: boolean;
};

export type Command =
  | { action: "power"; on: boolean }
  | { action: "brightness"; value: number }
  | { action: "color"; hex: string }
  | { action: "color_temp"; kelvin: number }
  | { action: "scene"; name: string }
  | { action: "set_setpoint"; value: number }
  | { action: "set_mode"; mode: string }
  | { action: "launch"; app: string }
  | { action: "home" }
  | { action: "back" }
  | { action: "sleep" }
  | { action: "volume"; dir: "up" | "down" | "mute" }
  | { action: "lock" }
  | { action: "unlock" };

export type ScheduleBlock = {
  id?: number;
  day: number; // 0 = Sunday
  slot?: string; // Morning, Afternoon, Evening or Night, named by the start time
  start: string; // "HH:MM", 24 hour
  stop: string; // "HH:MM"; earlier than start means it runs past midnight
  command: { action: string; mode?: any; setpoint?: number; [key: string]: any };
};

export type Schedule = {
  device_id: string;
  name: string;
  enabled: boolean;
  time_zone: string;
  blocks: ScheduleBlock[];
  active: ScheduleBlock | null;
  next: ScheduleBlock | null;
  mock?: boolean;
};
