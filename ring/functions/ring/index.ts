// ring: Ring cameras through Ring's own app API (the same calls as the open source ring-client-api,
// github.com/dgreif/ring, which Home Assistant and Homebridge use). Ring has no official API, so a
// Ring change can break this until it's updated.
//
// Auth: header x-home-key (checked against home_config.api_key_sha256).
//
//   POST /ring {"action":"login","email":"...","password":"...","code":"123456"}
//        signs in; without a code, Ring sends one (text, email or authenticator) and this answers
//        {"need_code":true,"prompt":"..."}. The password is never stored; only Ring's refresh token is,
//        in home_provider_sessions, and it rotates on every use.
//   POST /ring {"action":"logout"}                     forget the Ring session
//   POST /ring {"action":"poll"}                       sync cameras into home_devices, store a reading
//                                                      (online, battery, mode, recent events)
//   POST /ring {"action":"command","device_id":"ring_<id>","command":{"action":"set_mode","mode":"home"}}
//        modes: disarmed, home, away (Ring's location modes)
//   GET  /ring?snapshot=ring_<id>[&force=1]           latest snapshot as image/jpeg; header x-snapshot-ms
//                                                      is when it was taken. force asks a wired camera for a
//                                                      fresh one (battery cameras keep Ring's own cadence).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CLIENT_API = "https://api.ring.com/clients_api/";
const APP_API = "https://prd-api-us.prd.rings.solutions/api/v1/";
const UA = "android:com.ringapp";
const MODES = ["disarmed", "home", "away"];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authorized(req: Request) {
  const key = req.headers.get("x-home-key");
  if (!key) return false;
  const { data } = await db.from("home_config").select("api_key_sha256").eq("id", 1).single();
  return !!data && data.api_key_sha256 === (await sha256(key));
}

class NotConnected extends Error {}
class UserError extends Error {}

// ---------- session ----------
// Saved in home_provider_sessions as {rt, hid, access_token, expires_at}. rt is Ring's refresh token,
// which Ring replaces on every refresh, so each new one is saved right away.

type Sess = { rt: string; hid: string; access_token?: string; expires_at?: number };

async function loadSession(): Promise<Sess | null> {
  const { data } = await db.from("home_provider_sessions").select("session").eq("provider", "ring").maybeSingle();
  const s = data?.session as Sess | undefined;
  return s?.rt && s?.hid ? s : null;
}

async function saveSession(s: Sess) {
  const { error } = await db.from("home_provider_sessions").upsert({ provider: "ring", session: s, created_at: new Date().toISOString() });
  if (error) throw error;
}

async function oauth(body: Record<string, string>, hid: string, code = "") {
  const r = await fetch("https://oauth.ring.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "2fa-support": "true", "2fa-code": code, hardware_id: hid, "User-Agent": UA },
    body: JSON.stringify({ client_id: "ring_official_android", scope: "client", ...body }),
  });
  const text = await r.text();
  let j: any = {};
  try { j = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, j };
}

async function accessToken(force = false): Promise<{ token: string; s: Sess }> {
  const s = await loadSession();
  if (!s) throw new NotConnected("Ring isn't connected yet");
  if (!force && s.access_token && (s.expires_at ?? 0) > Date.now() + 120_000) return { token: s.access_token, s };
  const { status, j } = await oauth({ grant_type: "refresh_token", refresh_token: s.rt }, s.hid);
  if (status !== 200 || !j.access_token) {
    if (status === 400 || status === 401) {
      await db.from("home_provider_sessions").delete().eq("provider", "ring");
      throw new NotConnected("Ring signed this dashboard out. Connect it again from the Camera tab.");
    }
    throw new Error(`Ring sign in refresh failed: HTTP ${status}`);
  }
  const next: Sess = { rt: j.refresh_token ?? s.rt, hid: s.hid, access_token: j.access_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 };
  await saveSession(next);
  return { token: next.access_token!, s: next };
}

async function registerSession(token: string, hid: string) {
  const r = await fetch(CLIENT_API + "session", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", authorization: `Bearer ${token}`, hardware_id: hid, "User-Agent": UA },
    body: JSON.stringify({ device: { hardware_id: hid, os: "android", metadata: { api_version: 11, device_model: "Home HQ" } } }),
  });
  if (!r.ok) throw new Error(`Ring session failed: HTTP ${r.status}`);
}

// One Ring API call with the saved session; refreshes or re-registers once when Ring asks for it.
async function ring(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
  const { token, s } = await accessToken(retried);
  const r = await fetch(url, {
    ...init,
    headers: { Accept: "application/json", ...(init.headers ?? {}), authorization: `Bearer ${token}`, hardware_id: s.hid, "User-Agent": UA },
  });
  if (!retried && r.status === 401) return ring(url, init, true);
  if (!retried && r.status === 404 && url.startsWith(CLIENT_API) && (await r.clone().text()).includes(s.hid)) {
    await registerSession(token, s.hid); // Ring forgot this dashboard's session
    return ring(url, init, true);
  }
  return r;
}

async function ringJson(url: string, init: RequestInit = {}) {
  const r = await ring(url, init);
  if (!r.ok) throw new Error(`Ring ${new URL(url).pathname} failed: HTTP ${r.status}`);
  return r.json();
}

// ---------- sign in ----------

async function login(email: string, password: string, code?: string) {
  if (!email || !password) throw new UserError("Enter your Ring email and password.");
  const hid = (await loadSession())?.hid ?? crypto.randomUUID();
  const { status, j } = await oauth({ grant_type: "password", username: email, password }, hid, code ?? "");
  if (status === 412) {
    const how = j.tsv_state === "totp" ? "from your authenticator app" : j.phone ? `sent to ${j.phone}` : "Ring just sent you";
    return { need_code: true, prompt: `Enter the code ${how}.` };
  }
  if (status === 400 && String(j.error ?? "").startsWith("Verification Code")) throw new UserError("That code didn't work. Check it and try again.");
  if (status === 429 || j.error_description === "too many requests from dependency service") throw new UserError("Ring is limiting codes right now (10 per 10 minutes). Wait a few minutes and try again.");
  if (status !== 200 || !j.access_token) throw new UserError("Ring didn't accept that email and password.");
  await saveSession({ rt: j.refresh_token, hid, access_token: j.access_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000 });
  await registerSession(j.access_token, hid);
  const cams = await poll();
  return { ok: true, cameras: cams.map((c) => c.name) };
}

// ---------- cameras ----------

type Cam = { id: number; description: string; kind: string; location_id: string; battery_life?: string | number | null; settings?: any; alerts?: any; health?: any; external_connection?: boolean };

async function cameras(): Promise<Cam[]> {
  const d = await ringJson(CLIENT_API + "ring_devices");
  return [...(d.doorbots ?? []), ...(d.authorized_doorbots ?? []), ...(d.stickup_cams ?? [])];
}

const deviceId = (c: Cam) => `ring_${c.id}`;
const ringId = (id: string) => {
  const m = /^ring_(\d+)$/.exec(id ?? "");
  if (!m) throw new UserError("unknown camera");
  return m[1];
};

async function mode(locationId: string): Promise<string | null> {
  const r = await ring(APP_API + `mode/location/${locationId}`);
  if (!r.ok) return null; // Modes turned off in the Ring app
  const j = await r.json().catch(() => ({}));
  return typeof j.mode === "string" ? j.mode : null;
}

async function events(c: Cam) {
  const r = await ring(CLIENT_API + `locations/${c.location_id}/devices/${c.id}/events?limit=8`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  const list: any[] = Array.isArray(j.events) ? j.events : Array.isArray(j) ? j : [];
  return list.slice(0, 8).map((e) => ({
    t: e.created_at ?? null,
    kind: e.kind ?? null, // motion, ding, on_demand
    person: e.cv_properties?.person_detected ?? (e.cv_properties?.detection_type === "human" ? true : null),
  }));
}

function state(c: Cam, m: string | null, ev: unknown[]) {
  const battery = c.battery_life == null || c.battery_life === "" ? null : Number(c.battery_life);
  return {
    online: c.alerts?.connection !== "offline",
    battery: Number.isFinite(battery) ? battery : null,
    on_battery: battery != null && c.settings?.power_mode !== "wired",
    charging: c.external_connection ?? null,
    motion_enabled: c.settings?.motion_detection_enabled !== false,
    mode: m,
    wifi: c.health?.wifi_name ?? null,
    events: ev,
  };
}

async function poll() {
  const cams = await cameras();
  const modeByLocation = new Map<string, string | null>();
  const out = [];
  for (const c of cams) {
    if (!modeByLocation.has(c.location_id)) modeByLocation.set(c.location_id, await mode(c.location_id));
    const s = state(c, modeByLocation.get(c.location_id) ?? null, await events(c));
    const id = deviceId(c);
    const { error: e1 } = await db.from("home_devices").upsert({
      id, kind: "camera", provider: "ring", name: c.description || "Ring camera",
      provider_ref: { ring_id: c.id, kind: c.kind, location_id: c.location_id },
      capabilities: { modes: modeByLocation.get(c.location_id) ? MODES : [], battery: s.battery != null },
      updated_at: new Date().toISOString(),
    });
    if (e1) throw e1;
    const { error: e2 } = await db.from("home_readings").insert({ device_id: id, source: "poll", state: s });
    if (e2) throw e2;
    out.push({ id, name: c.description, state: s });
  }
  return out;
}

async function command(id: string, cmd: any, source = "ui") {
  const { data: row, error } = await db.from("home_commands")
    .insert({ device_id: id, command: cmd, source, status: "pending" }).select("id").single();
  if (error) throw error;
  const finish = (status: string, result: unknown) =>
    db.from("home_commands").update({ status, result, completed_at: new Date().toISOString() }).eq("id", row.id);
  try {
    const rid = Number(ringId(id));
    const cam = (await cameras()).find((c) => c.id === rid);
    if (!cam) throw new UserError("camera not found on the Ring account");
    if (cmd?.action !== "set_mode") throw new UserError("unknown command; use set_mode");
    if (!MODES.includes(cmd.mode)) throw new UserError("mode must be disarmed, home or away");
    const r = await ring(APP_API + `mode/location/${cam.location_id}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: cmd.mode }),
    });
    if (!r.ok) throw new Error(r.status === 404 ? "Modes are turned off in the Ring app" : `Ring mode change failed: HTTP ${r.status}`);
    await finish("done", { mode: cmd.mode });
    poll().catch(() => {});
    return { ok: true, command_id: row.id };
  } catch (err) {
    await finish("failed", { error: String((err as Error).message ?? err) });
    throw err;
  }
}

async function snapshot(id: string, force: boolean) {
  const rid = ringId(id);
  const r = await ring(`https://app-snaps.ring.com/snapshots/next/${rid}${force ? "?extras=force" : ""}`, { headers: { accept: "image/jpeg" } });
  if (!r.ok) {
    if (r.status === 404) throw new UserError("No snapshot yet. Ring needs Snapshot Capture or motion recording on for this camera.");
    throw new Error(`Ring snapshot failed: HTTP ${r.status}`);
  }
  const taken = r.headers.get("x-time-millis");
  return new Response(await r.arrayBuffer(), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store", ...(taken ? { "x-snapshot-ms": taken } : {}) },
  });
}

Deno.serve(async (req) => {
  try {
    if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
    const url = new URL(req.url);
    if (req.method === "GET") {
      const snap = url.searchParams.get("snapshot");
      if (snap) return await snapshot(snap, url.searchParams.get("force") === "1");
      const s = await loadSession();
      return json({ connected: !!s });
    }
    const body = await req.json().catch(() => ({}));
    if (body.action === "login") return json(await login(body.email, body.password, body.code));
    if (body.action === "logout") {
      await db.from("home_provider_sessions").delete().eq("provider", "ring");
      return json({ ok: true });
    }
    if (body.action === "poll") {
      if (!(await loadSession())) return json({ connected: false, polled: [] });
      return json({ connected: true, polled: await poll() });
    }
    if (body.action === "command") return json(await command(body.device_id, body.command, body.source ?? "ui"));
    return json({ error: "use GET ?snapshot=, or POST with action login, logout, poll or command" }, 400);
  } catch (err) {
    if (err instanceof NotConnected) return json({ error: err.message, not_connected: true }, 409);
    if (err instanceof UserError) return json({ error: err.message }, 400);
    return json({ error: String((err as Error).message ?? err) }, 502);
  }
});
