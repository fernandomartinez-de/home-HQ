// coned: Con Edison electricity usage, cost and bills through Opower, the service behind the
// "Energy Use" pages on coned.com. Con Edison has no public API; this follows the same sign in as
// the open source opower library (github.com/tronikos/opower, used by Home Assistant), so a change
// on Con Edison's side can break it until it's updated.
//
// Auth: header x-home-key (checked against home_config.api_key_sha256).
//
//   POST /coned {"action":"connect","email":"...","password":"...","totp":"<authenticator setup key>"}
//        signs in once to check the details, then saves them in Supabase Vault (encrypted) so the
//        scheduled poll can sign in again. totp may also be the otpauth:// link from the QR code.
//   POST /coned {"action":"disconnect"}            forget the saved details and hide the meter
//   POST /coned {"action":"poll"[,"background":true]}
//        signs in, stores the latest usage, cost, bill forecast and bills as a reading of device
//        coned_electric, and keeps daily totals in home_energy_daily. background answers right away
//        and finishes after (for pg_cron, whose calls time out after 30 seconds).
//   GET  /coned                                    {"connected":true|false}

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const BASE = "https://www.coned.com";
const LOGIN_API = BASE + "/sitecore/api/ssc/ConEdWeb-Foundation-Login-Areas-LoginAPI/User/0";
const RETURN_URL = "/en/accounts-billing/my-account/energy-use";
const OPOWER = "https://cned.opower.com/ei/edge/apis";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const TZ = "America/New_York";
const DEVICE = "coned_electric";
const SECRET = "login_coned";

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

// ---------- saved details ----------
// The email, password and authenticator key live in Supabase Vault (home_secret_* functions, service
// role only). home_provider_sessions keeps the rest: the device cookie that lets Con Edison skip 2FA
// on a known device, and the current Opower token.

type Login = { email: string; password: string; totp: string };
type Sess = { device?: string; token?: string; exp?: number };

async function loadLogin(): Promise<Login | null> {
  const { data, error } = await db.rpc("home_secret_get", { p_name: SECRET });
  if (error) throw error;
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

async function loadSession(): Promise<Sess> {
  const { data } = await db.from("home_provider_sessions").select("session").eq("provider", "coned").maybeSingle();
  return (data?.session as Sess) ?? {};
}

async function saveSession(s: Sess) {
  const { error } = await db.from("home_provider_sessions").upsert({ provider: "coned", session: s, created_at: new Date().toISOString() });
  if (error) throw error;
}

// ---------- authenticator codes (RFC 6238, 30 seconds, 6 digits) ----------

function cleanSecret(raw: string) {
  const s = (raw ?? "").trim();
  const fromUri = /[?&]secret=([^&]+)/i.exec(s);
  return decodeURIComponent(fromUri ? fromUri[1] : s).replace(/[\s=-]/g, "").toUpperCase();
}

function base32(s: string) {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const ch of s) {
    const i = abc.indexOf(ch);
    if (i < 0) throw new UserError("That authenticator key doesn't look right. It's the letters and numbers shown under the QR code.");
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

async function totp(secret: string, counter: number) {
  const key = await crypto.subtle.importKey("raw", base32(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[19] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

// ---------- a small cookie jar (fetch keeps no cookies, and coned.com needs them across redirects) ----------

type Cookie = { name: string; value: string; domain: string; hostOnly: boolean };

class Jar {
  cookies: Cookie[] = [];
  take(url: string, res: Response) {
    const host = new URL(url).hostname;
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
      let domain = host, hostOnly = true, gone = false;
      for (const a of attrs) {
        const [k, v = ""] = a.split("=").map((x) => x.trim());
        const key = k.toLowerCase();
        if (key === "domain" && v) { domain = v.replace(/^\./, "").toLowerCase(); hostOnly = false; }
        if (key === "max-age" && Number(v) <= 0) gone = true;
        if (key === "expires" && Date.parse(v) < Date.now()) gone = true;
      }
      this.cookies = this.cookies.filter((c) => !(c.name === name && c.domain === domain));
      if (!gone) this.cookies.push({ name, value, domain, hostOnly });
    }
  }
  header(url: string) {
    const host = new URL(url).hostname;
    return this.cookies
      .filter((c) => c.domain === host || (!c.hostOnly && host.endsWith("." + c.domain)))
      .map((c) => `${c.name}=${c.value}`).join("; ");
  }
  get(name: string) { return this.cookies.find((c) => c.name === name)?.value; }
}

// fetch that follows redirects itself so every hop's cookies are kept.
async function go(jar: Jar, url: string, init: RequestInit = {}) {
  let method = init.method ?? "GET", body = init.body;
  for (let hop = 0; hop < 15; hop++) {
    const headers = new Headers(init.headers);
    headers.set("User-Agent", UA);
    const cookie = jar.header(url);
    if (cookie) headers.set("Cookie", cookie);
    const r = await fetch(url, { method, headers, body, redirect: "manual" });
    jar.take(url, r);
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) {
      await r.body?.cancel();
      url = new URL(loc, url).toString();
      if (r.status !== 307 && r.status !== 308) { method = "GET"; body = undefined; }
      continue;
    }
    return { r, url };
  }
  throw new Error("Con Edison sign in redirected too many times");
}

async function goJson(jar: Jar, url: string, init: RequestInit = {}) {
  const { r } = await go(jar, url, init);
  const text = await r.text();
  if (!r.ok) throw new Error(`Con Edison ${new URL(url).pathname.split("/").pop()} failed: HTTP ${r.status}`);
  try { return JSON.parse(text); } catch { throw new Error("Con Edison sent an unexpected answer during sign in"); }
}

// Field names and yes/no values only, so a changed answer from Con Edison can be seen without exposing anything.
const shapeOf = (o: unknown) =>
  Object.entries((o ?? {}) as Record<string, unknown>).map(([k, v]) => (typeof v === "boolean" || v === null ? `${k}=${v}` : `${k}:${typeof v}`)).join(", ") || "empty";

// ---------- sign in ----------
// Mirrors opower/utilities/coned.py: Login API, then 2FA with an authenticator code when Con Edison
// doesn't know this device, then the Okta redirects, then the Energy Use page mints an Opower token.

async function signIn(login: Login, sess: Sess): Promise<Sess> {
  const jar = new Jar();
  if (sess.device) jar.cookies.push({ name: "CE_DEVICE_ID", value: sess.device, domain: "coned.com", hostOnly: false });
  const ref = { Referer: BASE + "/en/login" };

  await go(jar, BASE + "/en/login");
  const res = await goJson(jar, LOGIN_API + "/Login", {
    method: "POST",
    headers: { ...ref, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ LoginEmail: login.email, LoginPassword: login.password, LoginRememberMe: false, ReturnUrl: "", FromURI: "", OpenIdRelayState: "" }),
  });
  if (!res.login) throw new UserError("Con Edison didn't accept that email and password.");

  let redirect: string | undefined = res.authRedirectUrl;
  if (!redirect && res.newDevice && !res.noMfa) {
    if (!login.totp) throw new UserError("Con Edison asked for a 2FA code. Add the authenticator setup key (switch Con Edison's 2FA to an authenticator app to get one).");
    const verify = async (code: string) => goJson(jar, LOGIN_API + "/VerifyFactor", {
      method: "POST",
      headers: { ...ref, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ MFACode: code, ReturnUrl: "", FromURI: "", OpenIdRelayState: "" }),
    });
    let counter = Math.floor(Date.now() / 30000);
    let mfa = await verify(await totp(login.totp, counter));
    if (!mfa.code) {
      // Con Edison refuses a code it already accepted moments ago; wait for the next one.
      await new Promise((ok) => setTimeout(ok, (counter + 1) * 30000 - Date.now() + 1000));
      counter = Math.max(counter + 1, Math.floor(Date.now() / 30000));
      mfa = await verify(await totp(login.totp, counter));
    }
    if (!mfa.code) throw new UserError("Con Edison didn't accept the authenticator code. Check the setup key.");
    redirect = mfa.authRedirectUrl;
    if (!redirect) {
      const shape = shapeOf(mfa);
      console.log("coned 2FA answer without redirect:", shape);
      throw new Error(`Con Edison accepted the 2FA code but didn't finish (no redirect). Answer: ${shape}`);
    }
  }
  if (!redirect) {
    const shape = shapeOf(res);
    console.log("coned login answer without redirect:", shape);
    throw new Error(`Con Edison sign in didn't finish (no redirect). Answer: ${shape}`);
  }

  await go(jar, new URL(redirect, BASE).toString());
  const page = await go(jar, BASE + RETURN_URL);
  await page.r.body?.cancel();
  if (new URL(page.url).pathname.includes("/login")) throw new Error("Con Edison sent the sign in back to the login page");

  const token = await goJson(jar, BASE + "/sitecore/api/ssc/ConEd-Cms-Services-Controllers-Opower/OpowerService/0/GetOPowerToken", {
    headers: { Referer: BASE + RETURN_URL, Accept: "application/json" },
  });
  if (!token || typeof token !== "string") throw new Error("Con Edison didn't hand over an Opower token");

  let exp = Date.now() + 15 * 60_000;
  try { exp = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).exp * 1000 || exp; } catch { /* not a JWT */ }
  return { device: jar.get("CE_DEVICE_ID") ?? sess.device, token, exp };
}

async function token(force = false): Promise<string> {
  const login = await loadLogin();
  if (!login) throw new NotConnected("Con Edison isn't connected yet");
  const sess = await loadSession();
  if (!force && sess.token && (sess.exp ?? 0) > Date.now() + 60_000) return sess.token;
  const next = await signIn(login, sess);
  await saveSession(next);
  return next.token!;
}

// ---------- Opower ----------

type Account = { customer: string; uuid: string; meter: string; resolution: string };

async function opower(tok: string, path: string, customer?: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { "User-Agent": UA, Accept: "application/json", authorization: `Bearer ${tok}`, ...(init.headers as Record<string, string> ?? {}) };
  if (customer) headers["Opower-Selected-Entities"] = JSON.stringify([`urn:opower:customer:uuid:${customer}`]);
  const r = await fetch(OPOWER + path, { ...init, headers });
  if (!r.ok) { await r.body?.cancel(); throw Object.assign(new Error(`Opower ${path.split("?")[0]} failed: HTTP ${r.status}`), { status: r.status }); }
  return r.json();
}

async function accounts(tok: string): Promise<Account[]> {
  const j = await opower(tok, "/multi-account-v1/cws/cned/customers?offset=0&batchSize=100&addressFilter=");
  const out: Account[] = [];
  for (const c of j.customers ?? []) {
    for (const a of c.utilityAccounts ?? []) out.push({ customer: c.uuid, uuid: a.uuid, meter: a.meterType, resolution: a.readResolution });
  }
  if (!out.length) throw new Error("No Con Edison accounts found on this login");
  return out;
}

// Calendar date and UTC offset in New York for a moment.
function nyDate(d: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function nyOffset(d: Date) {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "GMT-05:00";
  return s.replace("GMT", "") || "+00:00";
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v: number | null, p = 3) => (v == null ? null : Math.round(v * 10 ** p) / 10 ** p);
const readKwh = (r: any) => num(r.value) ?? num(r.consumption?.value) ?? 0;

// Usage (and cost when Con Edison gives it) by day or hour. Con Edison often answers the cost endpoint
// with HTTP 500 below bill level, so this falls back to usage only, like the opower library.
async function reads(tok: string, a: Account, agg: "day" | "hour", from: Date, to: Date) {
  try {
    const q = `aggregateType=${agg}&startDate=${encodeURIComponent(nyDate(from) + "T00:00:00" + nyOffset(from))}&endDate=${encodeURIComponent(nyDate(to) + "T00:00:00" + nyOffset(to))}`;
    const j = await opower(tok, `/DataBrowser-v1/cws/cost/utilityAccount/${a.uuid}?${q}`, a.customer);
    // Con Edison answers 0 for cost below bill level; keep that as unknown, not free.
    const list = (j.reads ?? []).map((r: any) => ({ t: r.startTime, kwh: readKwh(r), cost: num(r.providedCost) || null }));
    if (list.some((r: any) => r.kwh || r.cost)) return list;
  } catch { /* fall back */ }
  const q = `aggregateType=${agg}&startDate=${nyDate(from)}&endDate=${nyDate(to)}`;
  const j = await opower(tok, `/DataBrowser-v1/cws/utilities/cned/utilityAccounts/${a.uuid}/reads?${q}`, a.customer);
  return (j.reads ?? []).map((r: any) => ({ t: r.startTime, kwh: readKwh(r), cost: null as number | null }));
}

async function bills(tok: string, a: Account) {
  const j = await opower(tok, `/DataBrowser-v1/cws/cost/utilityAccount/${a.uuid}?aggregateType=bill`, a.customer);
  return (j.reads ?? [])
    .map((r: any) => ({ start: String(r.startTime).slice(0, 10), end: String(r.endTime).slice(0, 10), kwh: round(readKwh(r), 1), cost: round(num(r.providedCost), 2) }))
    .filter((b: any) => b.kwh || b.cost)
    .sort((x: any, y: any) => y.end.localeCompare(x.end))
    .slice(0, 13);
}

const FORECAST = `query GetBillForecast { billingAccountsConnection(first: 100) { edges { node { billForecast {
  timeInterval currentDateTime segments { serviceAgreement { uuid } estimatedUsage { value unit } estimatedUsageCharges { value }
  soFarUsage { value } soFarUsageCharges { value } priorYearUsage { value } priorYearUsageCharges { value } } } } } } }`;

async function forecast(tok: string, a: Account) {
  const j = await opower(tok, "/dsm-graphql-v1/cws/graphql", a.customer, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: FORECAST }),
  });
  for (const e of j?.data?.billingAccountsConnection?.edges ?? []) {
    const f = e?.node?.billForecast;
    if (!f?.timeInterval) continue;
    const [start, end] = String(f.timeInterval).split("/");
    const seg = (f.segments ?? []).find((s: any) => s?.serviceAgreement?.uuid === a.uuid) ?? (f.segments ?? [])[0];
    if (!seg) continue;
    return {
      start: start.slice(0, 10), end: end.slice(0, 10), as_of: String(f.currentDateTime ?? "").slice(0, 10) || null,
      kwh_so_far: round(num(seg.soFarUsage?.value), 1), cost_so_far: round(num(seg.soFarUsageCharges?.value), 2),
      kwh_forecast: round(num(seg.estimatedUsage?.value), 1), cost_forecast: round(num(seg.estimatedUsageCharges?.value), 2),
      typical_kwh: round(num(seg.priorYearUsage?.value), 1), typical_cost: round(num(seg.priorYearUsageCharges?.value), 2),
    };
  }
  return null;
}

// The smart meter's recent 15 minute reads (about the last day), for "right now" numbers.
async function live(tok: string, a: Account) {
  let m: any;
  try { m = await opower(tok, `/cws-real-time-ami-v1/cws/cned/accounts/${a.uuid}/meters`, a.customer); } catch (e) {
    if ((e as any).status === 424 || (e as any).status === 404) return null; // this meter has no near live reads
    throw e;
  }
  const meter = (m.meters_ids ?? [])[0];
  if (!meter) return null;
  const j = await opower(tok, `/cws-real-time-ami-v1/cws/cned/accounts/${a.uuid}/meters/${encodeURIComponent(meter)}/usage`, a.customer);
  const list = (j.reads ?? []).map((r: any) => ({ start: r.startTime, end: r.endTime, kwh: num(r.value) ?? 0 }));
  if (!list.length) return null;
  const last = list[list.length - 1];
  const mins = Math.max(1, (Date.parse(last.end) - Date.parse(last.start)) / 60000);
  const today = nyDate(new Date());
  return {
    t: last.end,
    kw: round(last.kwh * (60 / mins), 2),
    today_kwh: round(list.filter((r: any) => nyDate(new Date(r.start)) === today).reduce((s: number, r: any) => s + r.kwh, 0), 2),
    reads: list.slice(-96).map((r: any) => ({ t: r.start, kwh: round(r.kwh, 3) })),
  };
}

// ---------- poll ----------

async function poll() {
  let tok = await token();
  let accts: Account[];
  try { accts = await accounts(tok); } catch (e) {
    if ((e as any).status !== 401 && (e as any).status !== 403) throw e;
    tok = await token(true);
    accts = await accounts(tok);
  }
  const a = accts.find((x) => x.meter === "ELEC") ?? accts[0];
  const errors: string[] = [];
  const safe = async <T>(name: string, p: Promise<T>): Promise<T | null> => {
    try { return await p; } catch (e) { errors.push(`${name}: ${(e as Error).message}`); return null; }
  };

  const [daily, hourly, billList, bill, now] = await Promise.all([
    safe("daily", reads(tok, a, "day", daysAgo(40), new Date())),
    safe("hourly", reads(tok, a, "hour", daysAgo(3), new Date())),
    safe("bills", bills(tok, a)),
    safe("forecast", forecast(tok, a)),
    safe("live", live(tok, a)),
  ]);

  type Day = { d: string; kwh: number | null; cost: number | null };
  const days: Day[] = (daily ?? []).map((r: any) => ({ d: String(r.t).slice(0, 10), kwh: round(r.kwh, 2), cost: round(r.cost, 2) }));
  const state = {
    connected: true,
    meter: a.meter,
    resolution: a.resolution,
    bill,
    last_bill: billList?.[0] ?? null,
    bills: billList ?? [],
    daily: days.slice(-35),
    hourly: (hourly ?? []).slice(-48).map((r: any) => ({ t: r.t, kwh: round(r.kwh, 3) })),
    live: now,
    errors: errors.length ? errors : undefined,
  };

  const { error: e1 } = await db.from("home_devices").upsert({
    id: DEVICE, kind: "meter", provider: "coned", name: "Con Edison",
    provider_ref: { account_uuid: a.uuid }, capabilities: { live: !!now, cost_by_day: days.some((d) => d.cost != null) },
    enabled: true, updated_at: new Date().toISOString(),
  });
  if (e1) throw e1;
  const { error: e2 } = await db.from("home_readings").insert({ device_id: DEVICE, source: "poll", state });
  if (e2) throw e2;
  // A year of daily usage for the History tab, fetched once (and again only if the stored history is short).
  const { count: stored } = await db.from("home_energy_daily").select("day", { count: "exact", head: true }).eq("account", a.uuid);
  if ((stored ?? 0) < 300) {
    const year = await safe("year", reads(tok, a, "day", daysAgo(400), daysAgo(39)));
    for (const r of year ?? []) days.push({ d: String(r.t).slice(0, 10), kwh: round(r.kwh, 2), cost: round(r.cost, 2) });
  }
  if (days.length) {
    const unique = [...new Map(days.map((d) => [d.d, d])).values()];
    const { error: e3 } = await db.from("home_energy_daily").upsert(
      unique.map((d) => ({ account: a.uuid, day: d.d, kwh: d.kwh, cost: d.cost, updated_at: new Date().toISOString() })),
    );
    if (e3) errors.push(`history: ${e3.message}`);
  }
  return { days: days.length, bill: !!bill, bills: billList?.length ?? 0, live: !!now, errors };
}

// ---------- connect ----------

async function connect(email: string, password: string, rawTotp?: string) {
  if (!email || !password) throw new UserError("Enter your Con Edison email and password.");
  const login: Login = { email: email.trim(), password, totp: rawTotp ? cleanSecret(rawTotp) : "" };
  if (login.totp) base32(login.totp); // checks the key's format before signing in
  const sess = await signIn(login, await loadSession());
  const { error } = await db.rpc("home_secret_set", { p_name: SECRET, p_secret: JSON.stringify(login) });
  if (error) throw error;
  await saveSession(sess);
  return await poll();
}

async function disconnect() {
  await db.rpc("home_secret_delete", { p_name: SECRET });
  await db.from("home_provider_sessions").delete().eq("provider", "coned");
  await db.from("home_devices").update({ enabled: false }).eq("id", DEVICE);
  return { ok: true };
}

Deno.serve(async (req) => {
  try {
    if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
    if (req.method === "GET") return json({ connected: !!(await loadLogin()) });
    const body = await req.json().catch(() => ({}));
    if (body.action === "connect") return json({ ok: true, ...(await connect(body.email, body.password, body.totp)) });
    if (body.action === "disconnect") return json(await disconnect());
    if (body.action === "poll") {
      if (!(await loadLogin())) return json({ connected: false });
      if (body.background) {
        EdgeRuntime.waitUntil(poll().catch((e) => console.error("coned poll failed:", (e as Error).message)));
        return json({ connected: true, started: true }, 202);
      }
      return json({ connected: true, ...(await poll()) });
    }
    return json({ error: "use GET, or POST with action connect, disconnect or poll" }, 400);
  } catch (err) {
    if (err instanceof NotConnected) return json({ error: err.message, not_connected: true }, 409);
    if (err instanceof UserError) return json({ error: err.message }, 400);
    return json({ error: String((err as Error).message ?? err) }, 502);
  }
});
