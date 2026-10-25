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

type Base = { id: string; name: string; provider: string; enabled: boolean; recorded_at: string | null };
export type Light = Base & { kind: "light"; state: LightState | null; capabilities: LightCaps };
export type Heater = Base & { kind: "water_heater"; state: HeaterState | null; capabilities: HeaterCaps };
export type AC = Base & { kind: "ac"; state: Record<string, unknown> | null; capabilities: Record<string, unknown> };
export type Device = Light | Heater | AC;

export type HomeData = { devices: Device[]; history?: Record<string, { t: string; state: any }[]>; mock?: boolean };

export type Command =
  | { action: "power"; on: boolean }
  | { action: "brightness"; value: number }
  | { action: "color"; hex: string }
  | { action: "color_temp"; kelvin: number }
  | { action: "set_setpoint"; value: number }
  | { action: "set_mode"; mode: string };
