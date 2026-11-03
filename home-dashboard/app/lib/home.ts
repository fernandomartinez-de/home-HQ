import "server-only";
import type { Analytics, Command, HomeData, Schedule, ScheduleBlock } from "./types";
import { mockAnalytics, mockData, mockCommand, mockSchedule, mockSaveSchedule, mockEnableSchedule, mockSnapshot } from "./mock";

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

export async function getAnalytics(days = 14): Promise<Analytics> {
  if (useMock()) return mockAnalytics(days);
  return call(`home?analytics=${Math.min(90, Math.max(1, Math.round(days)))}`);
}

export async function refreshHome(): Promise<HomeData> {
  if (useMock()) return mockData();
  const body = await call("home", { method: "POST", body: JSON.stringify({ action: "refresh" }) });
  return { devices: body.devices };
}

const PROVIDERS = new Set(["rheem", "govee", "ac", "tv", "ring", "lifx", "switchbot", "shelly"]);

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

// Run a routine now by name (Morning, Night): it finishes in the background.
export async function runRoutine(name: string) {
  if (useMock()) return { started: name };
  return call("schedules", { method: "POST", body: JSON.stringify({ action: "routine", name, background: true }) });
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

// ---------- Con Edison ----------
// The details are saved in Supabase Vault by the coned function, since Con Edison has no refresh token
// and the scheduled poll has to sign in again.

export async function conedConnect(email: string, password: string, totp?: string) {
  if (useMock()) {
    if (password === "wrong") throw new Error("Con Edison didn't accept that email and password.");
    return { ok: true };
  }
  return call("coned", { method: "POST", body: JSON.stringify({ action: "connect", email, password, totp }) });
}

export async function conedDisconnect() {
  if (useMock()) return { ok: true };
  return call("coned", { method: "POST", body: JSON.stringify({ action: "disconnect" }) });
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

/** Starts Ring live view: sends the browser's WebRTC offer, returns Ring's answer. */
export async function ringLiveStart(deviceId: string, sdp: string): Promise<{ sdp: string; session_id: string }> {
  if (useMock()) throw new Error("Live view needs a real Ring camera (sample data is on).");
  return call("ring", { method: "POST", body: JSON.stringify({ action: "live_start", device_id: deviceId, sdp }) });
}

export async function ringLiveEnd(sessionId: string) {
  if (useMock()) return { ok: true };
  return call("ring", { method: "POST", body: JSON.stringify({ action: "live_end", session_id: sessionId }) });
}
