import "server-only";
import type { Command, HomeData } from "./types";
import { mockData, mockCommand } from "./mock";

const useMock = () => process.env.HOME_MOCK === "1" || !process.env.SUPABASE_URL || !process.env.HOME_API_KEY;

async function call(path: string, init?: RequestInit) {
  const r = await fetch(`${process.env.SUPABASE_URL}/functions/v1/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "x-home-key": process.env.HOME_API_KEY!, ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
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

const PROVIDERS = new Set(["rheem", "govee", "ac"]);

export async function sendCommand(provider: string, deviceId: string, command: Command) {
  if (!PROVIDERS.has(provider)) throw new Error("unknown appliance");
  if (useMock()) return mockCommand(deviceId, command);
  return call(provider, { method: "POST", body: JSON.stringify({ action: "command", device_id: deviceId, command, source: "ui" }) });
}
