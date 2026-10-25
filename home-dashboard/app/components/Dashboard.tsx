"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Command, Device, Heater, HomeData, Light } from "@/lib/types";

const POLL_MS = 30_000;

// ---------- helpers ----------

function kelvinToHex(k: number) {
  const t = k / 100;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = t <= 66 ? 255 : clamp(329.698727446 * Math.pow(t - 60, -0.1332047592));
  const g = t <= 66 ? clamp(99.4708025861 * Math.log(t) - 161.1195681661) : clamp(288.1221695283 * Math.pow(t - 60, -0.0755148492));
  const b = t >= 66 ? 255 : t <= 19 ? 0 : clamp(138.5177312231 * Math.log(t - 10) - 305.0447927307);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function lightHex(l: Light) {
  const s = l.state;
  if (!s) return "#8a7f72";
  if (s.color_temp_k) return kelvinToHex(s.color_temp_k);
  if (s.color && s.color !== "#000000") return s.color;
  return "#ffd9a8";
}

function ago(iso: string | null, now: number) {
  if (!iso) return "never";
  const m = Math.round((now - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const MODE_LABEL: Record<string, string> = {
  off: "Off", energy_saver: "Energy saver", heat_pump: "Heat pump", high_demand: "High demand",
  electric: "Electric", gas: "Gas", vacation: "Vacation", performance: "Performance",
};
const modeLabel = (m: string) => MODE_LABEL[m] ?? m.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

// Group lights by room: a first word shared by two or more lights becomes a room.
function groupLights(lights: Light[]) {
  const first = (n: string) => n.trim().split(/\s+/)[0].toLowerCase();
  const counts = new Map<string, number>();
  lights.forEach((l) => counts.set(first(l.name), (counts.get(first(l.name)) ?? 0) + 1));
  const rooms = new Map<string, Light[]>();
  const loose: Light[] = [];
  for (const l of lights) {
    const k = first(l.name);
    if ((counts.get(k) ?? 0) > 1) {
      const room = k.charAt(0).toUpperCase() + k.slice(1);
      rooms.set(room, [...(rooms.get(room) ?? []), l]);
    } else loose.push(l);
  }
  const groups = [...rooms.entries()].map(([room, items]) => ({ room, items }));
  if (loose.length) groups.push({ room: groups.length ? "Around the apartment" : "Lights", items: loose });
  return groups;
}

// Drop the room word from a light's name inside its room ("Kitchen Left" shows as "Left").
const shortName = (name: string, room: string) => {
  const rest = name.trim().replace(new RegExp(`^${room}\\s+`, "i"), "");
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : name;
};

// ---------- main ----------

export default function Dashboard({ initial, initialError }: { initial: HomeData; initialError: string | null }) {
  const [data, setData] = useState<HomeData>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [toast, setToast] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const holdUntil = useRef(0); // ignore stale polls right after a command

  const load = useCallback(async () => {
    if (Date.now() < holdUntil.current) return;
    try {
      const r = await fetch("/api/home", { cache: "no-store" });
      if (r.status === 401) { window.location.href = "/login"; return; }
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setData(body);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/refresh", { method: "POST" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setData((d) => ({ ...d, devices: body.devices }));
      setError(null);
    } catch (e) {
      setToast(`Couldn't refresh: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(poll); clearInterval(tick); document.removeEventListener("visibilitychange", onVisible); };
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // Optimistic update, then send; on failure put the old state back and say why.
  const send = useCallback(async (device: Device, command: Command, patch: Record<string, unknown>) => {
    const before = data.devices;
    holdUntil.current = Date.now() + 8000;
    setData((d) => ({ ...d, devices: d.devices.map((x) => (x.id === device.id ? ({ ...x, state: { ...(x.state as object), ...patch } } as Device) : x)) }));
    try {
      const r = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: device.provider, device_id: device.id, command }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      // Read back the real state once the appliance has applied it.
      setTimeout(() => { holdUntil.current = 0; refresh(); }, device.kind === "water_heater" ? 6000 : 2500);
    } catch (e) {
      holdUntil.current = 0;
      setData((d) => ({ ...d, devices: before }));
      setToast(`${device.name}: ${(e as Error).message}`);
    }
  }, [data.devices, refresh]);

  const heaters = data.devices.filter((d): d is Heater => d.kind === "water_heater");
  const lights = data.devices.filter((d): d is Light => d.kind === "light");
  const groups = useMemo(() => groupLights(lights), [lights]);
  const lastUpdate = data.devices.map((d) => d.recorded_at).filter(Boolean).sort().at(-1) ?? null;
  const onCount = lights.filter((l) => l.state?.power && l.state?.online !== false).length;
  const adjustingLight = lights.find((l) => l.id === adjusting) ?? null;

  return (
    <div className="shell">
      <header className="top">
        <div>
          <h1 className="title">Home</h1>
          <p className="summary">
            {onCount === 0 ? "All lights are off" : `${onCount} ${onCount === 1 ? "light is" : "lights are"} on`}
            {heaters[0]?.state && (heaters[0].state.power ? `, hot water at ${heaters[0].state.setpoint_f}°` : ", water heater is off")}
          </p>
        </div>
        <div className="top-actions">
          <span className="updated" aria-live="polite">{data.mock ? "Sample data" : `Updated ${ago(lastUpdate, now)}`}</span>
          <button className="btn btn-quiet" onClick={refresh} disabled={refreshing}>{refreshing ? "Refreshing" : "Refresh"}</button>
        </div>
      </header>

      {error && <p className="banner" role="alert">Can't reach your home right now: {error}. Showing the last known state.</p>}

      <main className="layout">
        <section className="col-utilities" aria-label="Water and air">
          {heaters.map((h) => <HeaterPanel key={h.id} heater={h} history={data.history?.[h.id]} send={send} />)}
          <section className="ac-panel" aria-label="Air conditioning">
            <h2 className="panel-title">Air conditioning</h2>
            <p className="muted">Not connected yet. The AC will appear here once the ESP32 bridge is wired to the wall controller.</p>
          </section>
        </section>

        <section className="col-lights" aria-label="Lights">
          {groups.map((g) => (
            <section key={g.room} className="room">
              <div className="room-head">
                <h2 className="room-name">{g.room}</h2>
                {g.items.length > 1 && <RoomSwitch items={g.items} send={send} />}
              </div>
              <div className="tiles">
                {g.items.map((l) => (
                  <LightTile key={l.id} light={l} label={g.room === "Lights" || g.room === "Around the apartment" ? l.name : shortName(l.name, g.room)}
                    send={send} onAdjust={() => setAdjusting(l.id)} />
                ))}
              </div>
            </section>
          ))}
          {lights.length === 0 && <p className="muted">No lights yet. Add your Govee API key and they'll show up within five minutes.</p>}
        </section>
      </main>

      {adjustingLight && <AdjustSheet light={adjustingLight} send={send} onClose={() => setAdjusting(null)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

type Send = (d: Device, c: Command, patch: Record<string, unknown>) => void;

// ---------- water heater ----------

function HeaterPanel({ heater, history, send }: { heater: Heater; history?: { t: string; state: any }[]; send: Send }) {
  const s = heater.state;
  const caps = heater.capabilities;
  const [target, setTarget] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (!s) return null;

  const setpoint = target ?? s.setpoint_f ?? 120;
  const lo = caps.setpoint_min_f ?? 110, hi = caps.setpoint_max_f ?? 140;
  const tank = Math.max(0, Math.min(100, s.tank_pct ?? 0));
  const off = s.power === false || s.mode === "off";
  const modes = caps.modes.filter((m) => m !== "off");

  const nudge = (delta: number) => {
    const next = Math.max(lo, Math.min(hi, setpoint + delta));
    setTarget(next);
    if (timer.current) clearTimeout(timer.current);
    // Wait for the taps to settle, then send one change.
    timer.current = setTimeout(() => {
      send(heater, { action: "set_setpoint", value: next }, { setpoint_f: next });
      setTarget(null);
    }, 1200);
  };

  const points = (history ?? []).map((h) => h.state?.tank_pct).filter((v) => typeof v === "number") as number[];

  return (
    <section className={`heater ${off ? "is-off" : ""}`} aria-label={heater.name}>
      <div className="heater-head">
        <h2 className="panel-title">Hot water</h2>
        <span className={`dot ${s.connected ? "ok" : "bad"}`}>{s.connected ? (off ? "Off" : s.running ?? "Idle") : "Offline"}</span>
      </div>

      <div className="heater-body">
        <div className="tank" role="img" aria-label={`Tank ${tank}% full of hot water`}>
          <div className="tank-fill" style={{ height: `${tank}%` }} />
          <span className="tank-pct">{tank}%</span>
        </div>

        <div className="heater-controls">
          <div className="setpoint">
            <button className="step" onClick={() => nudge(-1)} disabled={setpoint <= lo} aria-label="Lower temperature">−</button>
            <output className="setpoint-value" aria-live="polite">{setpoint}<span className="deg">°F</span></output>
            <button className="step" onClick={() => nudge(1)} disabled={setpoint >= hi} aria-label="Raise temperature">+</button>
          </div>
          <p className="muted small">Set point, {lo} to {hi}°F</p>

          <div className="modes" role="radiogroup" aria-label="Mode">
            {modes.map((m) => (
              <button key={m} role="radio" aria-checked={!off && s.mode === m}
                className={`chip ${!off && s.mode === m ? "chip-on" : ""}`}
                onClick={() => send(heater, { action: "set_mode", mode: m }, { mode: m, power: true })}>
                {modeLabel(m)}
              </button>
            ))}
          </div>

          {caps.supports_power && (
            <button className={`btn ${off ? "btn-brass" : "btn-quiet"}`}
              onClick={() => send(heater, { action: "power", on: off }, { power: off, mode: off ? (modes[0] ?? "energy_saver") : "off" })}>
              {off ? "Turn on water heater" : "Turn off water heater"}
            </button>
          )}
        </div>
      </div>

      {points.length > 2 && <Spark points={points} />}
    </section>
  );
}

function Spark({ points }: { points: number[] }) {
  const w = 300, h = 40;
  const d = points.map((p, i) => `${i ? "L" : "M"}${(i / (points.length - 1)) * w},${h - (p / 100) * h}`).join(" ");
  return (
    <figure className="spark">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true"><path d={d} /></svg>
      <figcaption className="muted small">Hot water in the tank, last 24 hours</figcaption>
    </figure>
  );
}

// ---------- lights ----------

function LightTile({ light, label, send, onAdjust }: { light: Light; label: string; send: Send; onAdjust: () => void }) {
  const s = light.state;
  const unreachable = s?.online === false;
  const on = !!s?.power && !unreachable;
  const hex = lightHex(light);
  const strength = on ? 0.3 + 0.7 * ((s?.brightness ?? 100) / 100) : 0;

  return (
    <div className={`tile ${on ? "is-on" : ""} ${unreachable ? "is-unreachable" : ""}`}
      style={{ ["--glow" as string]: hex, ["--strength" as string]: strength }}>
      <button className="tile-main" onClick={() => send(light, { action: "power", on: !on }, { power: !on })}
        aria-pressed={on} disabled={unreachable} aria-label={`${light.name}, ${on ? "on" : "off"}`}>
        <span className="tile-name">{label}</span>
        <span className="tile-state">
          {unreachable ? "Unreachable. Check the wall switch." : on ? `On, ${s?.brightness ?? 100}%` : "Off"}
        </span>
      </button>
      {!unreachable && (
        <button className="tile-adjust" onClick={onAdjust} aria-label={`Adjust ${light.name}`}>Adjust</button>
      )}
    </div>
  );
}

function RoomSwitch({ items, send }: { items: Light[]; send: Send }) {
  const reachable = items.filter((l) => l.state?.online !== false);
  if (!reachable.length) return null;
  const anyOn = reachable.some((l) => l.state?.power);
  return (
    <button className="btn btn-quiet btn-small"
      onClick={() => reachable.forEach((l) => send(l, { action: "power", on: !anyOn }, { power: !anyOn }))}>
      {anyOn ? "Turn all off" : "Turn all on"}
    </button>
  );
}

const SWATCHES = ["#ffb15e", "#ffd9a8", "#ff6804", "#ff3b3b", "#c04bff", "#5b6cff", "#2fd3c4", "#7bdc5a"];

function AdjustSheet({ light, send, onClose }: { light: Light; send: Send; onClose: () => void }) {
  const s = light.state;
  const caps = light.capabilities;
  const [bright, setBright] = useState(s?.brightness ?? 100);
  const [kelvin, setKelvin] = useState(s?.color_temp_k ?? caps.color_temp_k?.min ?? 2700);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog ref={dialog} className="sheet" onClose={onClose} onClick={(e) => e.target === dialog.current && dialog.current?.close()}
      style={{ ["--glow" as string]: lightHex(light) }}>
      <div className="sheet-inner">
        <div className="sheet-head">
          <h2 className="panel-title">{light.name}</h2>
          <button className="btn btn-quiet btn-small" onClick={() => dialog.current?.close()}>Done</button>
        </div>

        {caps.brightness && (
          <label className="field">
            <span>Brightness <b>{bright}%</b></span>
            <input type="range" min={caps.brightness.min} max={caps.brightness.max} value={bright}
              onChange={(e) => setBright(Number(e.target.value))}
              onPointerUp={() => send(light, { action: "brightness", value: bright }, { brightness: bright, power: true })}
              onKeyUp={() => send(light, { action: "brightness", value: bright }, { brightness: bright, power: true })} />
          </label>
        )}

        {caps.color_temp_k && (
          <label className="field">
            <span>White, warm to cool <b>{kelvin}K</b></span>
            <input type="range" className="warmth" min={caps.color_temp_k.min} max={caps.color_temp_k.max} step={100} value={kelvin}
              onChange={(e) => setKelvin(Number(e.target.value))}
              onPointerUp={() => send(light, { action: "color_temp", kelvin }, { color_temp_k: kelvin, power: true })}
              onKeyUp={() => send(light, { action: "color_temp", kelvin }, { color_temp_k: kelvin, power: true })} />
          </label>
        )}

        {caps.color && (
          <div className="field">
            <span>Color</span>
            <div className="swatches">
              {SWATCHES.map((c) => (
                <button key={c} className="swatch" style={{ background: c }} aria-label={`Set color ${c}`}
                  onClick={() => send(light, { action: "color", hex: c }, { color: c, color_temp_k: null, power: true })} />
              ))}
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}
