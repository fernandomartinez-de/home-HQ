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
export type Device = Light | Heater | AC | TV;

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
  | { action: "volume"; dir: "up" | "down" | "mute" };

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
