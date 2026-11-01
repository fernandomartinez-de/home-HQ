import "server-only";
import type { Command, HomeData, Schedule, ScheduleBlock } from "./types";
import { mockData, mockCommand, mockSchedule, mockSaveSchedule, mockEnableSchedule, mockSnapshot } from "./mock";

const useMock = () => process.env.HOME_MOCK === "1" || !process.env.SUPABASE_URL || !process.env.HOME_API_KEY;

// Accept the project URL in the forms people tend to paste: with a trailing slash, with
// /functions/v1 or /rest/v1 on the end, or the Supabase dashboard address for the project.
function baseUrl() {
  const raw = (process.env.SUPABASE_URL ?? "").trim().replace(/^["']|["']$/g, "");
  const dash = raw.match(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (dash) return `https://${dash[1].toLowerCase()}.supabase.co`;
  const ref = raw.match(/^(?:https?:\/\/)?([a-z0-9]+)\.supabase\.co/i);
  if (ref) return `https://${ref[1].toLowerCase()}.supabase.co`;
  if (/^[a-z0-9]{20}$/i.test(raw)) return `https://${raw.toLowerCase()}.supabase.co`; // bare project ref
  return raw.replace(/\/+$/, "").replace(/\/(functions|rest)\/v1$/, "");
}

// Raw response from a function (for images); the caller checks status.
async function callRaw(path: string, init?: RequestInit) {
  return fetch(`${baseUrl()}/functions/v1/${path}`, {
    ...init,
    headers: { "x-home-key": (process.env.HOME_API_KEY ?? "").trim(), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
}

async function call(path: string, init?: RequestInit) {
  const url = `${baseUrl()}/functions/v1/${path}`;
  const r = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", "x-home-key": (process.env.HOME_API_KEY ?? "").trim(), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = body.error ?? body.message ?? body.msg;
    throw new Error(`${detail ?? `HTTP ${r.status}`} (from ${new URL(url).host})`);
  }
  return body;
}

export async function getHome(historyHours = 24): Promise<HomeData> {
  if (useMock()) return mockData();
  return call(`home?history=${historyHours}`);
}

export async function refreshHome(): Promise<HomeData> {
  if (useMock()) return mockData();
  const body = await call("home", { method: "POST", body: JSON.stringify({ action: "refresh" }) });
  return { devices: body.devices };
}

const PROVIDERS = new Set(["rheem", "govee", "ac", "tv", "ring"]);

export async function sendCommand(provider: string, deviceId: string, command: Command) {
  if (!PROVIDERS.has(provider)) throw new Error("unknown appliance");
  if (useMock()) return mockCommand(deviceId, command);
  return call(provider, { method: "POST", body: JSON.stringify({ action: "command", device_id: deviceId, command, source: "ui" }) });
}

export async function getSchedule(deviceId: string): Promise<Schedule> {
  if (useMock()) return mockSchedule(deviceId);
  return call(`schedules?device_id=${encodeURIComponent(deviceId)}`);
}

export async function saveSchedule(deviceId: string, blocks: ScheduleBlock[]): Promise<Schedule> {
  if (useMock()) return mockSaveSchedule(deviceId, blocks);
  return call("schedules", { method: "PUT", body: JSON.stringify({ device_id: deviceId, blocks }) });
}

export async function enableSchedule(deviceId: string, enabled: boolean): Promise<Schedule> {
  if (useMock()) return mockEnableSchedule(deviceId, enabled);
  return call("schedules", { method: "POST", body: JSON.stringify({ action: "enable", device_id: deviceId, enabled, apply_now: enabled }) });
}

// ---------- Ring ----------

export async function ringLogin(email: string, password: string, code?: string) {
  if (useMock()) return code ? { ok: true, cameras: ["Living Room"] } : { need_code: true, prompt: "Enter the code sent to ***-***-1234." };
  return call("ring", { method: "POST", body: JSON.stringify({ action: "login", email, password, code }) });
}

export async function ringLogout() {
  if (useMock()) return { ok: true };
  return call("ring", { method: "POST", body: JSON.stringify({ action: "logout" }) });
}

/** The latest snapshot: image bytes and when it was taken, or an error message. */
export async function ringSnapshot(deviceId: string, force: boolean): Promise<{ image: ArrayBuffer; takenMs: number | null } | { error: string }> {
  if (useMock()) return mockSnapshot();
  const r = await callRaw(`ring?snapshot=${encodeURIComponent(deviceId)}${force ? "&force=1" : ""}`);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    return { error: body.error ?? `HTTP ${r.status}` };
  }
  const taken = Number(r.headers.get("x-snapshot-ms"));
  return { image: await r.arrayBuffer(), takenMs: Number.isFinite(taken) && taken > 0 ? taken : null };
}
