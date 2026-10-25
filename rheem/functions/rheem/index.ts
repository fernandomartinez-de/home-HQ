// rheem: read and control Rheem EcoNet water heaters.
//
// Reads use the EcoNet REST API; commands are published over EcoNet's MQTT broker, the same
// way the Rheem app does it. Endpoints follow the open source pyeconet library.
//
// Auth: every request needs the header x-home-key (checked against home_config.api_key_sha256).
// Secrets: RHEEM_EMAIL, RHEEM_PASSWORD.
//
//   GET  /rheem                     live state of every water heater (nothing stored)
//   POST /rheem {"action":"poll"}   fetch, upsert home_devices, store a home_readings row
//   POST /rheem {"action":"command","device_id":"rheem_<serial>","command":{...}}
//        commands: {"action":"set_setpoint","value":120}
//                  {"action":"set_mode","mode":"heat_pump"}   (any mode in capabilities.modes)
//                  {"action":"power","on":false}
//                  {"action":"set_state","mode":"heat_pump","setpoint":135}   (used by schedules)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import mqtt from "npm:mqtt@5";

const HOST = "rheem.rheemconnect.com";
const REST = `https://${HOST}/api/v/1`;
// Public app identifiers baked into the Rheem app (not account secrets).
const SYSTEM_KEY = "e2e699cb0bb0bbb88fc8858cb5a401";
const SYSTEM_SECRET = "E2E699CB0BE6C6FADDB1B0BC9A20";
const BASE_HEADERS = {
  "ClearBlade-SystemKey": SYSTEM_KEY,
  "ClearBlade-SystemSecret": SYSTEM_SECRET,
  "Content-Type": "application/json; charset=UTF-8",
};

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

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

// ---------- EcoNet API ----------

type Session = { token: string; accountId: string; email: string };

// EcoNet rate limits sign ins, so the session is saved in home_provider_sessions and reused
// until EcoNet rejects it. A 429 on sign in starts a cool down so we stop asking for a while.
const SESSION_MAX_AGE_MS = 7 * 24 * 3600_000;
const COOLDOWN_MS = 15 * 60_000;

class AuthExpired extends Error {}

async function savedSession(): Promise<{ s?: Session; blockedUntil?: number; age: number }> {
  const { data } = await db.from("home_provider_sessions").select("session, created_at").eq("provider", "rheem").maybeSingle();
  if (!data) return { age: Infinity };
  const j = data.session ?? {};
  return {
    s: j.token ? { token: j.token, accountId: j.accountId, email: j.email } : undefined,
    blockedUntil: j.blocked_until ? Date.parse(j.blocked_until) : undefined,
    age: Date.now() - Date.parse(data.created_at),
  };
}

async function login(): Promise<Session> {
  const email = Deno.env.get("RHEEM_EMAIL");
  const password = Deno.env.get("RHEEM_PASSWORD");
  if (!email || !password) throw new Error("RHEEM_EMAIL and RHEEM_PASSWORD secrets are not set");
  const r = await fetch(`${REST}/user/auth`, {
    method: "POST",
    headers: BASE_HEADERS,
    body: JSON.stringify({ email, password }),
  });
  if (r.status === 429) {
    const until = new Date(Date.now() + COOLDOWN_MS).toISOString();
    await db.from("home_provider_sessions").upsert({ provider: "rheem", session: { blocked_until: until }, created_at: new Date().toISOString() });
    throw new Error("Rheem is limiting sign ins right now. Try again in about 15 minutes.");
  }
  if (!r.ok) throw new Error(`EcoNet login failed: HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.options?.success) throw new Error(`EcoNet login rejected: ${j?.options?.message ?? "unknown"}`);
  const s = { token: j.user_token, accountId: j.options.account_id, email };
  await db.from("home_provider_sessions").upsert({ provider: "rheem", session: s, created_at: new Date().toISOString() });
  return s;
}

async function session(forceNew = false): Promise<Session> {
  const saved = await savedSession();
  if (saved.blockedUntil && saved.blockedUntil > Date.now()) {
    const mins = Math.ceil((saved.blockedUntil - Date.now()) / 60_000);
    throw new Error(`Rheem is limiting sign ins right now. Try again in about ${mins} min.`);
  }
  if (!forceNew && saved.s && saved.age < SESSION_MAX_AGE_MS) return saved.s;
  return login();
}

async function equipment(s: Session): Promise<any[]> {
  const r = await fetch(`${REST}/code/${SYSTEM_KEY}/getUserDataForApp`, {
    method: "POST",
    headers: { ...BASE_HEADERS, "ClearBlade-UserToken": s.token },
    body: JSON.stringify({ resource: "friedrich" }),
  });
  if (r.status === 400 || r.status === 401 || r.status === 403) throw new AuthExpired("EcoNet session expired");
  if (r.status === 429) throw new Error("Rheem is busy right now. Try again in a minute.");
  if (!r.ok) throw new Error(`EcoNet equipment failed: HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.success) throw new Error("EcoNet equipment: unexpected response");
  const out: any[] = [];
  for (const loc of j.results?.locations ?? []) {
    for (const e of loc.equiptments ?? []) { // sic, the API spells it this way
      if (!e.error && e.device_type === "WH") out.push(e);
    }
  }
  return out;
}

// Normalize EcoNet mode text ("HEAT PUMP ONLY ", "Energy Saver  ") to stable keys.
function modeKey(text: string) {
  const t = text.trim().toLowerCase();
  if (t === "off") return "off";
  if (t.includes("energy")) return "energy_saver";
  if (t.includes("heat pump")) return "heat_pump";
  if (t.includes("high demand")) return "high_demand";
  if (t.includes("electric") && t.includes("gas")) return "electric_gas";
  if (t.includes("electric")) return "electric";
  if (t.includes("gas")) return "gas";
  if (t.includes("vacation")) return "vacation";
  if (t.includes("performance")) return "performance";
  return t.replace(/\s+/g, "_");
}

function normalize(e: any) {
  const modeTexts: string[] = e["@MODE"]?.constraints?.enumText ?? [];
  const isGas = /gas|tankless/i.test(String(e["@TYPE"] ?? ""));
  // "ELECTRIC/GAS" is one shared label in EcoNet; name it for what this unit actually is.
  const modes = modeTexts.map(modeKey).map((m) => (m === "electric_gas" ? (isGas ? "gas" : "electric") : m));
  const hasEnabled = e["@ENABLED"] !== undefined;
  const enabled = hasEnabled ? e["@ENABLED"]?.value === 1 : undefined;
  const modeIdx = e["@MODE"]?.value;
  let mode = typeof modeIdx === "number" ? modes[modeIdx] ?? null : null;
  if (enabled === false) mode = "off";
  // Some units (e.g. Gen 5 heat pumps) have both an Enabled flag and an "Off" mode. The heater
  // only heats when it is enabled AND in a heating mode, so "on" needs both.
  const on = enabled === false ? false : mode ? mode !== "off" : enabled ?? null;
  const sp = e["@SETPOINT"] ?? {};
  return {
    id: `rheem_${e.serial_number}`,
    name: e["@NAME"]?.value ?? "Water Heater",
    provider_ref: { serial_number: e.serial_number, device_name: e.device_name, type: e["@TYPE"] ?? null },
    capabilities: {
      modes,
      supports_power: hasEnabled || modes.includes("off"),
      setpoint_min_f: sp.constraints?.lowerLimit ?? null,
      setpoint_max_f: sp.constraints?.upperLimit ?? null,
    },
    state: {
      connected: e["@CONNECTED"] ?? true,
      power: on,
      mode,
      setpoint_f: sp.value ?? null,
      running: typeof e["@RUNNING"] === "string" ? e["@RUNNING"].trim() || null : null,
      tank_pct: e["@TANK"]?.value ?? null,
      alert_count: e["@ALERTCOUNT"] ?? 0,
      away: e["@AWAY"] ?? false,
      vacation: e["@VACATION"] ?? false,
    },
    raw_mode_texts: modeTexts,
  };
}

// Publish a desired-state change over EcoNet's MQTT broker, like the Rheem app does.
async function publish(s: Session, deviceName: string, serial: string, payload: Record<string, unknown>) {
  const stamp = new Date().toISOString().slice(0, 19);
  const message = JSON.stringify({
    transactionId: `ANDROID_${stamp}`,
    device_name: deviceName,
    serial_number: serial,
    ...payload,
  });
  const clientId = `${s.email}${Date.now()}_android`;
  await new Promise<void>((resolve, reject) => {
    const c = mqtt.connect(`mqtts://${HOST}:1884`, {
      clientId,
      username: s.token,
      password: SYSTEM_KEY,
      protocolVersion: 4,
      clean: true,
      connectTimeout: 10_000,
      reconnectPeriod: 0,
    });
    const fail = (err: unknown) => { c.end(true); reject(err instanceof Error ? err : new Error(String(err))); };
    const timer = setTimeout(() => fail(new Error("EcoNet MQTT timeout")), 15_000);
    c.on("error", (err) => { clearTimeout(timer); fail(err); });
    c.on("connect", () => {
      c.publish(`user/${s.accountId}/device/desired`, message, { qos: 0 }, (err) => {
        clearTimeout(timer);
        c.end(false, {}, () => (err ? reject(err) : resolve()));
      });
    });
  });
}

// ---------- actions ----------

async function lastHeatingMode(deviceId: string, modes: string[]) {
  const { data } = await db.from("home_readings").select("state").eq("device_id", deviceId)
    .neq("state->>mode", "off").not("state->>mode", "is", null)
    .order("recorded_at", { ascending: false }).limit(1);
  const m = data?.[0]?.state?.mode;
  if (m && modes.includes(m)) return m;
  return modes.find((x) => x === "energy_saver") ?? modes.find((x) => x !== "off") ?? "off";
}

async function liveState() {
  let s = await session();
  let list: any[];
  try {
    list = await equipment(s);
  } catch (err) {
    if (!(err instanceof AuthExpired)) throw err;
    s = await session(true); // saved session expired: sign in once and retry
    list = await equipment(s);
  }
  return { session: s, heaters: list.map((e) => ({ e, n: normalize(e) })) };
}

async function poll() {
  const { heaters } = await liveState();
  for (const { n } of heaters) {
    const { error: e1 } = await db.from("home_devices").upsert({
      id: n.id, kind: "water_heater", provider: "rheem", name: n.name,
      provider_ref: n.provider_ref, capabilities: n.capabilities, updated_at: new Date().toISOString(),
    });
    if (e1) throw e1;
    const { error: e2 } = await db.from("home_readings").insert({ device_id: n.id, source: "poll", state: n.state });
    if (e2) throw e2;
  }
  return heaters.map(({ n }) => ({ id: n.id, name: n.name, state: n.state }));
}

async function command(deviceId: string, cmd: any, source = "ui") {
  const { data: row, error } = await db.from("home_commands")
    .insert({ device_id: deviceId, command: cmd, source, status: "pending" })
    .select("id").single();
  if (error) throw error;

  const finish = (status: string, result: unknown) =>
    db.from("home_commands").update({ status, result, completed_at: new Date().toISOString() }).eq("id", row.id);

  try {
    const { session, heaters } = await liveState();
    const h = heaters.find(({ n }) => n.id === deviceId);
    if (!h) throw new Error(`water heater ${deviceId} not found on the EcoNet account`);
    const { e, n } = h;
    const payload: Record<string, unknown> = {};

    if (cmd?.action === "set_setpoint") {
      const v = Math.round(Number(cmd.value));
      const lo = n.capabilities.setpoint_min_f ?? 0, hi = n.capabilities.setpoint_max_f ?? 999;
      if (!(v >= lo && v <= hi)) throw new Error(`setpoint must be between ${lo} and ${hi} F`);
      payload["@SETPOINT"] = v;
    } else if (cmd?.action === "set_mode" || cmd?.action === "power") {
      const modes = n.capabilities.modes;
      let want: string;
      if (cmd.action === "set_mode") want = String(cmd.mode);
      else if (!cmd.on) want = "off";
      else {
        // Turning on: keep the current heating mode, else the last one used, else energy saver.
        want = n.state.mode && n.state.mode !== "off" ? n.state.mode : await lastHeatingMode(deviceId, modes);
      }
      const hasEnabled = e["@ENABLED"] !== undefined;
      if (hasEnabled) payload["@ENABLED"] = want === "off" ? 0 : 1;
      const idx = modes.indexOf(want);
      if (idx >= 0) payload["@MODE"] = idx;
      else if (want !== "off" || !hasEnabled) throw new Error(`mode must be one of: ${modes.join(", ")}`);
    } else if (cmd?.action === "set_state") {
      // One step for schedules: mode and temperature together. Mode "off" turns the heater off.
      const modes = n.capabilities.modes;
      const want = String(cmd.mode);
      const hasEnabled = e["@ENABLED"] !== undefined;
      if (hasEnabled) payload["@ENABLED"] = want === "off" ? 0 : 1;
      const idx = modes.indexOf(want);
      if (idx >= 0) payload["@MODE"] = idx;
      else if (want !== "off" || !hasEnabled) throw new Error(`mode must be one of: ${modes.join(", ")}`);
      if (want !== "off" && cmd.setpoint != null) {
        const lo = n.capabilities.setpoint_min_f ?? 0, hi = n.capabilities.setpoint_max_f ?? 999;
        payload["@SETPOINT"] = Math.min(hi, Math.max(lo, Math.round(Number(cmd.setpoint))));
      }
    } else {
      throw new Error("unknown command; use set_setpoint, set_mode, power or set_state");
    }

    await publish(session, e.device_name, e.serial_number, payload);
    await finish("sent", { published: payload });
    return { ok: true, command_id: row.id, published: payload };
  } catch (err) {
    await finish("failed", { error: String((err as Error).message ?? err) });
    throw err;
  }
}

Deno.serve(async (req) => {
  try {
    if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
    if (req.method === "GET") {
      const { heaters } = await liveState();
      const debug = new URL(req.url).searchParams.has("raw");
      const pick = (e: any) => Object.fromEntries(
        ["@ENABLED", "@MODE", "@STATUS", "@RUNNING", "@SETPOINT", "@TANK", "@AWAY", "@VACATION", "@CONNECTED", "@TYPE"]
          .map((k) => [k, k === "@MODE" || k === "@SETPOINT" ? { value: e[k]?.value, status: e[k]?.status, enumText: e[k]?.constraints?.enumText } : e[k]]),
      );
      return json({ heaters: heaters.map(({ e, n }) => ({ id: n.id, name: n.name, capabilities: n.capabilities, state: n.state, ...(debug ? { raw: pick(e) } : {}) })) });
    }
    const body = await req.json().catch(() => ({}));
    if (body.action === "poll") return json({ polled: await poll() });
    if (body.action === "command") return json(await command(body.device_id, body.command, body.source ?? "ui"));
    return json({ error: "use GET, or POST with action poll or command" }, 400);
  } catch (err) {
    return json({ error: String((err as Error).message ?? err) }, 502);
  }
});
