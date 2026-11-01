"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Thermometer, ShieldCheck, ShieldAlert, Flame, Droplets, Sun, Tv, Moon, Power, Sliders, Sparkles, Activity, X,
  Palette, Check, Wind, LayoutGrid, Sofa, CookingPot, BedDouble, ChevronRight, ChevronDown, ListChecks, Zap,
  AlertTriangle, WifiOff, Info, Video, RefreshCw, Plug, type LucideIcon,
} from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import type { Activity as ActivityItem, Command, Device, Heater, HomeData, Light, Schedule } from "@/lib/types";
import { ScheduleEditor } from "./HeaterSchedule";

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

function hsvToHex(h: number, s: number, v: number) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return `#${[r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
}

function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return "";
  const m = Math.round((now - new Date(iso).getTime()) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h` : `${Math.round(h / 24)} d`;
}

const clockTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Rooms in screen order; each light's room comes from Supabase.
const ROOMS = [
  { id: "kitchen", name: "Kitchen", icon: CookingPot },
  { id: "living", name: "Living room", icon: Sofa },
  { id: "bedroom", name: "Bedroom", icon: BedDouble },
];
const roomIdOf = (l: Light) => {
  const r = (l.room ?? "").trim().toLowerCase();
  return r.startsWith("living") ? "living" : r || "other";
};
// Drop the room word from a light's name inside its room ("Kitchen Left" shows as "Left").
const shortName = (name: string, room: string) => {
  const rest = name.trim().replace(new RegExp(`^${room.split(" ")[0]}\\s+`, "i"), "");
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : name;
};

function describe(a: ActivityItem) {
  const c = a.command ?? {};
  const what =
    c.action === "power" ? (c.on ? "On" : "Off")
    : c.action === "brightness" ? `Brightness ${c.value}%`
    : c.action === "color" ? "Color changed"
    : c.action === "color_temp" ? `White ${c.kelvin}K`
    : c.action === "set_setpoint" ? `Set to ${c.value}°`
    : c.action === "set_mode" ? (c.mode === "off" ? "Off" : "On")
    : c.action === "set_state" ? (c.setpoint ? `Schedule ${c.setpoint}°` : "Schedule")
    : c.action ?? "Command";
  return `${a.device_name} • ${what}${a.status === "failed" ? " (failed)" : ""}`;
}

// ---------- shared pieces ----------

const PANEL = "bg-[#171310]/80 backdrop-blur-xl border border-white/10 rounded-3xl shadow-2xl";
const CYAN = "bg-cyan-500/10 text-cyan-400 border-cyan-500/20";
const AMBER = "bg-amber-500/10 text-amber-400 border-amber-500/20";
const GREEN = "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";

function PanelHead({ icon: Icon, tone, title, sub, right }: { icon: LucideIcon; tone: string; title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-white/10">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className={`p-2 rounded-xl border shrink-0 ${tone}`}><Icon className="w-4 h-4" /></div>
        <div className="min-w-0"><h2 className="text-[13px] font-bold text-white tracking-wide">{title}</h2>{sub && <p className="text-[11px] text-slate-400 truncate">{sub}</p>}</div>
      </div>
      {right}
    </div>
  );
}

function PowerBtn({ on, onClick, tone = "cyan", disabled, label }: { on: boolean; onClick?: () => void; tone?: "cyan" | "amber"; disabled?: boolean; label: string }) {
  const onCls = tone === "cyan" ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/40" : "bg-amber-500/20 text-amber-300 border-amber-500/40";
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label} aria-pressed={on}
      className={`w-10 h-10 shrink-0 flex items-center justify-center rounded-xl border transition-all active:scale-95 disabled:opacity-30 ${on ? onCls : "bg-white/5 text-slate-500 border-white/10"}`}>
      <Power className="w-4 h-4" />
    </button>
  );
}

function NotConnected({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="flex-1 min-h-[72px] rounded-2xl border border-dashed border-white/10 bg-black/20 flex flex-col items-center justify-center text-center gap-1.5 p-4">
      <Icon className="w-5 h-5 text-slate-600" />
      <p className="text-[12px] font-semibold text-slate-300">{title}</p>
      <p className="text-[11px] text-slate-500 max-w-[280px]">{text}</p>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => { setNow(new Date()); const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-lg font-bold font-mono tracking-tight text-slate-100 tabular-nums">{now ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--:--:--"}</span>
      <span className="text-[11px] text-slate-400 font-medium hidden md:inline">{now?.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span>
    </div>
  );
}

type Send = (d: Device, c: Command, patch: Record<string, unknown>) => void;
type Unit = "F" | "C";
const toUnit = (f: number, u: Unit) => (u === "C" ? Math.round((f - 32) * (5 / 9)) : f);

// ---------- lights ----------

function LightCard({ light, label, onOpen, big }: { light: Light; label: string; onOpen: () => void; big?: boolean }) {
  const s = light.state;
  const offline = s?.online === false;
  const on = !!s?.power && !offline;
  const hex = lightHex(light);
  return (
    <button onClick={onOpen} disabled={offline}
      className={`relative w-full text-left ${big ? "h-32 p-4" : "h-[84px] p-3"} rounded-2xl border transition-all duration-300 flex flex-col justify-between select-none overflow-hidden ${offline
        ? "bg-[#1e1916]/40 border-white/5 opacity-40"
        : on ? "bg-gradient-to-b from-[#2a211a] to-[#1c1511] border-amber-500/40 shadow-lg shadow-amber-950/40" : "bg-[#1e1916]/60 border-white/5"}`}>
      {on && <span className="absolute inset-x-0 bottom-0 h-2/3 opacity-35 pointer-events-none" style={{ background: `radial-gradient(circle at bottom, ${hex}, transparent 80%)` }} />}
      <span className="relative z-10 flex items-center justify-between gap-1 w-full">
        <span className={`${big ? "text-base" : "text-[13px]"} font-semibold text-white tracking-tight truncate`}>{label}</span>
        {on && <span className="w-2.5 h-2.5 rounded-full border border-white/30 shrink-0" style={{ backgroundColor: hex }} />}
      </span>
      <span className={`relative z-10 ${big ? "text-sm" : "text-[11px]"} font-medium ${offline ? "text-rose-400/90" : on ? "text-amber-200/90" : "text-slate-500"}`}>
        {offline ? "Offline" : on ? `On, ${s?.brightness ?? 100}%` : "Off"}
      </span>
    </button>
  );
}

function RoomButton({ room, lights, onOpen, onAll }: { room: (typeof ROOMS)[number]; lights: Light[]; onOpen: () => void; onAll: (on: boolean) => void }) {
  const Icon = room.icon;
  const reachable = lights.filter((l) => l.state?.online !== false);
  const onLights = reachable.filter((l) => l.state?.power);
  const offline = lights.length - reachable.length;
  const allOn = reachable.length > 0 && onLights.length === reachable.length;
  const glow = onLights[0] ? lightHex(onLights[0]) : null;
  return (
    <div className={`relative flex-1 min-h-[96px] rounded-2xl border flex items-center overflow-hidden transition-all ${onLights.length
      ? "bg-gradient-to-b from-[#2a211a] to-[#1c1511] border-amber-500/40 shadow-lg shadow-amber-950/40" : "bg-[#1e1916]/60 border-white/5"}`}>
      {glow && <span className="absolute inset-y-0 left-0 w-2/3 opacity-30 pointer-events-none" style={{ background: `radial-gradient(circle at left, ${glow}, transparent 75%)` }} />}
      <button onClick={onOpen} className="relative z-10 flex-1 min-w-0 h-full flex items-center gap-4 p-4 text-left active:scale-[0.99] transition-transform">
        <span className={`w-12 h-12 shrink-0 rounded-2xl flex items-center justify-center border ${onLights.length ? "bg-amber-500/15 border-amber-500/30 text-amber-300" : "bg-white/5 border-white/10 text-slate-500"}`}>
          <Icon className="w-5 h-5" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-1 text-[15px] font-semibold text-white">{room.name}<ChevronRight className="w-4 h-4 text-slate-500" /></span>
          <span className="block text-[12px] text-slate-400 mt-0.5">
            <span className={onLights.length ? "text-amber-200/90" : ""}>{onLights.length} of {lights.length} on</span>
            {offline > 0 && <span className="text-rose-400/80"> • {offline} offline</span>}
          </span>
          <span className="flex gap-1.5 mt-2">
            {lights.map((l) => (
              <span key={l.id} className="w-2.5 h-2.5 rounded-full border border-white/20"
                style={{ backgroundColor: l.state?.power && l.state?.online !== false ? lightHex(l) : "transparent", opacity: l.state?.online === false ? 0.35 : 1 }} />
            ))}
          </span>
        </span>
      </button>
      <button onClick={() => onAll(!allOn)} disabled={!reachable.length} aria-label={allOn ? `Turn off ${room.name} lights` : `Turn on ${room.name} lights`}
        className={`relative z-10 shrink-0 mr-4 h-11 px-3 flex items-center gap-1.5 rounded-xl border text-[11px] font-semibold transition-all active:scale-95 disabled:opacity-30 ${allOn
          ? "bg-amber-500 text-slate-950 border-amber-400 shadow-md shadow-amber-500/20" : "bg-white/5 text-slate-300 border-white/10"}`}>
        <Power className="w-3.5 h-3.5" />{allOn ? "All off" : "All on"}
      </button>
    </div>
  );
}

const PRESETS = ["#f59e0b", "#60a5fa", "#f43f5e", "#a855f7", "#10b981", "#06b6d4"];
const WHITES = [2700, 4000, 6500];

function LightSheet({ light, send, onClose }: { light: Light; send: Send; onClose: () => void }) {
  const s = light.state;
  const caps = light.capabilities;
  const on = !!s?.power;
  const [bright, setBright] = useState(s?.brightness ?? 100);
  const [preview, setPreview] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const hex = preview ?? lightHex(light);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !caps.color) return;
    const ctx = c.getContext("2d")!;
    const rad = c.width / 2;
    const img = ctx.createImageData(c.width, c.height);
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const dx = x - rad, dy = y - rad, d = Math.sqrt(dx * dx + dy * dy);
      if (d > rad) continue;
      let a = Math.atan2(dy, dx); if (a < 0) a += 2 * Math.PI;
      const h = hsvToHex(a / (2 * Math.PI), d / rad, 1);
      const i = (y * c.width + x) * 4;
      img.data[i] = parseInt(h.slice(1, 3), 16); img.data[i + 1] = parseInt(h.slice(3, 5), 16); img.data[i + 2] = parseInt(h.slice(5, 7), 16); img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [caps.color]);

  const pick = (e: React.PointerEvent) => {
    const c = canvas.current; if (!c) return null;
    const r = c.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * c.width - c.width / 2, y = ((e.clientY - r.top) / r.height) * c.height - c.height / 2;
    const d = Math.sqrt(x * x + y * y), rad = c.width / 2;
    if (d > rad) return null;
    let a = Math.atan2(y, x); if (a < 0) a += 2 * Math.PI;
    return hsvToHex(a / (2 * Math.PI), d / rad, 1);
  };
  const setColor = (c: string) => send(light, { action: "color", hex: c }, { color: c, color_temp_k: null, power: true });
  const commitBright = () => send(light, { action: "brightness", value: bright }, { brightness: bright, power: true });

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-[#1c1613] border border-white/15 rounded-3xl p-5 w-full max-w-sm shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b border-white/10 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="w-4 h-4 rounded-full border border-white/30" style={{ backgroundColor: on ? hex : "transparent" }} />
            <div><h3 className="text-sm font-bold text-white">{light.name}</h3><p className="text-[11px] text-slate-400">Color and brightness</p></div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => send(light, { action: "power", on: !on }, { power: !on })} aria-label={on ? "Turn off" : "Turn on"}
              className={`w-10 h-10 flex items-center justify-center rounded-xl border ${on ? "bg-amber-500 text-slate-950 border-amber-400" : "bg-white/5 text-slate-400 border-white/10"}`}><Power className="w-4 h-4" /></button>
            <button onClick={onClose} aria-label="Close" className="w-10 h-10 flex items-center justify-center rounded-xl bg-white/5 border border-white/10 text-slate-400"><X className="w-4 h-4" /></button>
          </div>
        </div>

        {caps.color && (
          <div className="flex flex-col items-center gap-2">
            <div className="p-2 rounded-full border border-white/10 bg-black/40 touch-none"
              onPointerDown={(e) => { dragging.current = true; (e.target as Element).setPointerCapture?.(e.pointerId); const c = pick(e); if (c) setPreview(c); }}
              onPointerMove={(e) => { if (!dragging.current) return; const c = pick(e); if (c) setPreview(c); }}
              onPointerUp={() => { dragging.current = false; if (preview) setColor(preview); }}>
              <canvas ref={canvas} width={180} height={180} className="rounded-full block" />
            </div>
            <span className="text-[10px] font-mono text-amber-400 uppercase bg-black/40 px-3 py-1 rounded-xl border border-white/10">{hex}</span>
          </div>
        )}

        {caps.color && (
          <div className="grid grid-cols-6 gap-1.5">
            {PRESETS.map((c) => (
              <button key={c} onClick={() => { setPreview(c); setColor(c); }} aria-label={`Color ${c}`} className="h-10 rounded-lg border border-white/10 flex items-center justify-center" style={{ backgroundColor: c }}>
                {hex.toLowerCase() === c && <Check className="w-4 h-4 text-slate-950" />}
              </button>
            ))}
          </div>
        )}

        {caps.color_temp_k && (
          <div className="grid grid-cols-3 gap-1.5">
            {WHITES.filter((k) => k >= caps.color_temp_k!.min && k <= caps.color_temp_k!.max).map((k) => (
              <button key={k} onClick={() => { setPreview(kelvinToHex(k)); send(light, { action: "color_temp", kelvin: k }, { color_temp_k: k, power: true }); }}
                className="h-10 rounded-lg border border-white/10 text-[11px] font-semibold text-slate-900" style={{ backgroundColor: kelvinToHex(k) }}>
                {k === 2700 ? "Warm" : k === 4000 ? "Neutral" : "Daylight"}
              </button>
            ))}
          </div>
        )}

        {caps.brightness && (
          <div className="space-y-1 pt-1 border-t border-white/10">
            <div className="flex justify-between text-[11px]"><span className="text-slate-300 font-medium">Brightness</span><span className="font-mono text-amber-400 font-bold">{bright}%</span></div>
            <input type="range" min={caps.brightness.min} max={caps.brightness.max} value={bright} aria-label="Brightness"
              onChange={(e) => setBright(Number(e.target.value))} onPointerUp={commitBright} onKeyUp={commitBright}
              className="w-full accent-amber-500 h-8" />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- water heater ----------

function useSetpoint(heater: Heater | undefined, send: Send) {
  const [target, setTarget] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lo = heater?.capabilities.setpoint_min_f ?? 110, hi = heater?.capabilities.setpoint_max_f ?? 140;
  const value = target ?? heater?.state?.setpoint_f ?? 120;
  const nudge = (d: number) => {
    if (!heater) return;
    const next = Math.max(lo, Math.min(hi, value + d));
    setTarget(next);
    if (timer.current) clearTimeout(timer.current);
    // Wait for the taps to settle, then send one change.
    timer.current = setTimeout(() => { send(heater, { action: "set_setpoint", value: next }, { setpoint_f: next }); setTarget(null); }, 1200);
  };
  return { value, nudge, lo, hi };
}

function HeaterPanel({ heater, send, unit, big }: { heater: Heater; send: Send; unit: Unit; big?: boolean }) {
  const s = heater.state;
  const { value, nudge, lo, hi } = useSetpoint(heater, send);
  const off = s?.power === false || s?.mode === "off";
  const tank = Math.max(0, Math.min(100, s?.tank_pct ?? 0));
  const onMode = heater.capabilities.modes.includes("energy_saver") ? "energy_saver" : heater.capabilities.modes.find((m) => m !== "off") ?? "energy_saver";
  const stepCls = `${big ? "w-14 h-14 text-2xl" : "w-11 h-11 text-lg"} rounded-xl bg-white/5 border border-white/10 text-white font-bold active:scale-95 disabled:opacity-30`;
  return (
    <>
      <div className="flex items-center justify-between bg-black/40 p-2 rounded-xl border border-white/5">
        <button onClick={() => nudge(-1)} disabled={value <= lo} aria-label="Lower temperature" className={stepCls}>−</button>
        <span className={`${big ? "text-5xl" : "text-3xl"} font-bold font-mono tabular-nums ${off ? "text-slate-600" : "text-white"}`}>{toUnit(value, unit)}°{unit}</span>
        <button onClick={() => nudge(1)} disabled={value >= hi} aria-label="Raise temperature" className={stepCls}>+</button>
      </div>
      <div className="space-y-1.5">
        <div className="flex justify-between items-center text-[11px]">
          <span className="text-slate-400 flex items-center gap-1"><Droplets className="w-3.5 h-3.5 text-cyan-400" /> Hot Water Level</span>
          <span className="font-mono text-cyan-400 font-bold">{s?.tank_pct ?? "--"}%</span>
        </div>
        <div className="w-full bg-white/10 h-2 rounded-full overflow-hidden p-0.5 border border-white/5">
          <div className={`h-full rounded-full transition-all duration-700 ${off ? "bg-slate-500" : "bg-gradient-to-r from-cyan-400 via-amber-400 to-amber-500"}`} style={{ width: `${tank}%` }} />
        </div>
      </div>
      {big && heater.capabilities.supports_power && (
        <button onClick={() => off
          ? send(heater, { action: "set_mode", mode: onMode }, { power: true, mode: onMode })
          : send(heater, { action: "power", on: false }, { power: false, mode: "off" })}
          className={`h-12 rounded-xl border text-sm font-semibold ${off ? "bg-amber-500 text-slate-950 border-amber-400" : "bg-white/5 text-slate-200 border-white/10"}`}>
          {off ? "Turn on water heater" : "Turn off water heater"}
        </button>
      )}
    </>
  );
}

function TankChart({ points }: { points: { time: string; tank: number }[] }) {
  if (points.length < 3) return <NotConnected icon={Activity} title="Collecting history" text="The tank chart fills in as readings arrive every 5 minutes." />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={points} margin={{ top: 5, right: 4, left: -22, bottom: 0 }}>
        <defs><linearGradient id="g-tank" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#f59e0b" stopOpacity={0.35} /><stop offset="95%" stopColor="#f59e0b" stopOpacity={0} /></linearGradient></defs>
        <XAxis dataKey="time" stroke="#64748b" fontSize={10} tickLine={false} minTickGap={40} />
        <YAxis stroke="#64748b" fontSize={10} tickLine={false} domain={[0, 100]} />
        <Tooltip contentStyle={{ backgroundColor: "#1c1511", borderColor: "#ffffff20", borderRadius: 8, fontSize: 11 }} formatter={(v) => [`${v}%`, "Tank"]} />
        <Area type="monotone" dataKey="tank" stroke="#f59e0b" fill="url(#g-tank)" strokeWidth={2} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

const DAY_ROWS = [{ d: 1, s: "MON" }, { d: 2, s: "TUE" }, { d: 3, s: "WED" }, { d: 4, s: "THU" }, { d: 5, s: "FRI" }, { d: 6, s: "SAT" }, { d: 0, s: "SUN" }];
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function WeekBars({ schedule }: { schedule: Schedule }) {
  return (
    <div className="space-y-2">
      {DAY_ROWS.map(({ d, s }) => (
        <div key={d} className="grid grid-cols-[44px_1fr] gap-2 items-center">
          <span className="text-[11px] font-mono text-slate-400">{s}</span>
          <div className="relative h-3.5 rounded-md bg-white/5 overflow-hidden">
            {schedule.blocks.filter((b) => b.day === d).map((b, i) => {
              const a = toMin(b.start), z = toMin(b.stop) > a ? toMin(b.stop) : 1440;
              return <span key={i} title={`${b.start} to ${b.stop}, ${b.command.setpoint}°`}
                className={`absolute inset-y-0 rounded-md ${schedule.enabled ? "bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.5)]" : "bg-slate-600"}`}
                style={{ left: `${(a / 1440) * 100}%`, width: `${((z - a) / 1440) * 100}%` }} />;
            })}
          </div>
        </div>
      ))}
      <div className="grid grid-cols-[44px_1fr] gap-2"><span /><div className="flex justify-between text-[10px] font-mono text-slate-500"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div></div>
    </div>
  );
}

// ---------- main ----------

export default function Dashboard({ initial, initialError }: { initial: HomeData; initialError: string | null }) {
  const [data, setData] = useState<HomeData>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [toast, setToast] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [section, setSection] = useState("overview");
  const [unit, setUnit] = useState<Unit>("F");
  const [scene, setScene] = useState<string | null>(null);
  const [lightId, setLightId] = useState<string | null>(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [editingSchedule, setEditingSchedule] = useState(false);
  const holdUntil = useRef(0); // ignore stale polls right after a command

  // Sample screens can open on a section with ?s=water; the unit choice is remembered per device.
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get("s");
    if (s) setSection(s);
    try { const u = localStorage.getItem("hq-unit"); if (u === "C" || u === "F") setUnit(u); } catch {}
  }, []);
  const chooseUnit = (u: Unit) => { setUnit(u); try { localStorage.setItem("hq-unit", u); } catch {} };

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
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(poll); document.removeEventListener("visibilitychange", onVisible); };
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // Optimistic update, then send; on failure put the old state back and say why.
  const send = useCallback<Send>(async (device, command, patch) => {
    holdUntil.current = Date.now() + 8000;
    let before: Device | undefined;
    setData((d) => ({ ...d, devices: d.devices.map((x) => { if (x.id !== device.id) return x; before = x; return { ...x, state: { ...(x.state as object), ...patch } } as Device; }) }));
    try {
      const r = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: device.provider, device_id: device.id, command }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setTimeout(() => { holdUntil.current = 0; refresh(); }, device.kind === "water_heater" ? 6000 : 2500);
    } catch (e) {
      holdUntil.current = 0;
      if (before) setData((d) => ({ ...d, devices: d.devices.map((x) => (x.id === device.id ? before! : x)) }));
      setToast(`${device.name}: ${(e as Error).message}`);
    }
  }, [refresh]);

  const heater = data.devices.find((d): d is Heater => d.kind === "water_heater");
  const lights = useMemo(() => data.devices.filter((d): d is Light => d.kind === "light"), [data.devices]);
  const acs = data.devices.filter((d) => d.kind === "ac");
  const lightsIn = useCallback((roomId: string) => lights.filter((l) => roomIdOf(l) === roomId).sort((a, b) => a.name.localeCompare(b.name)), [lights]);
  const roomName = (id: string) => ROOMS.find((r) => r.id === id)?.name ?? "Other";
  const openLight = lights.find((l) => l.id === lightId) ?? null;
  const otherLights = lights.filter((l) => !ROOMS.some((r) => r.id === roomIdOf(l)));

  const setRoom = (roomId: string, on: boolean) =>
    lightsIn(roomId).filter((l) => l.state?.online !== false && !!l.state?.power !== on).forEach((l) => send(l, { action: "power", on }, { power: on }));

  // Scenes switch the lights now; the AC parts join once the bridges are installed.
  const applyScene = (name: string) => {
    setScene(name);
    const want = (l: Light): { on: boolean; brightness?: number } => {
      const n = shortName(l.name, roomName(roomIdOf(l))).toLowerCase();
      if (name === "Home") return { on: ["left", "middle", "floor lamp"].includes(n) || !!l.state?.power };
      if (name === "Movie") return n === "tv backlight" ? { on: true, brightness: 75 } : { on: false };
      return { on: false }; // Sleep and Away
    };
    lights.filter((l) => l.state?.online !== false).forEach((l) => {
      const w = want(l);
      if (w.on && w.brightness && l.state?.brightness !== w.brightness) send(l, { action: "brightness", value: w.brightness }, { brightness: w.brightness, power: true });
      else if (!!l.state?.power !== w.on) send(l, { action: "power", on: w.on }, { power: w.on });
    });
    setTimeout(() => setScene(null), 4000);
  };

  // The water heater schedule, kept current for the Water tab and the overview line.
  const loadSchedule = useCallback(async () => {
    if (!heater) return;
    try {
      const r = await fetch(`/api/schedule?device_id=${encodeURIComponent(heater.id)}`, { cache: "no-store" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setSchedule(body);
    } catch (e) {
      setToast(`Couldn't load the schedule: ${(e as Error).message}`);
    }
  }, [heater?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadSchedule(); const t = setInterval(loadSchedule, 60_000); return () => clearInterval(t); }, [loadSchedule]);

  const toggleSchedule = async () => {
    if (!heater || !schedule) return;
    try {
      const r = await fetch("/api/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: heater.id, enabled: !schedule.enabled }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setSchedule(body);
    } catch (e) {
      setToast(`Couldn't change the schedule: ${(e as Error).message}`);
    }
  };

  const tankPoints = useMemo(() => {
    const h = heater ? data.history?.[heater.id] ?? [] : [];
    const pts = h.filter((x) => typeof x.state?.tank_pct === "number");
    const step = Math.max(1, Math.ceil(pts.length / 96));
    return pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((x) => ({ time: clockTime(x.t), tank: x.state.tank_pct as number }));
  }, [data.history, heater]);

  // Alerts, compiled from the latest readings and their history.
  const alerts = useMemo(() => {
    const out: { id: string; level: "warn" | "info"; icon: LucideIcon; text: string; since?: string }[] = [];
    if (error) out.push({ id: "conn", level: "warn", icon: WifiOff, text: "Can't reach your home right now" });
    const lastOnline = (id: string) => [...(data.history?.[id] ?? [])].reverse().find((r) => r.state?.online !== false)?.t;
    lights.filter((l) => l.state?.online === false).forEach((l) => {
      const room = roomName(roomIdOf(l));
      out.push({ id: l.id, level: "warn", icon: WifiOff, text: `${l.name.toLowerCase().startsWith(room.split(" ")[0].toLowerCase()) ? l.name : `${room} ${l.name}`} offline`, since: ago(lastOnline(l.id)) || undefined });
    });
    const hs = heater?.state;
    if (heater && hs && !hs.connected) out.push({ id: "heater-off", level: "warn", icon: WifiOff, text: "Water heater offline" });
    if (hs?.alert_count) out.push({ id: "heater-alert", level: "warn", icon: AlertTriangle, text: `Water heater has ${hs.alert_count} alert${hs.alert_count > 1 ? "s" : ""} in the Rheem app` });
    if (hs && hs.power !== false && typeof hs.tank_pct === "number" && hs.tank_pct < 25) out.push({ id: "tank-low", level: "info", icon: Droplets, text: `Hot water low, ${hs.tank_pct}%` });
    return out;
  }, [error, lights, heater, data.history]); // eslint-disable-line react-hooks/exhaustive-deps

  const lightsOn = lights.filter((l) => l.state?.power && l.state?.online !== false).length;
  const onIn = (room: string) => lightsIn(room).filter((l) => l.state?.power && l.state?.online !== false).length;
  const lastUpdate = data.devices.map((d) => d.recorded_at).filter(Boolean).sort().at(-1) ?? null;

  const tabs: { id: string; label: string; icon: LucideIcon; meta?: string }[] = [
    { id: "overview", label: "Overview", icon: LayoutGrid },
    { id: "living", label: "Living", icon: Sofa, meta: `${onIn("living")} on` },
    { id: "kitchen", label: "Kitchen", icon: CookingPot, meta: `${onIn("kitchen")} on` },
    { id: "bedroom", label: "Bedroom", icon: BedDouble, meta: `${onIn("bedroom")} on` },
    { id: "water", label: "Water", icon: Flame, meta: heater?.state?.tank_pct != null ? `${heater.state.tank_pct}%` : undefined },
    { id: "camera", label: "Camera", icon: Video },
  ];

  // ---------- pieces that need dashboard state ----------

  const unitToggle = (
    <div className="flex items-center bg-black/60 p-1 rounded-xl border border-cyan-500/30 shadow-md">
      {(["F", "C"] as Unit[]).map((u) => (
        <button key={u} onClick={() => chooseUnit(u)} aria-pressed={unit === u}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${unit === u ? "bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/30 font-black" : "text-slate-400"}`}>°{u}</button>
      ))}
    </div>
  );

  const roomLights = (roomId: string, cols: number, big?: boolean) => {
    const list = lightsIn(roomId);
    return (
      <div className="space-y-2" key={roomId}>
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold text-slate-200 tracking-tight">{roomName(roomId)}</span>
          <button onClick={() => setRoom(roomId, false)} className="px-3 py-1.5 rounded-full text-[11px] text-slate-400 bg-white/5 border border-white/10 active:scale-95 font-medium">Turn all off</button>
        </div>
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {list.map((l) => <LightCard key={l.id} light={l} label={shortName(l.name, roomName(roomId))} onOpen={() => setLightId(l.id)} big={big} />)}
        </div>
        {list.length === 0 && <p className="text-[11px] text-slate-500">No lights in this room yet.</p>}
      </div>
    );
  };

  const acRow = (name: string, room: string) => (
    <button onClick={() => setSection(room)} className="w-full bg-black/30 p-3 rounded-2xl border border-white/5 flex items-center gap-2.5 text-left">
      <span className="flex-1 min-w-0">
        <span className="text-[13px] font-bold text-white flex items-center gap-1 whitespace-nowrap"><Wind className="w-3.5 h-3.5 text-cyan-400 shrink-0" />{name}<ChevronRight className="w-3.5 h-3.5 text-slate-500" /></span>
        <span className="text-[11px] text-slate-500">Bridge not installed yet</span>
      </span>
      <span className="w-[68px] text-center text-2xl font-bold font-mono text-slate-700">--°</span>
      <PowerBtn on={false} disabled label={`${name} AC power`} />
    </button>
  );

  const acZone = (name: string) => (
    <div className={`${PANEL} lg:col-span-7 p-5 flex flex-col gap-4 min-h-0`}>
      <PanelHead icon={Wind} tone={CYAN} title={`${name} AC`} sub="LG ducted unit • ESP32 bridge not installed yet" right={<div className="flex items-center gap-2">{unitToggle}<PowerBtn on={false} disabled label="AC power" /></div>} />
      <div className="flex items-center justify-center py-2">
        <div className="relative w-56 h-56">
          <svg viewBox="0 0 250 250" className="w-full h-full" aria-hidden="true">
            <circle cx="125" cy="125" r="105" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="12" strokeDasharray="495 660" strokeLinecap="round" transform="rotate(135 125 125)" />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[10px] font-mono text-slate-500 tracking-widest">SET TO</span>
            <span className="text-6xl font-bold font-mono text-slate-700">--°</span>
            <span className="text-[11px] font-mono text-slate-600 uppercase tracking-wider">Not connected</span>
          </div>
        </div>
      </div>
      <NotConnected icon={Plug} title="AC controls arrive with the bridge" text="Mode, fan speed and set temperature will work here, synced with the wall controller, once the ESP32 is wired in." />
    </div>
  );

  // ---------- views ----------

  const overview = (
    <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0 z-10">
      <div className="lg:col-span-4 flex flex-col gap-3 min-h-0">
        <div className={`${PANEL} p-3.5 flex flex-col gap-2.5 shrink-0`}>
          <PanelHead icon={Thermometer} tone={CYAN} title="Climate Controls" sub="Dual LG zones" right={unitToggle} />
          {acs.length === 0 ? <>{acRow("Living", "living")}{acRow("Bedroom", "bedroom")}</> : null}
        </div>
        <div className={`flex-1 min-h-[240px] ${PANEL} p-3.5 flex flex-col gap-2.5`}>
          <PanelHead icon={Video} tone={AMBER} title="Living Room Camera" sub="Ring" />
          <NotConnected icon={Video} title="Ring camera not connected yet" text="Snapshots, motion events and your Ring mode will show here, with a button to open live view in the Ring app." />
        </div>
      </div>

      <div className="lg:col-span-4 flex flex-col gap-3 min-h-0">
        <div className={`${PANEL} p-3.5 flex flex-col gap-3 shrink-0`}>
          {heater ? (
            <>
              <PanelHead icon={Flame} tone={AMBER} title="Water Heater"
                sub={`${heater.state?.connected === false ? "Offline" : heater.state?.power === false ? "Off" : heater.state?.running ?? "Idle"} • schedule ${schedule?.enabled ? "on" : "off"}`}
                right={<button onClick={() => setSection("water")} className="px-3 h-9 rounded-xl text-[11px] font-medium bg-white/5 border border-white/10 text-slate-300 flex items-center gap-1">Details<ChevronRight className="w-3.5 h-3.5" /></button>} />
              <HeaterPanel heater={heater} send={send} unit={unit} />
            </>
          ) : <NotConnected icon={Flame} title="No water heater" text="It shows up here once the Rheem function reports it." />}
        </div>
        <div className={`flex-1 min-h-[160px] ${PANEL} p-3.5 flex flex-col gap-2`}>
          <PanelHead icon={Zap} tone={GREEN} title="Power & Energy" sub="Who is using power today" />
          <NotConnected icon={Zap} title="Coming with Con Edison and the AC" text="A breakdown of today's power by AC, water heater, lights and everything else." />
        </div>
        <div className={`${PANEL} p-3.5 flex flex-col gap-2 shrink-0`}>
          <PanelHead icon={Zap} tone={GREEN} title="Electricity" sub="Con Edison" />
          <NotConnected icon={Plug} title="Con Edison not connected yet" text="Bill so far, projected bill and daily usage, updated once a day." />
        </div>
      </div>

      <div className={`lg:col-span-4 ${PANEL} p-4 flex flex-col gap-3 min-h-0`}>
        <PanelHead icon={Palette} tone={AMBER} title="Lighting Console" sub={`${lightsOn} on • tap a room for its lights`} />
        <div className="flex-1 min-h-0 flex flex-col gap-3">
          {ROOMS.map((r) => <RoomButton key={r.id} room={r} lights={lightsIn(r.id)} onOpen={() => setSection(r.id)} onAll={(on) => setRoom(r.id, on)} />)}
          {otherLights.length > 0 && <div className="grid grid-cols-2 gap-2">{otherLights.map((l) => <LightCard key={l.id} light={l} label={l.name} onOpen={() => setLightId(l.id)} />)}</div>}
        </div>
        <div className="pt-2 border-t border-white/5 flex items-center justify-between text-[11px] text-slate-400">
          <span className="flex items-center gap-1"><Sliders className="w-3 h-3 text-amber-500" /> Color and brightness inside each room</span>
          <span className="text-[10px] font-mono text-slate-500">Govee Cloud</span>
        </div>
      </div>
    </main>
  );

  const zoneView = (room: "living" | "bedroom") => (
    <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0 z-10">
      {acZone(room === "living" ? "Living Room" : "Bedroom")}
      <div className="lg:col-span-5 flex flex-col gap-3 min-h-0">
        <div className={`${PANEL} p-4 space-y-3`}>
          <PanelHead icon={Palette} tone={AMBER} title="Lights" sub="Tap a card for color and brightness" />
          {room === "living" ? <>{roomLights("living", 2)}{roomLights("kitchen", 2)}</> : roomLights("bedroom", 2)}
        </div>
        <div className={`flex-1 min-h-[140px] ${PANEL} p-4 flex flex-col gap-2`}>
          <PanelHead icon={Activity} tone={GREEN} title="Room Temperature" sub="Last 24 hours" />
          <NotConnected icon={Thermometer} title="Arrives with the AC bridge" text="The indoor unit's own sensor will chart this room's temperature." />
        </div>
      </div>
    </main>
  );

  const kitchenView = (
    <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0 z-10">
      <div className={`lg:col-span-8 ${PANEL} p-5 flex flex-col gap-4`}>
        <PanelHead icon={Palette} tone={AMBER} title="Kitchen Lights" sub={`${onIn("kitchen")} on • tap a card for color and brightness`}
          right={<button onClick={() => setRoom("kitchen", !lightsIn("kitchen").some((l) => l.state?.power && l.state?.online !== false))}
            className="px-3 h-10 rounded-xl text-xs text-slate-200 bg-white/5 border border-white/10 font-medium flex items-center gap-1.5"><Power className="w-3.5 h-3.5" />{onIn("kitchen") ? "All off" : "All on"}</button>} />
        <div className="grid grid-cols-2 gap-3">
          {lightsIn("kitchen").map((l) => <LightCard key={l.id} light={l} label={shortName(l.name, "Kitchen")} onOpen={() => setLightId(l.id)} big />)}
        </div>
      </div>
      <div className="lg:col-span-4 flex flex-col gap-3">
        <div className={`${PANEL} p-4 flex flex-col gap-3`}>
          <PanelHead icon={Wind} tone={CYAN} title="Shared AC" sub="Kitchen and living room are one zone" />
          <NotConnected icon={Plug} title="Bridge not installed yet" text="This zone's AC will show here once it's connected." />
          <button onClick={() => setSection("living")} className="py-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-sm font-semibold">Open living room</button>
        </div>
      </div>
    </main>
  );

  const waterView = (
    <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0 z-10">
      <div className={`lg:col-span-5 ${PANEL} p-5 flex flex-col gap-4`}>
        {heater ? (
          <>
            <PanelHead icon={Flame} tone={AMBER} title="Water Heater" sub={`Rheem heat pump • ${heater.state?.connected === false ? "offline" : heater.state?.running ?? "idle"}`} right={unitToggle} />
            <div className="flex gap-4 flex-1 min-h-[220px]">
              <div className="relative w-24 rounded-[48px] bg-black/60 border border-white/10 overflow-hidden" role="img" aria-label={`Tank ${heater.state?.tank_pct ?? 0}% full`}>
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-amber-600 via-amber-400 to-cyan-300 transition-all duration-700" style={{ height: `${heater.state?.tank_pct ?? 0}%` }} />
                <span className="absolute inset-x-0 bottom-4 text-center font-mono font-bold text-slate-950">{heater.state?.tank_pct ?? "--"}%</span>
              </div>
              <div className="flex-1 flex flex-col justify-center gap-4"><HeaterPanel heater={heater} send={send} unit={unit} big /></div>
            </div>
          </>
        ) : <NotConnected icon={Flame} title="No water heater" text="It shows up here once the Rheem function reports it." />}
      </div>
      <div className="lg:col-span-7 flex flex-col gap-3 min-h-0">
        <div className={`${PANEL} p-4 space-y-3`}>
          <PanelHead icon={Sliders} tone={AMBER} title="Weekly Schedule"
            sub={schedule ? (schedule.enabled ? (schedule.active ? `On now until ${schedule.active.stop}` : schedule.next ? `Next at ${schedule.next.start}` : "On") : "Off • the heater only changes when you change it") : "Loading"}
            right={schedule && (
              <div className="flex items-center gap-2">
                <button role="switch" aria-checked={schedule.enabled} aria-label="Follow schedule" onClick={toggleSchedule} disabled={!schedule.blocks.length}
                  className={`relative w-[52px] h-8 rounded-full transition-colors ${schedule.enabled ? "bg-amber-500" : "bg-white/10"}`}>
                  <span className={`absolute top-1 left-1 w-6 h-6 rounded-full transition-transform ${schedule.enabled ? "translate-x-5 bg-slate-950" : "bg-slate-200"}`} />
                </button>
                <button onClick={() => setEditingSchedule(true)} className="px-3 h-9 rounded-xl text-xs text-slate-200 bg-white/5 border border-white/10 font-medium">Edit</button>
              </div>
            )} />
          {schedule && <WeekBars schedule={schedule} />}
        </div>
        <div className={`flex-1 min-h-[180px] ${PANEL} p-4 flex flex-col gap-2`}>
          <PanelHead icon={Activity} tone={GREEN} title="Hot Water in Tank" sub="Last 24 hours" />
          <div className="h-[240px] flex"><TankChart points={tankPoints} /></div>
        </div>
      </div>
    </main>
  );

  const cameraView = (
    <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0 z-10">
      <div className={`lg:col-span-8 ${PANEL} p-4 flex flex-col gap-3 min-h-[320px]`}>
        <PanelHead icon={Video} tone={AMBER} title="Living Room Camera" sub="Ring" />
        <NotConnected icon={Video} title="Ring camera not connected yet" text="Once your Ring account is linked, this shows the latest snapshot with zoom, a refresh button and Live view in the Ring app." />
      </div>
      <div className="lg:col-span-4 flex flex-col gap-3 min-h-0">
        <div className={`${PANEL} p-4 space-y-3`}>
          <PanelHead icon={ShieldCheck} tone={GREEN} title="Ring Mode" sub="Same modes as the Ring app" />
          <div className="grid grid-cols-3 gap-1 p-1 bg-black/50 rounded-xl border border-white/5 opacity-40">
            {["Disarmed", "Home", "Away"].map((m) => <span key={m} className="py-3 rounded-lg text-xs font-semibold text-center text-slate-400">{m}</span>)}
          </div>
        </div>
        <div className={`flex-1 min-h-[160px] ${PANEL} p-4 flex flex-col gap-2`}>
          <PanelHead icon={ShieldAlert} tone={AMBER} title="Recent Events" sub="Motion and mode changes" />
          <NotConnected icon={ShieldAlert} title="No events yet" text="Motion and mode changes from Ring will list here." />
        </div>
      </div>
    </main>
  );

  const activity = data.activity ?? [];

  return (
    <div className="min-h-[100dvh] lg:h-[100dvh] w-full bg-[#110e0c] text-slate-100 font-sans select-none lg:overflow-hidden flex flex-col gap-3 relative antialiased"
      style={{ padding: "max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left))" }}>
      <div className="fixed top-0 left-1/3 w-[600px] h-[600px] bg-amber-600/10 rounded-full blur-[180px] pointer-events-none" />
      <div className="fixed bottom-0 right-1/4 w-[500px] h-[500px] bg-indigo-600/10 rounded-full blur-[180px] pointer-events-none" />

      <header className="min-h-14 bg-[#1a1512]/80 backdrop-blur-2xl border border-white/10 rounded-2xl px-4 py-2 flex flex-wrap items-center justify-between gap-3 shrink-0 shadow-2xl relative z-30">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-amber-500 to-amber-700 flex items-center justify-center text-white shadow-lg shadow-amber-500/20"><Sparkles className="w-4 h-4" /></div>
            <div className="hidden sm:block">
              <h1 className="text-sm font-semibold text-white leading-tight">Home Command Center</h1>
              <p className="text-[9px] text-amber-400/80 font-mono tracking-wider">{data.mock ? "SAMPLE DATA" : `UPDATED ${ago(lastUpdate).toUpperCase() || "NOW"}${ago(lastUpdate) && ago(lastUpdate) !== "now" ? " AGO" : ""}`}</p>
            </div>
          </div>
          <div className="h-5 w-px bg-white/10 hidden sm:block" />
          <Clock />
          <div className="h-5 w-px bg-white/10 hidden md:block" />
          <div className="relative">
            <button onClick={() => setAlertsOpen((o) => !o)} aria-expanded={alertsOpen}
              className={`h-9 flex items-center gap-2 pl-2.5 pr-2 rounded-xl border text-[11px] font-medium transition-all active:scale-95 ${alerts.some((a) => a.level === "warn") ? "bg-rose-500/10 border-rose-500/30 text-rose-300" : "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"}`}>
              {alerts.length ? <AlertTriangle className="w-3.5 h-3.5" /> : <ShieldCheck className="w-3.5 h-3.5" />}
              {alerts.length > 0 && <span className="font-mono font-bold">{alerts.length}</span>}
              <span className="max-w-[170px] truncate text-slate-300 hidden md:inline">{alerts[0]?.text ?? "All systems normal"}</span>
              <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${alertsOpen ? "rotate-180" : ""}`} />
            </button>
            {alertsOpen && (
              <div className="absolute left-0 top-11 w-80 max-w-[calc(100vw-32px)] bg-[#1c1613] border border-white/15 rounded-2xl p-2 shadow-2xl z-40">
                <p className="text-[10px] font-mono text-slate-500 tracking-wider px-2 py-1">ALERTS</p>
                {alerts.length === 0 && <p className="px-2 py-2 text-[12px] text-slate-400">Nothing needs attention.</p>}
                {alerts.map((a) => (
                  <div key={a.id} className="flex items-center gap-2.5 px-2 py-2">
                    <span className={`w-7 h-7 shrink-0 rounded-lg flex items-center justify-center border ${a.level === "warn" ? "bg-rose-500/10 border-rose-500/25 text-rose-400" : "bg-cyan-500/10 border-cyan-500/25 text-cyan-400"}`}><a.icon className="w-3.5 h-3.5" /></span>
                    <span className="flex-1 text-[12px] text-slate-200">{a.text}</span>
                    {a.since && <span className="text-[10px] font-mono text-slate-500">{a.since}</span>}
                  </div>
                ))}
                <div className="mt-1 pt-2 border-t border-white/10">
                  <p className="text-[10px] font-mono text-slate-500 tracking-wider px-2 py-1 flex items-center gap-1"><ListChecks className="w-3 h-3" /> RECENT ACTIVITY</p>
                  {activity.length === 0 && <p className="px-2 py-1.5 text-[12px] text-slate-500">Nothing in the last 24 hours.</p>}
                  {activity.slice(0, 8).map((e) => (
                    <div key={e.id} className="flex items-center justify-between gap-2 px-2 py-1.5 text-[12px] text-slate-300">
                      <span className="truncate">{describe(e)}</span><span className="font-mono text-[10px] text-slate-500 shrink-0">{clockTime(e.t)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button onClick={refresh} disabled={refreshing} aria-label="Refresh now"
            className="w-9 h-9 flex items-center justify-center rounded-xl bg-white/5 border border-white/10 text-slate-400 active:scale-95">
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          {([["Home", Sun], ["Movie", Tv], ["Sleep", Moon], ["Away", ShieldCheck]] as [string, LucideIcon][]).map(([id, Icon]) => {
            const active = scene === id;
            return (
              <button key={id} onClick={() => applyScene(id)}
                className={`flex items-center gap-1.5 px-3.5 h-9 rounded-xl text-xs font-medium transition-all active:scale-95 ${active ? "bg-amber-500 text-slate-950 font-semibold shadow-lg shadow-amber-500/20" : "bg-white/5 text-slate-400 border border-white/5"}`}>
                <Icon className={`w-3.5 h-3.5 ${active ? "text-slate-950" : "text-slate-400"}`} />{id}
              </button>
            );
          })}
        </div>
      </header>

      <nav className="bg-[#1a1512]/80 backdrop-blur-2xl border border-white/10 rounded-2xl p-1.5 flex gap-1.5 shrink-0 z-10 overflow-x-auto scrollbar-none" aria-label="Sections">
        {tabs.map(({ id, label, icon: Icon, meta }) => {
          const active = section === id;
          return (
            <button key={id} onClick={() => setSection(id)} aria-current={active ? "page" : undefined}
              className={`flex-1 min-w-[96px] h-10 flex items-center justify-center gap-2 rounded-xl text-[13px] font-medium transition-all ${active ? "bg-white/10 text-white border border-amber-500/40 shadow-lg shadow-amber-950/30" : "text-slate-400 border border-transparent"}`}>
              <Icon className={`w-4 h-4 ${active ? "text-amber-400" : "text-slate-500"}`} />{label}
              {meta && <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md ${active ? "bg-amber-500/15 text-amber-300" : "bg-white/5 text-slate-500"}`}>{meta}</span>}
            </button>
          );
        })}
      </nav>

      {error && <p role="alert" className="shrink-0 z-10 text-[12px] px-4 py-2 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200">Can&apos;t reach your home right now: {error}. Showing the last known state.</p>}

      {section === "overview" && overview}
      {section === "living" && zoneView("living")}
      {section === "bedroom" && zoneView("bedroom")}
      {section === "kitchen" && kitchenView}
      {section === "water" && waterView}
      {section === "camera" && cameraView}

      {openLight && <LightSheet key={openLight.id} light={openLight} send={send} onClose={() => setLightId(null)} />}
      {editingSchedule && heater && schedule && (
        <ScheduleEditor heater={heater} schedule={schedule} notify={setToast}
          onClose={() => setEditingSchedule(false)} onSaved={(s) => { setSchedule(s); setEditingSchedule(false); setToast("Schedule saved."); }} />
      )}
      {toast && <div role="status" className="fixed left-1/2 -translate-x-1/2 bottom-6 z-50 max-w-[calc(100vw-32px)] px-4 py-3 rounded-2xl bg-[#1c1613] border border-white/15 text-[13px] text-slate-100 shadow-2xl">{toast}</div>}
    </div>
  );
}
