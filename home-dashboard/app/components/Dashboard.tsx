"use client";

import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Thermometer, ShieldCheck, ShieldAlert, Flame, Droplets, Sun, Tv, Moon, Power, Sliders, Activity, X,
  Palette, Check, Wind, LayoutGrid, Sofa, CookingPot, BedDouble, ChevronRight, ChevronDown, ListChecks, Zap,
  AlertTriangle, WifiOff, Video, Lock, LockOpen, DoorClosed, Fan, ChartColumn, Lightbulb, Calendar as CalendarIcon, RefreshCw, Plug, Home as HomeIcon, Undo2, Volume1, Volume2, VolumeX, Footprints, ZoomIn, ZoomOut, UserRound, BellRing, LogOut, ExternalLink, type LucideIcon,
} from "lucide-react";
import { AreaChart, Area, BarChart, Bar, Cell, ReferenceArea, ReferenceDot, ReferenceLine, XAxis, YAxis, Tooltip } from "recharts";
import type { Activity as ActivityItem, Analytics, Camera, CameraEvent, Command, Device, Heater, HomeData, Light, Meter, Schedule, TV } from "@/lib/types";
import { ScheduleEditor } from "./HeaterSchedule";

const POLL_MS = 30_000;
const DESIGN_WIDTH = 1180;

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
    : c.action === "scene" ? `${c.name} scene`
    : c.action === "set_setpoint" ? `Set to ${c.value}°`
    : c.action === "set_mode" ? (c.mode === "off" ? "Off" : "On")
    : c.action === "set_state" ? (c.mode === "off" ? "Schedule off" : c.setpoint ? `Schedule ${c.setpoint}°` : "Schedule")
    : c.action === "launch" ? `Open ${TV_APPS.find((x) => x.pkg === c.app)?.name ?? "app"}`
    : c.action === "home" ? "Home"
    : c.action === "back" ? "Back"
    : c.action === "sleep" ? "Sleep"
    : c.action === "volume" ? (c.dir === "mute" ? "Mute" : `Volume ${c.dir}`)
    : c.action ?? "Command";
  return `${a.device_name} • ${what}${a.status === "failed" ? " (failed)" : ""}`;
}

// ---------- shared pieces ----------

// Charts get their size from layout pixels (clientWidth), which the iPad scaling doesn't change;
// the chart library's own sizing reads screen pixels and would draw too big under the scale.
function Sized({ children }: { children: (w: number, h: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return <div ref={ref} className="absolute inset-0">{size && size.w > 0 && size.h > 0 ? children(size.w, size.h) : null}</div>;
}

const PANEL = "relative bg-[#171310]/80 backdrop-blur-xl border border-white/10 rounded-3xl shadow-2xl panel-in";
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

// ---------- previews of what isn't connected yet ----------
// These draw the finished design with example values, dimmed and disabled, with a small badge in a
// corner, so the screen shows what's coming without passing the examples off as real readings.

type Corner = "tr" | "br" | "bl";
const CORNER: Record<Corner, string> = { tr: "top-2 right-2", br: "bottom-2 right-2", bl: "bottom-2 left-2" };

// The badge anchors to the panel (the nearest positioned box), sitting on its top edge like a tab,
// so it never covers the preview's controls.
function Preview({ children, className = "", label = "NOT CONNECTED" }: { children: ReactNode; className?: string; corner?: Corner; label?: string }) {
  return (
    <div className={`flex flex-col ${className}`}>
      <div aria-hidden="true" className="flex-1 min-h-0 flex flex-col gap-2.5 opacity-55 saturate-50 pointer-events-none select-none">{children}</div>
      <span className="absolute -top-2.5 right-6 z-10 flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[#110e0c] border border-white/15 text-[9px] font-mono tracking-wider text-slate-400">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />{label}
      </span>
    </div>
  );
}

function SampleAcRow({ name, room, set, mode }: { name: string; room: number; set: number; mode: string }) {
  return (
    <div className="bg-black/30 p-2.5 rounded-2xl border border-white/5 flex items-center gap-2.5">
      <span className="flex-1 min-w-0">
        <span className="text-[13px] font-bold text-white flex items-center gap-1 whitespace-nowrap"><Fan className="w-3.5 h-3.5 text-cyan-400 shrink-0 spin-slow" />{name}<ChevronRight className="w-3.5 h-3.5 text-slate-500" /></span>
        <span className="text-[11px] text-slate-400">Room {room}° • <span className="text-cyan-400 font-mono uppercase">{mode}</span></span>
      </span>
      <span className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center font-bold">−</span>
      <span className="w-[60px] text-center text-2xl font-bold font-mono">{set}°</span>
      <span className="w-10 h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center font-bold">+</span>
      <span className="w-10 h-10 rounded-xl border bg-cyan-500/20 text-cyan-300 border-cyan-500/40 flex items-center justify-center"><Power className="w-4 h-4" /></span>
    </div>
  );
}

function CamStandIn({ big }: { big?: boolean }) {
  return (
    <>
      <div className="relative flex-1 min-h-[120px] rounded-2xl overflow-hidden border border-white/10 bg-black">
        <div className="absolute inset-0" style={{ background: "radial-gradient(40% 55% at 22% 62%, rgba(245,158,11,0.55), transparent 70%), radial-gradient(30% 40% at 78% 70%, rgba(99,102,241,0.45), transparent 70%), linear-gradient(180deg, #2b231d 0%, #1a1512 55%, #0f0c0a 100%)" }}>
          <div className="absolute left-[8%] right-[8%] bottom-[14%] h-[22%] rounded-t-[28px] bg-[#3a2e25]/80" />
          <div className="absolute left-[14%] bottom-[30%] w-[16%] h-[14%] rounded-xl bg-[#4a3a2e]/80" />
          <div className="absolute right-[12%] top-[18%] w-[30%] h-[34%] rounded-md bg-black/70 border border-white/10" />
        </div>
        <span className="absolute top-2 left-2 bg-black/80 px-2 py-1 rounded-lg text-[10px] font-mono text-emerald-400 flex items-center gap-1.5 border border-white/10"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />SNAPSHOT • 1 MIN AGO</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className={`flex items-center gap-1.5 px-3 ${big ? "h-12 text-sm" : "h-10 text-[11px]"} rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 font-semibold`}><Video className="w-3.5 h-3.5" /> Live view</span>
        <span className="flex items-center gap-2">
          <span className={`flex items-center gap-1.5 px-3 ${big ? "h-12 text-sm" : "h-10 text-[11px]"} bg-white/5 border border-white/10 rounded-xl text-slate-200`}><RefreshCw className="w-3.5 h-3.5 text-amber-400" /> Snap</span>
          <span className={`flex items-center px-3 ${big ? "h-12" : "h-10"} bg-black/40 rounded-xl border border-white/5 text-amber-400 font-mono font-bold text-[11px]`}>1.0x</span>
        </span>
      </div>
    </>
  );
}

const POWER_SAMPLE = (() => {
  const ac = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.6, 0.9, 1.1, 1.2, 1.1, 0.9, 0.8, 0.9, 1.0, 0.9, 0.8, 0.7, 0.5];
  const water = [0, 0, 0, 0, 0, 0, 0, 0.5, 0.6, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.5, 0.3, 0.2, 0, 0];
  const lights = [0, 0, 0, 0, 0, 0, 0, 0.02, 0.02, 0, 0, 0, 0, 0, 0, 0, 0, 0.03, 0.05, 0.06, 0.06, 0.06, 0.05, 0.03];
  const other = [0.15, 0.15, 0.14, 0.14, 0.14, 0.15, 0.18, 0.3, 0.35, 0.2, 0.18, 0.2, 0.25, 0.22, 0.2, 0.2, 0.22, 0.3, 0.45, 0.5, 0.48, 0.42, 0.35, 0.25];
  return {
    hourly: ac.map((_, h) => ({ time: `${String(h).padStart(2, "0")}:00`, ac: ac[h], water: water[h], lights: lights[h], other: other[h] })),
    sources: [
      { key: "ac", label: "AC", color: "#22d3ee", share: 58 },
      { key: "water", label: "Water", color: "#f59e0b", share: 13 },
      { key: "other", label: "Other", color: "#94a3b8", share: 28 },
      { key: "lights", label: "Lights", color: "#a78bfa", share: 2 },
    ],
  };
})();

function PowerSample({ compact }: { compact?: boolean }) {
  if (compact) {
    // One line legend so the Con Edison numbers fit underneath.
    return (
      <>
        <div className="relative flex-1 min-h-[64px]">
          <div className="absolute inset-0">
            <Sized>{(w, h) => (
              <AreaChart width={w} height={h} data={POWER_SAMPLE.hourly} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                <XAxis dataKey="time" stroke="#64748b" fontSize={9} tickLine={false} interval={5} />
                <YAxis stroke="#64748b" fontSize={9} tickLine={false} />
                {POWER_SAMPLE.sources.map((s) => <Area key={s.key} type="monotone" dataKey={s.key} stackId="1" stroke={s.color} fill={s.color} fillOpacity={0.2} strokeWidth={1.5} isAnimationActive={false} />)}
              </AreaChart>
            )}</Sized>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 text-[10px]">
          {POWER_SAMPLE.sources.map((s) => (
            <span key={s.key} className="flex items-center gap-1 text-slate-400">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} />{s.label}<span className="font-mono text-slate-200 font-bold">{s.share}%</span>
            </span>
          ))}
        </div>
      </>
    );
  }
  return (
    <>
      <div className="relative flex-1 min-h-[90px]">
        <div className="absolute inset-0">
          <Sized>{(w, h) => (
            <AreaChart width={w} height={h} data={POWER_SAMPLE.hourly} margin={{ top: 5, right: 4, left: -26, bottom: 0 }}>
              <XAxis dataKey="time" stroke="#64748b" fontSize={9} tickLine={false} interval={5} />
              <YAxis stroke="#64748b" fontSize={9} tickLine={false} />
              {POWER_SAMPLE.sources.map((s) => <Area key={s.key} type="monotone" dataKey={s.key} stackId="1" stroke={s.color} fill={s.color} fillOpacity={0.2} strokeWidth={1.5} isAnimationActive={false} />)}
            </AreaChart>
          )}</Sized>
        </div>
      </div>
      <div className="flex h-2 rounded-full overflow-hidden bg-white/5">{POWER_SAMPLE.sources.map((s) => <div key={s.key} style={{ width: `${s.share}%`, backgroundColor: s.color }} />)}</div>
      <div className="grid grid-cols-4 gap-1">
        {POWER_SAMPLE.sources.map((s) => (
          <span key={s.key} className="text-[10px] leading-tight">
            <span className="flex items-center gap-1 text-slate-400"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} />{s.label}</span>
            <span className="font-mono text-slate-200 font-bold">{s.share}%</span>
          </span>
        ))}
      </div>
    </>
  );
}

// ---------- Con Edison ----------

const money = (v: number | null | undefined) => (v == null ? "--" : `$${v.toFixed(2)}`);
const kwhText = (v: number | null | undefined) => (v == null ? "--" : `${v < 10 ? v.toFixed(1) : Math.round(v)} kWh`);
// Bill dates are calendar days ("2026-10-19"); read and show them as such, whatever the iPad's zone.
const billDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
const nyToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const nyDayOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));


// Bill math shared by the overview tile, the bill summary and the energy report. Con Edison only prices
// whole bills, so estimates use the last bill's rate per kWh.
function meterMath(meter: Meter) {
  const s = meter.state;
  const b = s?.bill;
  const today = nyToday();
  const daily = (s?.daily ?? []).filter((d) => d.kwh != null);
  const dayMs = 86400_000;
  const span = (a: string, z: string) => Math.round((Date.parse(z) - Date.parse(a)) / dayMs);
  const last = s?.last_bill;
  const rate = last?.cost && last.kwh ? last.cost / last.kwh : null;
  const est = (kwh: number | null | undefined) => (kwh != null && rate ? kwh * rate : null);
  const kwhBetween = (a: string, z: string) => daily.filter((d) => d.d >= a && d.d < z).reduce((t, d) => t + (d.kwh ?? 0), 0);
  const recent = daily.slice(-14);
  const avgDay = recent.length ? recent.reduce((t, d) => t + (d.kwh ?? 0), 0) / recent.length : null;

  const days = b ? span(b.start, b.end) : null;
  const dayOf = b ? Math.max(1, span(b.start, today) + 1) : null;
  const soFarKwh = b ? (b.kwh_so_far || kwhBetween(b.start, today)) : null;
  const soFar = b?.cost_so_far ?? est(soFarKwh);
  const soFarIsEst = b?.cost_so_far == null && soFar != null;
  const projected = b?.cost_forecast ?? (b && avgDay != null && days ? est(Math.max(soFarKwh ?? 0, 0) + avgDay * Math.max(days - (dayOf ?? 1) + 1, 0)) : null);
  const projIsEst = b?.cost_forecast == null && projected != null;
  // Same cycle last year, for comparison.
  const lastYear = b ? (s?.bills ?? []).find((x) => Math.abs(span(x.start, b.start) - 365) <= 12) : undefined;
  const vsLastYear = projected != null && lastYear?.cost ? Math.round(((projected - lastYear.cost) / lastYear.cost) * 100) : null;
  // A finished cycle whose bill hasn't posted yet (between the last bill and the current cycle).
  const pending = b && last && last.end < b.start && span(last.end, b.start) >= 20 ? { start: last.end, end: b.start, kwh: kwhBetween(last.end, b.start) } : null;
  const pendingCost = pending ? est(pending.kwh) : null;

  const lastDay = [...daily].reverse().find((d) => d.d < today);
  const todayKwh = s?.live?.today_kwh ?? daily.find((d) => d.d === today)?.kwh ?? null;
  const stale = meter.recorded_at ? Date.now() - Date.parse(meter.recorded_at) > 6 * 3600_000 : false;

  return { s, b, today, daily, dayMs, span, last, rate, est, kwhBetween, avgDay, days, dayOf, soFarKwh, soFar, soFarIsEst, projected, projIsEst, lastYear, vsLastYear, pending, pendingCost, lastDay, todayKwh, stale };
}

// ---------- History ----------

const ROOM_COLOR: Record<string, string> = { Kitchen: "#f59e0b", "Living room": "#a78bfa", Bedroom: "#22d3ee", Other: "#94a3b8" };
const atNoon = (d: string) => new Date(`${d}T12:00:00Z`);
const weekday = (d: string) => atNoon(d).toLocaleDateString([], { weekday: "short", timeZone: "UTC" });
const isWeekend = (d: string) => [0, 6].includes(atNoon(d).getUTCDay());
const shiftDay = (d: string, n: number) => new Date(atNoon(d).getTime() + n * 86400_000).toISOString().slice(0, 10);
const hoursText = (h: number | null | undefined) => (h == null ? "--" : h >= 10 ? `${Math.round(h)} h` : `${h.toFixed(1)} h`);
const sum = (xs: (number | null | undefined)[]) => xs.reduce<number>((t, x) => t + (x ?? 0), 0);

const TIP = { contentStyle: { background: "#1c1613", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 12, fontSize: 11 }, labelStyle: { color: "#e2e8f0" }, cursor: { fill: "rgba(255,255,255,0.04)" } };

// Commands as people think of them: four kitchen bulbs switched off together is one entry, and a run of
// volume taps on the TV is one entry with a count.
type ActGroup = { item: Analytics["activity"][number]; count: number; names: string[]; t: string };
function groupActivity(list: Analytics["activity"]): ActGroup[] {
  const out: ActGroup[] = [];
  for (const a of list) {
    const last = out[out.length - 1];
    const same = last && last.item.command?.action === a.command?.action && last.item.command?.on === a.command?.on
      && last.item.command?.dir === a.command?.dir && last.item.source === a.source && last.item.kind === a.kind;
    const gap = last ? Math.abs(Date.parse(last.t) - Date.parse(a.t)) : Infinity;
    if (same && ((a.kind === "light" && gap < 8000) || (last.item.device_id === a.device_id && gap < 90_000))) {
      last.t = a.t;
      if (!last.names.includes(a.device_name)) last.names.push(a.device_name);
      last.count++;
      continue;
    }
    out.push({ item: a, count: 1, names: [a.device_name], t: a.t });
  }
  return out;
}

function groupText(g: ActGroup) {
  const what = describe(g.item).split(" • ").slice(1).join(" • ");
  if (g.names.length > 1) return `${g.names.length} lights • ${what}`;
  const name = g.item.kind === "water_heater" ? "Water heater" : g.item.device_name;
  return `${name} • ${what}${g.count > 1 ? ` ×${g.count}` : ""}`;
}

function MiniStat({ label, value, sub, tone = "text-slate-100" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-black/30 border border-white/5 px-3 py-2">
      <div className="text-[9px] font-mono tracking-widest text-slate-500 truncate">{label}</div>
      <div className={`text-[18px] leading-tight font-bold font-mono tabular-nums truncate ${tone}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500 truncate">{sub}</div>}
    </div>
  );
}

/** The History tab: electricity by day or by bill, lights, hot water, and what happened this week. */
function HistoryView({ meter, onConnectConed }: { meter?: Meter; onConnectConed: () => void }) {
  const [a, setA] = useState<Analytics | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"daily" | "bills">("daily");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/history?days=7", { cache: "no-store" });
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        if (alive) { setA(body); setErr(null); }
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    };
    load();
    const t = setInterval(() => document.visibilityState === "visible" && load(), 5 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!a) {
    return (
      <main className={`flex-1 ${PANEL} z-10 flex items-center justify-center text-[13px] ${err ? "text-rose-300" : "text-slate-500"}`}>
        {err ? `Couldn't load history: ${err}` : "Loading history"}
      </main>
    );
  }

  // Electricity, last 30 days with data (Con Edison runs about a day behind).
  const energy = a.energy.filter((e) => e.kwh != null);
  const last30 = energy.slice(-30);
  const total30 = sum(last30.map((e) => e.kwh));
  const avg30 = last30.length ? total30 / last30.length : null;
  const top = last30.reduce<typeof last30[number] | null>((m, e) => (!m || (e.kwh ?? 0) > (m.kwh ?? 0) ? e : m), null);
  const byDay = new Map(energy.map((e) => [e.d, e.kwh ?? 0]));
  const lastYear = last30.length ? last30.map((e) => byDay.get(shiftDay(e.d, -364))).filter((x): x is number => x != null) : [];
  const vsYear = lastYear.length >= last30.length * 0.8 && sum(lastYear) > 0 ? Math.round(((total30 - sum(lastYear) * (last30.length / lastYear.length)) / (sum(lastYear) * (last30.length / lastYear.length))) * 100) : null;
  const dailyData = last30.map((e) => ({ d: e.d, label: billDay(e.d), kwh: e.kwh, weekend: isWeekend(e.d) }));

  const bills = [...(meter?.state?.bills ?? [])].reverse().slice(-12);
  const billData = bills.map((b) => ({ label: atNoon(b.start).toLocaleDateString([], { month: "short", timeZone: "UTC" }), cost: b.cost, kwh: b.kwh, range: `${billDay(b.start)} to ${billDay(b.end)}` }));
  const billTotal = sum(bills.map((b) => b.cost));
  const topBill = bills.reduce<typeof bills[number] | null>((m, b) => (!m || (b.cost ?? 0) > (m.cost ?? 0) ? b : m), null);

  // The last 7 days for everything else.
  const week = Array.from({ length: 7 }, (_, i) => shiftDay(nyToday(), i - 6));
  const rooms = [...new Set(a.lights.map((l) => l.room))].sort((x, y) => Object.keys(ROOM_COLOR).indexOf(x) - Object.keys(ROOM_COLOR).indexOf(y));
  const lightData = week.map((d) => ({ d, label: weekday(d), ...Object.fromEntries(rooms.map((r) => [r, a.lights.find((l) => l.d === d && l.room === r)?.hours ?? 0])) }));
  const roomAvg = (r: string) => sum(a.lights.filter((l) => l.room === r && week.includes(l.d)).map((l) => l.hours)) / 7;
  const heatData = week.map((d) => {
    const h = a.heater.find((x) => x.d === d);
    return { d, label: weekday(d), pump: Math.max(0, (h?.heating ?? 0) - (h?.element ?? 0)), element: h?.element ?? 0 };
  });
  const heatDays = a.heater.filter((h) => week.includes(h.d));
  const heatAvg = heatDays.length ? sum(heatDays.map((h) => h.heating)) / heatDays.length : null;
  const offAvg = heatDays.length ? sum(heatDays.map((h) => h.off)) / heatDays.length : null;
  const tankLow = heatDays.reduce<number | null>((m, h) => (h.tank_min == null ? m : m == null ? h.tank_min : Math.min(m, h.tank_min)), null);

  const tvToday = a.tv.find((t) => t.d === nyToday())?.hours ?? 0;
  const tvDays = a.tv.filter((t) => week.includes(t.d));
  const tvAvg = tvDays.length ? sum(tvDays.map((t) => t.hours)) / tvDays.length : null;
  const people = a.camera.filter((c) => c.person).length;
  const groups = groupActivity(a.activity);
  const bySchedule = a.activity.filter((x) => x.source === "schedule").length;
  const brightest = rooms.length ? rooms.reduce((m, r) => (roomAvg(r) > roomAvg(m) ? r : m)) : null;

  const toggle = (
    <div className="flex items-center bg-black/60 p-1 rounded-xl border border-white/10">
      {([["daily", "30 days"], ["bills", "Bills"]] as const).map(([id, label]) => (
        <button key={id} onClick={() => setMode(id)} aria-pressed={mode === id}
          className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all ${mode === id ? "bg-emerald-500 text-slate-950" : "text-slate-400"}`}>{label}</button>
      ))}
    </div>
  );

  return (
    <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0 z-10">
      <div className="lg:col-span-8 flex flex-col gap-3 min-h-0">
        <div className={`flex-1 min-h-[280px] ${PANEL} p-4 flex flex-col gap-3`}>
          <PanelHead icon={Zap} tone={GREEN} title="Electricity" sub={mode === "daily" ? "Whole home, Con Edison smart meter" : "Con Edison bills, last 12"} right={toggle} />
          {!energy.length && !bills.length ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
              <p className="text-[12px] text-slate-400">Connect Con Edison to see your usage and bills here.</p>
              <button onClick={onConnectConed} className="px-4 h-10 rounded-xl text-[12px] font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">Connect Con Edison</button>
            </div>
          ) : mode === "daily" ? (
            <>
              <div className="grid grid-cols-4 gap-2">
                <MiniStat label="LAST 30 DAYS" value={kwhText(total30)} sub={last30.length ? `${billDay(last30[0].d)} to ${billDay(last30[last30.length - 1].d)}` : undefined} tone="text-emerald-300" />
                <MiniStat label="AVERAGE A DAY" value={kwhText(avg30)} sub="Weekends in lighter green" />
                <MiniStat label="VS LAST YEAR" value={vsYear == null ? "--" : `${vsYear > 0 ? "+" : ""}${vsYear}%`} sub="Same 30 days" tone={vsYear == null ? "text-slate-100" : vsYear > 0 ? "text-amber-300" : "text-emerald-300"} />
                <MiniStat label="HIGHEST DAY" value={kwhText(top?.kwh)} sub={top ? `${weekday(top.d)} ${billDay(top.d)}` : undefined} />
              </div>
              <div className="relative flex-1 min-h-[120px]">
                <Sized>{(w, h) => (
                  <BarChart width={w} height={h} data={dailyData} margin={{ top: 6, right: 4, left: -18, bottom: 0 }}>
                    <XAxis dataKey="label" stroke="#64748b" fontSize={10} tickLine={false} interval={4} />
                    <YAxis stroke="#64748b" fontSize={10} tickLine={false} />
                    <Tooltip {...TIP} formatter={(v) => [`${Number(v).toFixed(1)} kWh`, "Used"]} />
                    {avg30 != null && <ReferenceLine y={avg30} stroke="#94a3b8" strokeDasharray="4 4" strokeOpacity={0.6} />}
                    <Bar dataKey="kwh" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                      {dailyData.map((x) => <Cell key={x.d} fill={x.weekend ? "#6ee7b7" : "#10b981"} fillOpacity={x.weekend ? 0.55 : 0.85} />)}
                    </Bar>
                  </BarChart>
                )}</Sized>
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-2">
                <MiniStat label="LAST BILL" value={money(bills[bills.length - 1]?.cost)} sub={bills.length ? kwhText(bills[bills.length - 1].kwh) : undefined} tone="text-emerald-300" />
                <MiniStat label="AVERAGE BILL" value={money(bills.length ? billTotal / bills.length : null)} sub={`Over ${bills.length} bills`} />
                <MiniStat label="HIGHEST" value={money(topBill?.cost)} sub={topBill ? `${billDay(topBill.start)} to ${billDay(topBill.end)}` : undefined} tone="text-amber-300" />
                <MiniStat label={`${bills.length} BILLS TOTAL`} value={`$${Math.round(billTotal).toLocaleString()}`} sub={`${Math.round(sum(bills.map((b) => b.kwh))).toLocaleString()} kWh`} />
              </div>
              <div className="relative flex-1 min-h-[120px]">
                <Sized>{(w, h) => (
                  <BarChart width={w} height={h} data={billData} margin={{ top: 6, right: 4, left: -12, bottom: 0 }}>
                    <XAxis dataKey="label" stroke="#64748b" fontSize={10} tickLine={false} />
                    <YAxis stroke="#64748b" fontSize={10} tickLine={false} tickFormatter={(v) => `$${v}`} />
                    <Tooltip {...TIP} formatter={(v, _n, p) => [`$${Number(v).toFixed(2)} • ${(p.payload as { kwh: number }).kwh} kWh`, (p.payload as { range: string }).range]} />
                    <Bar dataKey="cost" fill="#10b981" fillOpacity={0.85} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                )}</Sized>
              </div>
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 shrink-0 h-[248px]">
          <div className={`${PANEL} p-4 flex flex-col gap-2 min-h-0`}>
            <PanelHead icon={Lightbulb} tone={AMBER} title="Lights" sub="Hours each room was lit, last 7 days" />
            <div className="relative flex-1 min-h-0">
              <Sized>{(w, h) => (
                <BarChart width={w} height={h} data={lightData} margin={{ top: 6, right: 4, left: -24, bottom: 0 }}>
                  <XAxis dataKey="label" stroke="#64748b" fontSize={10} tickLine={false} />
                  <YAxis stroke="#64748b" fontSize={10} tickLine={false} allowDecimals={false} />
                  <Tooltip {...TIP} formatter={(v, n) => [hoursText(Number(v)), String(n)]} />
                  {rooms.map((r, i) => <Bar key={r} dataKey={r} stackId="rooms" fill={ROOM_COLOR[r] ?? ROOM_COLOR.Other} fillOpacity={0.8} radius={i === rooms.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive={false} />)}
                </BarChart>
              )}</Sized>
            </div>
            <div className="flex items-center justify-between gap-2 text-[10px]">
              {rooms.map((r) => (
                <span key={r} className="flex items-center gap-1 text-slate-400"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: ROOM_COLOR[r] ?? ROOM_COLOR.Other }} />{r}<span className="font-mono text-slate-200 font-bold">{hoursText(roomAvg(r))}</span></span>
              ))}
            </div>
          </div>
          <div className={`${PANEL} p-4 flex flex-col gap-2 min-h-0`}>
            <PanelHead icon={Flame} tone={AMBER} title="Hot Water" sub="Hours heating a day, last 7 days" />
            <div className="relative flex-1 min-h-0">
              <Sized>{(w, h) => (
                <BarChart width={w} height={h} data={heatData} margin={{ top: 6, right: 4, left: -24, bottom: 0 }}>
                  <XAxis dataKey="label" stroke="#64748b" fontSize={10} tickLine={false} />
                  <YAxis stroke="#64748b" fontSize={10} tickLine={false} allowDecimals={false} />
                  <Tooltip {...TIP} formatter={(v, n) => [hoursText(Number(v)), n === "pump" ? "Heat pump" : "Electric element"]} />
                  <Bar dataKey="pump" stackId="h" fill="#f59e0b" fillOpacity={0.8} isAnimationActive={false} />
                  <Bar dataKey="element" stackId="h" fill="#f43f5e" fillOpacity={0.8} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              )}</Sized>
            </div>
            <div className="flex items-center justify-between gap-2 text-[10px] text-slate-400">
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" />Heat pump<span className="w-2 h-2 rounded-full bg-rose-500 ml-2" />Element</span>
              <span>Avg <span className="font-mono text-slate-200 font-bold">{hoursText(heatAvg)}</span> • off <span className="font-mono text-slate-200 font-bold">{hoursText(offAvg)}</span>{tankLow != null && <> • low <span className="font-mono text-slate-200 font-bold">{tankLow}%</span></>}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="lg:col-span-4 flex flex-col gap-3 min-h-0">
        <div className="grid grid-cols-2 gap-2 shrink-0">
          <MiniStat label="TV TODAY" value={hoursText(tvToday)} sub={tvAvg != null ? `Avg ${hoursText(tvAvg)} a day` : "Collecting"} tone="text-cyan-300" />
          <MiniStat label="CAMERA EVENTS" value={String(a.camera.length)} sub={`${people} with a person • 7 days`} tone="text-amber-300" />
          <MiniStat label="MOST LIT ROOM" value={brightest ?? "--"} sub={brightest ? `${hoursText(roomAvg(brightest))} a day` : undefined} />
          <MiniStat label="COMMANDS" value={String(a.activity.length >= 200 ? "200+" : a.activity.length)} sub={`${bySchedule} by schedule • 7 days`} />
        </div>
        <div className={`flex-1 min-h-[200px] ${PANEL} p-4 flex flex-col gap-2`}>
          <PanelHead icon={ListChecks} tone={CYAN} title="Activity" sub="Dashboard and schedules, last 7 days" />
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-none space-y-1.5">
            {groups.slice(0, 60).map((g) => (
              <div key={g.item.id} className="flex items-center gap-2.5 bg-black/30 px-2.5 py-2 rounded-xl border border-white/5">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${g.item.source === "schedule" ? "bg-cyan-400" : "bg-amber-400"}`} />
                <span className="flex-1 min-w-0 text-[12px] text-slate-200 truncate">{groupText(g)}</span>
                <span className="text-[10px] font-mono text-slate-500 shrink-0">{atNoon(nyDayOf(g.item.t)).toLocaleDateString([], { weekday: "short", timeZone: "UTC" })} {clockTime(g.item.t)}</span>
              </div>
            ))}
            {!groups.length && <p className="text-[12px] text-slate-500 px-1">Nothing this week.</p>}
          </div>
          <div className="pt-1 flex items-center gap-3 text-[10px] text-slate-500">
            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" />Dashboard</span>
            <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />Schedule</span>
          </div>
        </div>
      </div>
    </main>
  );
}

// ---------- Power & Energy: overview tile and full report ----------

/** The small overview tile: the three numbers that matter, tap for the full report. */
function EnergyTile({ meter, onOpen, onConnect }: { meter: Meter | undefined; onOpen: () => void; onConnect: () => void }) {
  if (!meter) {
    return (
      <div className={`${PANEL} p-3 flex items-center gap-3 shrink-0`}>
        <div className={`p-2 rounded-xl border shrink-0 ${GREEN}`}><Zap className="w-4 h-4" /></div>
        <div className="flex-1 min-w-0"><h2 className="text-[13px] font-bold text-white">Power & Energy</h2><p className="text-[11px] text-slate-400 truncate">Connect Con Edison for your bill and usage</p></div>
        <button onClick={onConnect} className="px-3 h-9 rounded-xl text-[11px] font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 active:scale-95 shrink-0">Connect</button>
      </div>
    );
  }
  const m = meterMath(meter);
  const yesterday = m.todayKwh ?? m.lastDay?.kwh ?? null;
  return (
    <button onClick={onOpen} aria-label="Open Power & Energy details" className={`${PANEL} p-3 flex flex-col gap-2 shrink-0 text-left active:scale-[0.99] transition-transform`}>
      <div className="flex items-center gap-2.5 w-full">
        <div className={`p-2 rounded-xl border shrink-0 ${GREEN} glow-ring`}><Zap className="w-4 h-4" /></div>
        <div className="flex-1 min-w-0"><h2 className="text-[13px] font-bold text-white">Power & Energy</h2><p className="text-[11px] text-slate-400 truncate">Con Edison • tap for the full report</p></div>
        <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
      </div>
      <span aria-hidden="true" className="block w-full h-px rounded-full bg-emerald-500/15 overflow-hidden"><span className="block h-full w-full energy-flow" /></span>
      <div className="grid grid-cols-3 gap-2 w-full">
        {[
          [m.soFarIsEst ? "SO FAR (EST.)" : "BILL SO FAR", money(m.soFar), "text-emerald-300"],
          [m.projIsEst ? "EST. TOTAL" : "PROJECTED", money(m.projected), "text-slate-100"],
          [m.todayKwh != null ? "TODAY" : "YESTERDAY", kwhText(yesterday), "text-slate-100"],
        ].map(([label, value, tone]) => (
          <span key={label} className="min-w-0 rounded-lg bg-black/30 border border-white/5 px-2 py-1.5">
            <span className="block text-[8px] font-mono tracking-widest text-slate-500 truncate">{label}</span>
            <span className={`block text-[14px] font-bold font-mono tabular-nums ${tone}`}>{value}</span>
          </span>
        ))}
      </div>
    </button>
  );
}

const hourLabel = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", timeZone: "America/New_York" });
const monthLabel = (ym: string) => atNoon(`${ym}-15`).toLocaleDateString([], { month: "short", timeZone: "UTC" });
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The full Power & Energy report, opened from the overview tile. */
function EnergyDetail({ meter, onClose, onDisconnect }: { meter: Meter; onClose: () => void; onDisconnect: () => void }) {
  const [energy, setEnergy] = useState<Analytics["energy"] | null>(null);
  useEffect(() => {
    fetch("/api/history?days=7", { cache: "no-store" }).then((r) => r.json()).then((j) => setEnergy(Array.isArray(j.energy) ? j.energy : [])).catch(() => setEnergy([]));
  }, []);
  const m = meterMath(meter);
  const s = m.s;
  const daily = (energy && energy.length ? energy : s?.daily ?? []).filter((e) => e.kwh != null) as { d: string; kwh: number }[];

  // Cycle progress.
  const pct = m.days && m.dayOf ? Math.min(100, (Math.min(m.dayOf, m.days) / m.days) * 100) : 0;
  const perDay = m.avgDay != null ? m.est(m.avgDay) : null;

  // Last 12 months by calendar month (the current month so far is marked).
  const byMonth = new Map<string, number>();
  for (const e of daily) byMonth.set(e.d.slice(0, 7), (byMonth.get(e.d.slice(0, 7)) ?? 0) + e.kwh);
  const months = [...byMonth.keys()].sort().slice(-12);
  const thisMonth = m.today.slice(0, 7);
  const topMonth = months.filter((k) => k !== thisMonth).reduce<string | null>((t, k) => (!t || (byMonth.get(k) ?? 0) > (byMonth.get(t) ?? 0) ? k : t), null);
  const monthData = months.map((k) => ({ k, label: monthLabel(k), kwh: Math.round(byMonth.get(k) ?? 0), partial: k === thisMonth, top: k === topMonth }));

  // Day of week, last 12 weeks.
  const recent = daily.slice(-84);
  const dow = DOW.map((name, i) => {
    const xs = recent.filter((e) => atNoon(e.d).getUTCDay() === i).map((e) => e.kwh);
    return { name, kwh: xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : 0, weekend: i === 0 || i === 6 };
  });
  const wkAvg = (we: boolean) => { const xs = dow.filter((d) => d.weekend === we && d.kwh); return xs.length ? xs.reduce((t, d) => t + d.kwh, 0) / xs.length : null; };
  const weekendVs = wkAvg(true) && wkAvg(false) ? Math.round(((wkAvg(true)! - wkAvg(false)!) / wkAvg(false)!) * 100) : null;

  // Hour by hour for the latest full day, and the always on (standby) load.
  const hourly = (s?.hourly ?? []).filter((h) => h.kwh != null) as { t: string; kwh: number }[];
  const lastFullDay = hourly.length ? nyDayOf(hourly[hourly.length - 1].t) : null;
  const dayHours = hourly.filter((h) => nyDayOf(h.t) === lastFullDay);
  const hourData = dayHours.map((h) => ({ t: h.t, label: hourLabel(h.t), kwh: h.kwh }));
  const peak = dayHours.reduce<{ t: string; kwh: number } | null>((p, h) => (!p || h.kwh > p.kwh ? h : p), null);
  const sorted = hourly.map((h) => h.kwh).sort((x, y) => x - y);
  const base = sorted.length >= 12 ? sorted[Math.floor(sorted.length * 0.1)] : null; // kWh in an hour = average kW
  const baseMonthCost = base != null ? m.est(base * 24 * 30) : null;

  // Last 30 days against the same days a year earlier.
  const last30 = daily.slice(-30);
  const map = new Map(daily.map((e) => [e.d, e.kwh]));
  const prior = last30.map((e) => map.get(shiftDay(e.d, -364))).filter((x): x is number => x != null);
  const t30 = last30.reduce((t, e) => t + e.kwh, 0);
  const vs30 = prior.length >= 24 ? Math.round(((t30 - prior.reduce((t, x) => t + x, 0) * (last30.length / prior.length)) / (prior.reduce((t, x) => t + x, 0) * (last30.length / prior.length))) * 100) : null;

  const bills = [...(s?.bills ?? [])].reverse().slice(-12);
  const billData = bills.map((b) => ({ label: monthLabel(b.start.slice(0, 7)), cost: b.cost, kwh: b.kwh, range: `${billDay(b.start)} to ${billDay(b.end)}` }));
  const rates = bills.filter((b) => b.cost && b.kwh).map((b) => b.cost! / b.kwh!);

  type Insight = { icon: LucideIcon; tone: string; text: ReactNode };
  const insights: Insight[] = [];
  if (vs30 != null) insights.push({ icon: Activity, tone: vs30 > 0 ? "text-amber-300" : "text-emerald-300", text: <>Last 30 days used <b>{Math.abs(vs30)}% {vs30 > 0 ? "more" : "less"}</b> than the same days last year.</> });
  if (base != null) insights.push({ icon: Plug, tone: "text-cyan-300", text: <>Always on load is about <b>{Math.round(base * 1000)} W</b>{baseMonthCost != null ? <>, roughly <b>{money(baseMonthCost)}</b> a month</> : null}. Fridge, router and standby devices.</> });
  if (m.vsLastYear != null) insights.push({ icon: Zap, tone: m.vsLastYear > 0 ? "text-amber-300" : "text-emerald-300", text: <>{m.projIsEst ? "The estimate for this bill is" : "This bill is"} tracking <b>{Math.abs(m.vsLastYear)}% {m.vsLastYear > 0 ? "above" : "below"}</b> the same cycle last year ({money(m.lastYear?.cost)}).</> });
  if (weekendVs != null && Math.abs(weekendVs) >= 5) insights.push({ icon: CalendarIcon, tone: "text-slate-300", text: <>Weekends use <b>{Math.abs(weekendVs)}% {weekendVs > 0 ? "more" : "less"}</b> than weekdays.</> });
  if (peak) insights.push({ icon: Sun, tone: "text-slate-300", text: <>Busiest hour on {weekday(lastFullDay!)} was <b>{hourLabel(peak.t)}</b> ({peak.kwh.toFixed(2)} kWh).</> });
  if (topMonth) insights.push({ icon: Flame, tone: "text-amber-300", text: <>Highest month was <b>{monthLabel(topMonth)}</b> with {Math.round(byMonth.get(topMonth)!)} kWh, {m.avgDay ? `about ${Math.round((byMonth.get(topMonth)! / 30) / m.avgDay * 10) / 10}x` : ""} your current daily pace.</> });

  const tile = "min-w-0 rounded-xl bg-black/30 border border-white/5 px-3 py-2";
  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-md p-4 flex" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex-1 min-h-0 bg-[#171310] border border-white/15 rounded-3xl shadow-2xl p-4 flex flex-col gap-3 overflow-hidden">
        <div className="flex items-center justify-between gap-3 pb-2.5 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className={`p-2 rounded-xl border ${GREEN}`}><Zap className="w-4 h-4" /></div>
            <div><h2 className="text-[15px] font-bold text-white">Power & Energy</h2><p className="text-[11px] text-slate-400">Con Edison • updated {meter.recorded_at ? `${ago(meter.recorded_at)} ago` : "soon"} • usage runs about a day behind</p></div>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-10 h-10 flex items-center justify-center rounded-xl bg-white/5 border border-white/10 text-slate-400"><X className="w-4 h-4" /></button>
        </div>

        <div className="grid grid-cols-12 gap-3 shrink-0">
          <div className="col-span-8 flex flex-col gap-2.5">
            <div className="grid grid-cols-4 gap-2 shrink-0">
              <div className={tile}><div className="text-[9px] font-mono tracking-widest text-slate-500">{m.soFarIsEst ? "SO FAR (EST.)" : "BILL SO FAR"}</div><div className="text-[20px] font-bold font-mono text-emerald-300">{money(m.soFar)}</div><div className="text-[10px] text-slate-500">{m.dayOf && m.days ? `Day ${Math.min(m.dayOf, m.days)} of ${m.days}` : ""}</div></div>
              <div className={tile}><div className="text-[9px] font-mono tracking-widest text-slate-500">{m.projIsEst ? "EST. TOTAL" : "PROJECTED"}</div><div className="text-[20px] font-bold font-mono">{money(m.projected)}</div><div className="text-[10px] text-slate-500">{m.lastYear?.cost ? `Last year ${money(m.lastYear.cost)}` : ""}</div></div>
              <div className={tile}><div className="text-[9px] font-mono tracking-widest text-slate-500">{m.pending ? "NEXT BILL (EST.)" : "LAST BILL"}</div><div className="text-[20px] font-bold font-mono">{m.pending ? `≈${money(m.pendingCost)}` : money(m.last?.cost)}</div><div className="text-[10px] text-slate-500 truncate">{m.pending ? `${billDay(m.pending.start)} to ${billDay(m.pending.end)}, not posted` : m.last ? `${billDay(m.last.start)} to ${billDay(m.last.end)}` : ""}</div></div>
              <div className={tile}><div className="text-[9px] font-mono tracking-widest text-slate-500">RATE</div><div className="text-[20px] font-bold font-mono">{m.rate ? `$${m.rate.toFixed(3)}` : "--"}</div><div className="text-[10px] text-slate-500">per kWh, all in{rates.length > 1 ? ` • ${Math.round(((rates[rates.length - 1] - rates[0]) / rates[0]) * 100)}% in a year` : ""}</div></div>
            </div>
            {m.b && (
              <div className={`${tile} flex-1 flex flex-col justify-center gap-2`}>
                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-mono tracking-widest text-slate-500 shrink-0">BILL CYCLE</span>
                  <div className="flex-1 h-2 rounded-full bg-white/10 overflow-hidden"><div className="h-full rounded-full bg-emerald-400" style={{ width: `${pct}%` }} /></div>
                  <span className="text-[11px] text-slate-300 shrink-0">{billDay(m.b.start)} to {billDay(m.b.end)}</span>
                </div>
                <div className="flex items-center justify-between gap-3 text-[11px] text-slate-400">
                  <span>Used <b className="font-mono text-slate-200">{kwhText(m.soFarKwh)}</b> so far</span>
                  <span>Pace <b className="font-mono text-slate-200">{kwhText(m.avgDay)}</b> a day{perDay != null ? <> ≈ <b className="font-mono text-slate-200">{money(perDay)}</b></> : null}</span>
                  {m.lastYear && <span>Same cycle last year <b className="font-mono text-slate-200">{kwhText(m.lastYear.kwh)}</b></span>}
                </div>
              </div>
            )}
          </div>
          <div className={`col-span-4 row-span-2 ${tile} !py-2.5 flex flex-col gap-1.5`}>
            <div className="text-[10px] font-mono tracking-widest text-slate-500">INSIGHTS</div>
            {insights.slice(0, 4).map((i, n) => (
              <div key={n} className="flex items-start gap-2 text-[11.5px] leading-snug text-slate-300"><i.icon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${i.tone}`} /><span>{i.text}</span></div>
            ))}
            {!insights.length && <p className="text-[11px] text-slate-500">Insights appear as more data comes in.</p>}
          </div>
        </div>

        <div className="grid grid-cols-12 gap-3 flex-1 min-h-0">
          <div className={`col-span-8 ${tile} !p-3 flex flex-col gap-1 min-h-0`}>
            <div className="flex items-center justify-between text-[10px] font-mono tracking-widest text-slate-500"><span>LAST 12 MONTHS • kWh</span><span>{insights[5] ? "" : ""}{topMonth ? `PEAK ${monthLabel(topMonth).toUpperCase()}` : ""}</span></div>
            <div className="relative flex-1 min-h-[100px]">
              {energy === null ? <span className="absolute inset-0 flex items-center justify-center text-[12px] text-slate-500">Loading</span> : (
                <Sized>{(w, h) => (
                  <BarChart width={w} height={h} data={monthData} margin={{ top: 6, right: 4, left: -14, bottom: 0 }}>
                    <XAxis dataKey="label" stroke="#64748b" fontSize={10} tickLine={false} />
                    <YAxis stroke="#64748b" fontSize={10} tickLine={false} />
                    <Tooltip {...TIP} formatter={(v, _n, p) => [`${v} kWh${(p.payload as { partial: boolean }).partial ? " so far" : ""}`, "Used"]} />
                    <Bar dataKey="kwh" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                      {monthData.map((x) => <Cell key={x.k} fill={x.top ? "#f59e0b" : "#10b981"} fillOpacity={x.partial ? 0.35 : 0.85} />)}
                    </Bar>
                  </BarChart>
                )}</Sized>
              )}
            </div>
          </div>
          <div className={`col-span-4 ${tile} !p-3 flex flex-col gap-1 min-h-0 relative`}>
            <div className="text-[10px] font-mono tracking-widest text-slate-500">BY APPLIANCE • TODAY</div>
            <div className="relative flex-1 min-h-0 flex flex-col">
              <Preview className="flex-1 min-h-0 overflow-hidden" label="NOT CONNECTED"><PowerSample compact /></Preview>
            </div>
            <p className="text-[10px] text-slate-500">Fills in once the AC bridges and smart plugs are connected.</p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 shrink-0 h-[170px]">
          <div className={`${tile} !p-3 flex flex-col gap-1 min-h-0`}>
            <div className="flex justify-between text-[10px] font-mono tracking-widest text-slate-500"><span>BY HOUR • {lastFullDay ? weekday(lastFullDay).toUpperCase() : ""}</span><span>{dayHours.length ? kwhText(dayHours.reduce((t, h) => t + h.kwh, 0)) : ""}</span></div>
            <div className="relative flex-1 min-h-0">
              {hourData.length ? (
                <Sized>{(w, h) => (
                  <AreaChart width={w} height={h} data={hourData} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                    <XAxis dataKey="label" stroke="#64748b" fontSize={9} tickLine={false} interval={5} />
                    <YAxis stroke="#64748b" fontSize={9} tickLine={false} />
                    <Tooltip {...TIP} formatter={(v) => [`${Number(v).toFixed(2)} kWh`, "Used"]} />
                    {base != null && <ReferenceLine y={base} stroke="#22d3ee" strokeDasharray="3 3" strokeOpacity={0.7} />}
                    <Area type="monotone" dataKey="kwh" stroke="#10b981" fill="#10b981" fillOpacity={0.2} strokeWidth={2} isAnimationActive={false} />
                  </AreaChart>
                )}</Sized>
              ) : <span className="absolute inset-0 flex items-center justify-center text-[11px] text-slate-500">No hourly data yet</span>}
            </div>
            <p className="text-[10px] text-slate-500">Dashed line: always on load</p>
          </div>
          <div className={`${tile} !p-3 flex flex-col gap-1 min-h-0`}>
            <div className="flex justify-between text-[10px] font-mono tracking-widest text-slate-500"><span>BY DAY OF WEEK • 12 WEEKS</span><span>AVG kWh</span></div>
            <div className="relative flex-1 min-h-0">
              <Sized>{(w, h) => (
                <BarChart width={w} height={h} data={dow} margin={{ top: 4, right: 4, left: -26, bottom: 0 }}>
                  <XAxis dataKey="name" stroke="#64748b" fontSize={9} tickLine={false} />
                  <YAxis stroke="#64748b" fontSize={9} tickLine={false} />
                  <Tooltip {...TIP} formatter={(v) => [`${Number(v).toFixed(1)} kWh`, "Average"]} />
                  <Bar dataKey="kwh" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                    {dow.map((x) => <Cell key={x.name} fill={x.weekend ? "#6ee7b7" : "#10b981"} fillOpacity={x.weekend ? 0.55 : 0.85} />)}
                  </Bar>
                </BarChart>
              )}</Sized>
            </div>
            <p className="text-[10px] text-slate-500">{weekendVs != null ? `Weekends ${weekendVs > 0 ? "+" : ""}${weekendVs}% vs weekdays` : "Weekends in lighter green"}</p>
          </div>
          <div className={`${tile} !p-3 flex flex-col gap-1 min-h-0`}>
            <div className="flex justify-between text-[10px] font-mono tracking-widest text-slate-500"><span>BILLS • {bills.length}</span><span>{bills.length ? `AVG ${money(bills.reduce((t, b) => t + (b.cost ?? 0), 0) / bills.length)}` : ""}</span></div>
            <div className="relative flex-1 min-h-0">
              <Sized>{(w, h) => (
                <BarChart width={w} height={h} data={billData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <XAxis dataKey="label" stroke="#64748b" fontSize={9} tickLine={false} interval={1} />
                  <YAxis stroke="#64748b" fontSize={9} tickLine={false} tickFormatter={(v) => `$${v}`} />
                  <Tooltip {...TIP} formatter={(v, _n, p) => [`$${Number(v).toFixed(2)} • ${(p.payload as { kwh: number }).kwh} kWh`, (p.payload as { range: string }).range]} />
                  <Bar dataKey="cost" fill="#10b981" fillOpacity={0.85} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                </BarChart>
              )}</Sized>
            </div>
            <div className="flex items-center justify-between text-[10px] text-slate-500">
              <span>By month the bill starts</span>
              <DisconnectLink onDisconnect={onDisconnect} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DisconnectLink({ onDisconnect }: { onDisconnect: () => void }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (!confirm) return; const t = setTimeout(() => setConfirm(false), 4000); return () => clearTimeout(t); }, [confirm]);
  return (
    <button onClick={() => (confirm ? onDisconnect() : setConfirm(true))} className={`px-2 py-0.5 rounded-md ${confirm ? "text-rose-300 bg-rose-500/10 border border-rose-500/30" : "text-slate-500"}`}>
      {confirm ? "Tap to disconnect" : "Disconnect Con Edison"}
    </button>
  );
}

/** Con Edison sign in. The details are checked with Con Edison, then kept encrypted in Supabase. */
function ConEdConnect({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/coned", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, totp: totp || undefined }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setPassword("");
      onConnected();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full h-12 px-4 rounded-xl bg-black/40 border border-white/10 text-[15px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500/50 select-text";
  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form onSubmit={submit} className="bg-[#1c1613] border border-white/15 rounded-3xl p-5 w-full max-w-sm shadow-2xl flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className={`p-2 rounded-xl border ${GREEN}`}><Zap className="w-4 h-4" /></div>
            <div><h3 className="text-sm font-bold text-white">Connect Con Edison</h3><p className="text-[11px] text-slate-400">Bill, projected bill and daily usage</p></div>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="w-10 h-10 flex items-center justify-center rounded-xl bg-white/5 border border-white/10 text-slate-400"><X className="w-4 h-4" /></button>
        </div>
        <label className="sr-only" htmlFor="coned-email">Con Edison email</label>
        <input id="coned-email" className={input} type="email" autoComplete="username" placeholder="Con Edison email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label className="sr-only" htmlFor="coned-password">Con Edison password</label>
        <input id="coned-password" className={input} type="password" autoComplete="current-password" placeholder="Con Edison password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <label className="sr-only" htmlFor="coned-totp">Authenticator setup key</label>
        <input id="coned-totp" className={`${input} font-mono text-[13px]`} autoCapitalize="characters" autoCorrect="off" spellCheck={false} placeholder="Authenticator setup key" value={totp} onChange={(e) => setTotp(e.target.value)} />
        <p className="text-[11px] text-slate-500 leading-snug">The setup key is the code shown under the QR code when you choose an authenticator app for Con Edison&apos;s 2FA. It lets the dashboard sign in on its own every 2 hours. Everything is saved encrypted in your Supabase, not on this iPad.</p>
        {err && <p role="alert" className="text-[12px] text-rose-300 text-center">{err}</p>}
        <button type="submit" disabled={busy} className="h-12 rounded-xl bg-emerald-500 text-slate-950 text-sm font-bold disabled:opacity-60 active:scale-[0.99]">
          {busy ? "Signing in to Con Edison" : "Connect"}
        </button>
        {busy && <p className="text-[11px] text-slate-500 text-center -mt-1">The first sign in can take up to a minute.</p>}
      </form>
    </div>
  );
}

const ROOM_TEMP_SAMPLE = [76, 75, 74, 74, 73, 74, 77, 79, 80, 78, 76, 75, 74].map((v, i) => ({ time: `${String((22 + i * 2) % 24).padStart(2, "0")}:00`, v }));

function RoomTempSample() {
  return (
    <div className="relative flex-1 min-h-[110px]">
      <div className="absolute inset-0">
        <Sized>{(w, h) => (
          <AreaChart width={w} height={h} data={ROOM_TEMP_SAMPLE} margin={{ top: 5, right: 4, left: -22, bottom: 0 }}>
            <XAxis dataKey="time" stroke="#64748b" fontSize={10} tickLine={false} interval={2} />
            <YAxis stroke="#64748b" fontSize={10} tickLine={false} domain={[68, 84]} />
            <Area type="monotone" dataKey="v" stroke="#22d3ee" fill="#22d3ee" fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />
          </AreaChart>
        )}</Sized>
      </div>
    </div>
  );
}

function AcZoneSample() {
  return (
    <>
      <div className="flex items-center justify-between px-4">
        <span className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 text-3xl font-bold flex items-center justify-center">−</span>
        <span className="relative w-44 h-44">
          <svg viewBox="0 0 250 250" className="w-full h-full">
            <circle cx="125" cy="125" r="105" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="12" strokeDasharray="495 660" strokeLinecap="round" transform="rotate(135 125 125)" />
            <circle cx="125" cy="125" r="105" fill="none" stroke="#22d3ee" strokeWidth="12" strokeDasharray="271 660" strokeLinecap="round" transform="rotate(135 125 125)" />
          </svg>
          <span className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[10px] font-mono text-slate-400 tracking-widest">SET TO</span>
            <span className="text-5xl font-bold font-mono">72°</span>
            <span className="text-[11px] font-mono text-cyan-400 tracking-wider">COOL</span>
          </span>
        </span>
        <span className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 text-3xl font-bold flex items-center justify-center">+</span>
      </div>
      <span className="text-[10px] font-mono text-slate-500 tracking-wider">MODE</span>
      <span className="grid grid-cols-5 gap-1 p-1 bg-black/50 rounded-xl border border-white/5">
        {["Cool", "Heat", "Auto", "Dry", "Fan"].map((m, i) => <span key={m} className={`py-3 text-sm rounded-lg text-center font-medium ${i === 0 ? "bg-cyan-500 text-slate-950 font-bold" : "text-slate-400"}`}>{m}</span>)}
      </span>
      <span className="text-[10px] font-mono text-slate-500 tracking-wider">FAN</span>
      <span className="grid grid-cols-4 gap-1 p-1 bg-black/50 rounded-xl border border-white/5">
        {["Auto", "Low", "Med", "High"].map((m, i) => <span key={m} className={`py-3 text-sm rounded-lg text-center font-medium ${i === 0 ? "bg-cyan-500 text-slate-950 font-bold" : "text-slate-400"}`}>{m}</span>)}
      </span>
      <span className="flex items-baseline justify-between pt-1">
        <span className="text-[10px] font-mono text-slate-500 tracking-wider">ROOM TEMPERATURE</span>
        <span className="text-[10px] font-mono text-slate-600">LAST 24 HOURS</span>
      </span>
      <RoomTempSample />
    </>
  );
}

const TV_APPS = [
  { pkg: "com.netflix.ninja", name: "Netflix", color: "#e50914" }, { pkg: "com.amazon.firetv.youtube", name: "YouTube", color: "#ff3b30" },
  { pkg: "com.amazon.firebat", name: "Prime Video", color: "#38bdf8" }, { pkg: "com.hbo.hbonow", name: "HBO Max", color: "#a78bfa" },
  { pkg: "com.disney.disneyplus", name: "Disney+", color: "#60a5fa" }, { pkg: "com.spotify.tv.android", name: "Spotify", color: "#22c55e" },
];

// The TV counts as reachable while it has reported recently with the screen on.
const tvStatus = (tv: TV | undefined) => {
  const s = tv?.state;
  if (!tv || !s) return { seen: false, on: false };
  const fresh = !!tv.recorded_at && Date.now() - new Date(tv.recorded_at).getTime() < 6 * 60_000;
  return { seen: true, on: fresh && s.screen !== "off" };
};


// ---------- Ring camera ----------

const MODE_LABEL: Record<string, string> = { disarmed: "Disarmed", home: "Home", away: "Away" };

function minsAgo(ms: number | null, now: number) {
  if (!ms) return null;
  const m = Math.max(0, Math.round((now - ms) / 60000));
  return m < 1 ? "JUST NOW" : m < 60 ? `${m} MIN AGO` : `${Math.round(m / 60)} H AGO`;
}

const RING_ICE = [
  "stun:stun.kinesisvideo.us-east-1.amazonaws.com:443", "stun:stun.kinesisvideo.us-east-2.amazonaws.com:443",
  "stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302",
].map((urls) => ({ urls }));
const LIVE_MAX_MS = 10 * 60_000; // Ring ends live sessions on its own after about 10 minutes

/**
 * Ring live view over WebRTC: the browser makes an offer, Ring answers through our function, and the
 * video then streams from Ring straight to this page (same flow as ring-client-api's browser session).
 */
function useRingLive(camId: string) {
  const [status, setStatus] = useState<"off" | "starting" | "live">("off");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const session = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    pc.current?.close();
    pc.current = null;
    const sid = session.current;
    session.current = null;
    if (sid) fetch("/api/camera/live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "end", session_id: sid }), keepalive: true }).catch(() => {});
    setStream(null);
    setStatus("off");
  }, []);

  const start = useCallback(async () => {
    setErr(null);
    setStatus("starting");
    try {
      const conn = new RTCPeerConnection({ iceServers: RING_ICE });
      pc.current = conn;
      conn.addTransceiver("audio", { direction: "sendrecv" });
      conn.addTransceiver("video", { direction: "recvonly" });
      const media = new MediaStream();
      conn.ontrack = (e) => {
        media.addTrack(e.track);
        setStream(media);
        setStatus("live");
      };
      conn.onconnectionstatechange = () => {
        if (conn.connectionState === "failed") { setErr("The live stream dropped. Tap Live to try again."); stop(); }
      };
      await conn.setLocalDescription(await conn.createOffer());
      // Ring doesn't take candidates afterwards, so wait for them to be gathered (or 2.5 s).
      await new Promise<void>((resolve) => {
        if (conn.iceGatheringState === "complete") return resolve();
        const t = setTimeout(resolve, 2500);
        conn.addEventListener("icegatheringstatechange", () => { if (conn.iceGatheringState === "complete") { clearTimeout(t); resolve(); } });
      });
      const r = await fetch("/api/camera/live", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", id: camId, sdp: conn.localDescription?.sdp }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      if (pc.current !== conn) return; // stopped while waiting
      session.current = body.session_id;
      await conn.setRemoteDescription({ type: "answer", sdp: body.sdp });
      timer.current = setTimeout(stop, LIVE_MAX_MS);
    } catch (e) {
      setErr((e as Error).message);
      stop();
    }
  }, [camId, stop]);

  useEffect(() => () => stop(), [stop]); // leaving the page ends the session
  return { status, stream, err, start, stop };
}

function LiveVideo({ stream, muted, zoom }: { stream: MediaStream; muted: boolean; zoom: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    v.play().catch(() => {});
  }, [stream]);
  useEffect(() => { if (ref.current) ref.current.muted = muted; }, [muted]);
  return <video ref={ref} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-cover transition-transform duration-300" style={{ transform: `scale(${zoom})` }} />;
}

/** The latest Ring snapshot, refreshed every minute while on screen. Snap asks for a fresh one. */
function RingFeed({ cam, big }: { cam: Camera; big?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [taken, setTaken] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [now, setNow] = useState(() => Date.now());
  const url = useRef<string | null>(null);
  const live = useRingLive(cam.id);
  const [muted, setMuted] = useState(true);

  const load = useCallback(async (force = false) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/camera/snapshot?id=${encodeURIComponent(cam.id)}${force ? "&force=1" : ""}&t=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      const blob = await r.blob();
      const next = URL.createObjectURL(blob);
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = next;
      setSrc(next);
      const t = Number(r.headers.get("x-snapshot-ms"));
      setTaken(Number.isFinite(t) && t > 0 ? t : Date.now());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message.replace(/ \(from .*\)$/, ""));
    } finally {
      setBusy(false);
    }
  }, [cam.id]);

  useEffect(() => {
    load();
    const refresh = setInterval(() => document.visibilityState === "visible" && load(), 60_000);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => { clearInterval(refresh); clearInterval(tick); if (url.current) URL.revokeObjectURL(url.current); };
  }, [load]);

  const s = cam.state;
  const btn = `flex items-center gap-1.5 px-3 ${big ? "h-12 text-sm" : "h-10 text-[11px]"} rounded-xl font-medium active:scale-95 transition-transform`;
  return (
    <>
      <div className="relative flex-1 min-h-[120px] rounded-2xl overflow-hidden border border-white/10 bg-black">
        {src && <img src={src} alt={`${cam.name} camera snapshot`} className="absolute inset-0 w-full h-full object-cover transition-transform duration-300" style={{ transform: `scale(${zoom})` }} />}
        {src && live.status !== "live" && (
          <span aria-hidden="true" className="absolute inset-x-0 top-0 h-16 pointer-events-none scan-line bg-gradient-to-b from-transparent via-emerald-300/10 to-transparent" />
        )}
        {live.stream && <LiveVideo stream={live.stream} muted={muted} zoom={zoom} />}
        {!src && !err && !live.stream && <span className="absolute inset-0 flex items-center justify-center text-[12px] text-slate-500">Loading snapshot</span>}
        {(live.err || (err && !live.stream)) && (
          <span className={`absolute inset-x-3 ${src ? "bottom-3" : "top-1/2 -translate-y-1/2"} text-center text-[12px] text-rose-200 bg-black/80 border border-rose-500/30 rounded-xl px-3 py-2`}>{live.err ?? err}</span>
        )}
        {live.status === "live" ? (
          <span className="absolute top-2 left-2 bg-black/80 px-2 py-1 rounded-lg text-[10px] font-mono flex items-center gap-1.5 border border-white/10 text-rose-400">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />LIVE
          </span>
        ) : (
          <span className={`absolute top-2 left-2 bg-black/80 px-2 py-1 rounded-lg text-[10px] font-mono flex items-center gap-1.5 border border-white/10 ${s?.online === false ? "text-rose-400" : "text-emerald-400"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${s?.online === false ? "bg-rose-400" : "bg-emerald-400"} ${busy || live.status === "starting" ? "animate-pulse" : ""}`} />
            {s?.online === false ? "CAMERA OFFLINE" : live.status === "starting" ? "CONNECTING LIVE" : `SNAPSHOT${taken ? ` • ${minsAgo(taken, now)}` : ""}`}
          </span>
        )}
        {live.status === "live" && (
          <button onClick={() => setMuted((m) => !m)} aria-label={muted ? "Unmute" : "Mute"}
            className="absolute bottom-2 right-2 w-9 h-9 flex items-center justify-center rounded-lg bg-black/80 border border-white/10 text-slate-200">
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
        )}
        {s?.battery != null && (
          <span className="absolute top-2 right-2 bg-black/80 px-2 py-1 rounded-lg text-[10px] font-mono text-slate-300 border border-white/10">
            {s.charging ? "CHARGING " : "BATTERY "}{s.battery}%
          </span>
        )}
      </div>
      <div className="flex items-center justify-between gap-2">
        {live.status === "off" ? (
          <button onClick={live.start} disabled={s?.online === false} className={`${btn} bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 font-semibold disabled:opacity-40`}>
            <Video className="w-3.5 h-3.5" /> Live
          </button>
        ) : (
          <button onClick={live.stop} className={`${btn} bg-rose-500/15 border border-rose-500/40 text-rose-300 font-semibold`}>
            <span className={`w-2 h-2 rounded-sm bg-rose-400 ${live.status === "starting" ? "animate-pulse" : ""}`} /> {live.status === "starting" ? "Connecting" : "Stop"}
          </button>
        )}
        <span className="flex items-center gap-2">
          {/* Ring has no public link into its app, so this runs an iPad Shortcut named "Open Ring" (Open App: Ring). */}
          <a href="shortcuts://run-shortcut?name=Open%20Ring" aria-label="Open the Ring app"
            className={`${btn} bg-white/5 border border-white/10 text-slate-200`}><ExternalLink className="w-3.5 h-3.5 text-cyan-400" />{big ? " Ring app" : ""}</a>
          <button onClick={() => load(true)} disabled={busy || live.status !== "off"} className={`${btn} bg-white/5 border border-white/10 text-slate-200 disabled:opacity-50`}>
            <RefreshCw className={`w-3.5 h-3.5 text-amber-400 ${busy ? "animate-spin" : ""}`} /> Snap
          </button>
          <span className={`flex items-center gap-1 px-1.5 ${big ? "h-12" : "h-10"} bg-black/40 rounded-xl border border-white/5 text-slate-400`}>
            <button aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(1, +(z - 0.5).toFixed(1)))} className="w-8 h-8 flex items-center justify-center"><ZoomOut className="w-3.5 h-3.5" /></button>
            <span className="text-amber-400 font-mono font-bold text-[11px] w-8 text-center">{zoom.toFixed(1)}x</span>
            <button aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(3, +(z + 0.5).toFixed(1)))} className="w-8 h-8 flex items-center justify-center"><ZoomIn className="w-3.5 h-3.5" /></button>
          </span>
        </span>
      </div>
    </>
  );
}

function ModeChip({ cam, onClick }: { cam: Camera; onClick: () => void }) {
  const m = cam.state?.mode;
  if (!m || !MODE_LABEL[m]) return null;
  const armed = m !== "disarmed";
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1.5 px-3 h-9 rounded-xl text-[11px] font-medium border whitespace-nowrap shrink-0 active:scale-95 ${armed ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 glow-ring" : "bg-rose-500/10 text-rose-400 border-rose-500/30"}`}>
      {armed ? <ShieldCheck className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}{armed ? `Armed • ${MODE_LABEL[m] ?? m}` : "Disarmed"}
    </button>
  );
}

const eventLabel = (e: CameraEvent) =>
  e.kind === "ding" ? "Doorbell" : e.kind === "on_demand" ? "Live view opened" : e.person ? "Person detected" : "Motion";

/** Ring sign in: email and password, then the code Ring sends. Nothing is stored here. */
function RingConnect({ onConnected }: { onConnected: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [prompt, setPrompt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/ring/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, code: prompt ? code : undefined }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      if (body.need_code) { setPrompt(body.prompt); setCode(""); return; }
      setPassword("");
      onConnected();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full h-12 px-4 rounded-xl bg-black/40 border border-white/10 text-[15px] text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500/50 select-text";
  return (
    <form onSubmit={submit} className="w-full max-w-sm mx-auto flex flex-col gap-3">
      <div className="text-center space-y-1 mb-1">
        <div className="mx-auto w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/25 text-amber-400 flex items-center justify-center"><Video className="w-5 h-5" /></div>
        <h3 className="text-[15px] font-bold text-white pt-2">Connect your Ring account</h3>
        <p className="text-[12px] text-slate-400">{prompt ?? "Your password goes to Ring once and isn't saved. Ring will send you a code."}</p>
      </div>
      {!prompt ? (
        <>
          <label className="sr-only" htmlFor="ring-email">Ring email</label>
          <input id="ring-email" className={input} type="email" autoComplete="username" placeholder="Ring email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <label className="sr-only" htmlFor="ring-password">Ring password</label>
          <input id="ring-password" className={input} type="password" autoComplete="current-password" placeholder="Ring password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </>
      ) : (
        <>
          <label className="sr-only" htmlFor="ring-code">Verification code</label>
          <input id="ring-code" className={`${input} text-center tracking-[0.4em] font-mono text-lg`} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))} required autoFocus />
        </>
      )}
      {err && <p role="alert" className="text-[12px] text-rose-300 text-center">{err}</p>}
      <button type="submit" disabled={busy} className="h-12 rounded-xl bg-amber-500 text-slate-950 text-sm font-bold disabled:opacity-60 active:scale-[0.99]">
        {busy ? "Connecting" : prompt ? "Verify and connect" : "Continue"}
      </button>
      {prompt && <button type="button" onClick={() => { setPrompt(null); setErr(null); }} className="text-[12px] text-slate-400 underline underline-offset-4">Start over</button>}
    </form>
  );
}

function TvPanel({ tv, send, compact }: { tv: TV; send: Send; compact?: boolean }) {
  const s = tv.state;
  const { on } = tvStatus(tv);
  const apps = tv.capabilities.apps?.length ? tv.capabilities.apps : TV_APPS;
  const key = `h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-200 active:scale-95 disabled:opacity-30 transition-transform`;
  const vol = s?.volume ?? 0, max = s?.max_volume ?? 30;
  return (
    <>
      <div className={`grid ${compact ? "grid-cols-6 gap-1" : "grid-cols-3 gap-1.5"}`}>
        {apps.map((a) => {
          const active = on && s?.app === a.pkg;
          return (
            <button key={a.pkg} disabled={!on} aria-pressed={active} aria-label={`Open ${a.name}`} onClick={() => send(tv, { action: "launch", app: a.pkg }, { app: a.pkg, app_name: a.name })}
              className={`${compact ? "h-8 text-[10px]" : "h-9 text-[11px]"} rounded-xl border font-bold transition-all active:scale-95 disabled:opacity-40 ${active ? "bg-white/10 border-white/30 shadow-lg shadow-black/40" : "bg-black/30 border-white/5"}`}
              style={{ color: TV_APPS.find((x) => x.pkg === a.pkg)?.color ?? "#e2e8f0" }}>{compact ? a.name.replace(" Video", "").replace(" Max", "") : a.name}</button>
          );
        })}
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        <button aria-label="Put the TV to sleep" disabled={!on} onClick={() => send(tv, { action: "sleep" }, { screen: "off" })}
          className={`${key} !bg-amber-500/20 !border-amber-500/40 !text-amber-300`}><Power className="w-4 h-4" /></button>
        <button aria-label="Home" disabled={!on} onClick={() => send(tv, { action: "home" }, { app: "app.tvdashboard", app_name: "Dashboard" })} className={key}><HomeIcon className="w-4 h-4" /></button>
        <button aria-label="Back" disabled={!on} onClick={() => send(tv, { action: "back" }, {})} className={key}><Undo2 className="w-4 h-4" /></button>
        <button aria-label="Volume down" disabled={!on} onClick={() => send(tv, { action: "volume", dir: "down" }, { volume: Math.max(0, vol - 1), muted: false })} className={key}><Volume1 className="w-4 h-4" /></button>
        <button aria-label="Volume up" disabled={!on} onClick={() => send(tv, { action: "volume", dir: "up" }, { volume: Math.min(max, vol + 1), muted: false })} className={key}><Volume2 className="w-4 h-4" /></button>
      </div>
    </>
  );
}

// Front door smart lock, shown as a preview until a lock is installed.
function LockSample({ noButton }: { noButton?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-12 h-12 shrink-0 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center"><Lock className="w-5 h-5" /></span>
      <span className="flex-1 min-w-0">
        <span className="block text-[17px] font-bold text-white leading-tight">Locked</span>
        <span className="block text-[11px] text-slate-400 truncate">Unlocked with keypad • 6:12 PM</span>
      </span>
      <span className="flex flex-col items-end gap-1.5 shrink-0">
        <span className="text-[10px] font-mono text-slate-400">BATTERY 86%</span>
        {!noButton && <span className="flex items-center gap-1.5 px-3.5 h-10 rounded-xl bg-white/5 border border-white/10 text-[12px] font-semibold text-slate-200"><LockOpen className="w-4 h-4 text-amber-400" />Unlock</span>}
      </span>
    </div>
  );
}

// The Security tab's lock panel: status with lock and unlock, battery and auto lock, and the last few entries.
function LockPanelSample() {
  return (
    <>
      <LockSample noButton />
      <span className="grid grid-cols-2 gap-1.5">
        <span className="h-11 rounded-xl bg-emerald-500 text-slate-950 text-[12px] font-bold flex items-center justify-center gap-1.5"><Lock className="w-4 h-4" />Lock</span>
        <span className="h-11 rounded-xl bg-white/5 border border-white/10 text-slate-200 text-[12px] font-semibold flex items-center justify-center gap-1.5"><LockOpen className="w-4 h-4 text-amber-400" />Unlock</span>
      </span>
      <span className="flex items-center justify-between text-[11px] text-slate-400 px-0.5">
        <span>Auto lock after 2 min</span><span className="font-mono text-slate-500">DOOR CLOSED</span>
      </span>
    </>
  );
}

/** Little bouncing bars while the TV is playing. */
function Equalizer() {
  return (
    <span aria-hidden="true" className="flex items-end gap-[2px] h-3">
      {[0, 0.3, 0.15, 0.45].map((d, i) => <span key={i} className="eq-bar w-[2px] h-full rounded-full bg-cyan-300" style={{ animationDelay: `${d}s`, animationDuration: `${0.8 + i * 0.15}s` }} />)}
    </span>
  );
}

function TvSample() {
  const key = "h-10 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-200";
  return (
    <>
      <div className="grid grid-cols-3 gap-1.5">
        {TV_APPS.map((a, i) => (
          <span key={a.name} className={`h-9 rounded-xl border flex items-center justify-center text-[11px] font-bold ${i === 0 ? "bg-white/10 border-white/25" : "bg-black/30 border-white/5"}`} style={{ color: a.color }}>{a.name}</span>
        ))}
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        <span className={`${key} bg-amber-500/20 border-amber-500/40 text-amber-300`}><Power className="w-4 h-4" /></span>
        <span className={key}><HomeIcon className="w-4 h-4" /></span>
        <span className={key}><Undo2 className="w-4 h-4" /></span>
        <span className={key}><Volume1 className="w-4 h-4" /></span>
        <span className={key}><Volume2 className="w-4 h-4" /></span>
      </div>
    </>
  );
}

type Send = (d: Device, c: Command, patch: Record<string, unknown>) => void | Promise<void>;
type Unit = "F" | "C";
const toUnit = (f: number, u: Unit) => (u === "C" ? Math.round((f - 32) * (5 / 9)) : f);

// ---------- lights ----------

// One light button for a single bulb or several bulbs on one circuit: tap the name to open the color
// menu, the power button switches it, and the slider along the bottom dims it.
function LightTile({ lights, label, onOpen, onPower, onBright, big }: {
  lights: Light[]; label: string; onOpen: () => void; onPower: (on: boolean) => void; onBright: (v: number) => void; big?: boolean;
}) {
  const reachable = lights.filter((l) => l.state?.online !== false);
  const onLights = reachable.filter((l) => l.state?.power);
  const on = onLights.length > 0;
  const offline = reachable.length === 0;
  const lead = onLights[0] ?? reachable[0] ?? lights[0];
  const hex = lead ? lightHex(lead) : "#f59e0b";
  const range = lead?.capabilities.brightness ?? null;
  const bright = lead?.state?.brightness ?? 100;
  const [b, setB] = useState(bright);
  const dragging = useRef(false);
  const sent = useRef<number | null>(null);
  useEffect(() => { if (!dragging.current) setB(bright); }, [bright]);
  const commit = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (sent.current !== b || !on) { sent.current = b; onBright(b); }
  };
  const many = lights.length > 1;
  const status = offline ? "Offline"
    : !on ? "Off"
    : many && onLights.length < lights.length ? `${onLights.length} of ${lights.length} on, ${b}%`
    : `On, ${b}%`;
  const pct = range ? ((b - range.min) / Math.max(1, range.max - range.min)) * 100 : 0;
  return (
    <div className={`relative w-full ${big ? "h-40" : "h-[120px]"} rounded-2xl border transition-all duration-300 flex flex-col overflow-hidden select-none ${offline
      ? "bg-[#1e1916]/40 border-white/5 opacity-40"
      : on ? "bg-gradient-to-b from-[#2a211a] to-[#1c1511] border-amber-500/40 shadow-lg shadow-amber-950/40" : "bg-[#1e1916]/60 border-white/5"}`}>
      {on && <span className="absolute inset-x-0 bottom-0 h-2/3 pointer-events-none breathe" style={{ background: `radial-gradient(circle at bottom, ${hex}, transparent 80%)` }} />}
      <div className={`relative z-10 flex-1 min-h-0 flex items-start gap-2 ${big ? "p-4 pb-2" : "p-3 pb-1.5"}`}>
        <button onClick={onOpen} disabled={offline} aria-label={`${label} color`} className="flex-1 min-w-0 h-full text-left flex flex-col justify-between">
          <span className="flex items-center gap-2 min-w-0">
            <span className={`${big ? "text-base" : "text-[13px]"} font-semibold text-white tracking-tight truncate`}>{label}</span>
            {many ? (
              <span className="flex gap-1 shrink-0">
                {lights.map((l) => (
                  <span key={l.id} className="w-2 h-2 rounded-full border border-white/25"
                    style={{ backgroundColor: l.state?.power && l.state?.online !== false ? lightHex(l) : "transparent", opacity: l.state?.online === false ? 0.35 : 1 }} />
                ))}
              </span>
            ) : on && <span className="w-2.5 h-2.5 rounded-full border border-white/30 shrink-0" style={{ backgroundColor: hex }} />}
          </span>
          <span className={`${big ? "text-sm" : "text-[11px]"} font-medium ${offline ? "text-rose-400/90" : on ? "text-amber-200/90" : "text-slate-500"}`}>{status}</span>
        </button>
        <button onClick={() => onPower(!on)} disabled={offline} aria-label={on ? `Turn off ${label}` : `Turn on ${label}`} aria-pressed={on}
          className={`shrink-0 ${big ? "w-11 h-11" : "w-10 h-10"} flex items-center justify-center rounded-xl border transition-all active:scale-95 ${on
            ? "bg-amber-500 text-slate-950 border-amber-400 shadow-md shadow-amber-500/20" : "bg-white/5 text-slate-300 border-white/10"}`}>
          <Power className="w-4 h-4" />
        </button>
      </div>
      {range && (
        <div className={`relative z-10 ${big ? "px-4 pb-4" : "px-3 pb-3"}`}>
          <input type="range" className="tile-range" min={range.min} max={range.max} value={b} disabled={offline} aria-label={`${label} brightness`}
            style={{ ["--pct" as string]: `${pct}%`, ["--glow" as string]: on ? hex : "#64748b" }}
            onPointerDown={() => { dragging.current = true; }} onTouchStart={() => { dragging.current = true; }}
            onChange={(e) => { dragging.current = true; setB(Number(e.target.value)); }}
            onPointerUp={commit} onTouchEnd={commit} onKeyUp={() => { dragging.current = true; commit(); }} onBlur={commit} />
        </div>
      )}
    </div>
  );
}

// One slim row per room for the overview's Lighting Console: the rows sit together in one list so the
// console takes little height.
function RoomRow({ room, lights, onOpen, onAll }: { room: (typeof ROOMS)[number]; lights: Light[]; onOpen: () => void; onAll: (on: boolean) => void }) {
  const Icon = room.icon;
  const reachable = lights.filter((l) => l.state?.online !== false);
  const onLights = reachable.filter((l) => l.state?.power);
  const offline = lights.length - reachable.length;
  const allOn = reachable.length > 0 && onLights.length === reachable.length;
  const glow = onLights[0] ? lightHex(onLights[0]) : null;
  return (
    <div className="relative flex-1 min-h-[54px] flex items-center overflow-hidden">
      {glow && <span className="absolute inset-y-0 left-0 w-1/2 pointer-events-none breathe" style={{ background: `radial-gradient(circle at left, ${glow}, transparent 75%)` }} />}
      <button onClick={onOpen} className="relative z-10 flex-1 min-w-0 h-full flex items-center gap-3 pl-3 pr-2 text-left active:bg-white/5 transition-colors">
        <span className={`w-9 h-9 shrink-0 rounded-xl flex items-center justify-center border transition-shadow duration-700 ${onLights.length ? "bg-amber-500/15 border-amber-500/30 text-amber-300" : "bg-white/5 border-white/10 text-slate-500"}`}
          style={glow ? { boxShadow: `0 0 16px -2px ${glow}` } : undefined}>
          <Icon className="w-4 h-4" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-0.5 text-[14px] font-semibold text-white leading-tight">{room.name}<ChevronRight className="w-3.5 h-3.5 text-slate-500" /></span>
          <span className="block text-[11px] text-slate-400 truncate">
            <span className={onLights.length ? "text-amber-200/90" : ""}>{onLights.length} of {lights.length} on</span>
            {offline > 0 && <span className="text-rose-400/80"> • {offline} offline</span>}
          </span>
          {/* Each light as a chip, so the row shows which lights are on at a glance. */}
          <span className="flex flex-wrap gap-1 mt-1.5">
            {lights.map((l) => {
              const lit = !!l.state?.power && l.state?.online !== false;
              return (
                <span key={l.id} className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] ${lit ? "bg-white/10 border-white/15 text-slate-200" : "bg-black/20 border-white/5 text-slate-500"} ${l.state?.online === false ? "opacity-40 line-through" : ""}`}>
                  <span className="w-1.5 h-1.5 rounded-full border border-white/20" style={{ backgroundColor: lit ? lightHex(l) : "transparent" }} />
                  {shortName(l.name, room.name)}
                </span>
              );
            })}
          </span>
        </span>
      </button>
      <button onClick={() => onAll(!allOn)} disabled={!reachable.length} aria-label={allOn ? `Turn off ${room.name} lights` : `Turn on ${room.name} lights`}
        className={`relative z-10 shrink-0 mr-2.5 h-9 w-[76px] flex items-center justify-center gap-1.5 rounded-lg border text-[11px] font-semibold transition-all active:scale-95 disabled:opacity-30 ${allOn
          ? "bg-amber-500 text-slate-950 border-amber-400 shadow-md shadow-amber-500/20" : "bg-white/5 text-slate-300 border-white/10"}`}>
        <Power className="w-3.5 h-3.5" />{allOn ? "All off" : "All on"}
      </button>
    </div>
  );
}

const PRESETS = ["#f59e0b", "#60a5fa", "#f43f5e", "#a855f7", "#10b981", "#06b6d4"];
const WHITES = [2700, 4000, 6500];

function LightSheet({ light, send, onClose, title, sub, footer }: { light: Light; send: Send; onClose: () => void; title?: string; sub?: string; footer?: ReactNode }) {
  const s = light.state;
  const caps = light.capabilities;
  const on = !!s?.power;
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

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-[#1c1613] border border-white/15 rounded-3xl p-5 w-full max-w-sm shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b border-white/10 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="w-4 h-4 rounded-full border border-white/30" style={{ backgroundColor: on ? hex : "transparent" }} />
            <div><h3 className="text-sm font-bold text-white">{title ?? light.name}</h3><p className="text-[11px] text-slate-400">{sub ?? "Color"}</p></div>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-10 h-10 flex items-center justify-center rounded-xl bg-white/5 border border-white/10 text-slate-400"><X className="w-4 h-4" /></button>
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

        {footer}
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


// ---------- Water tab pieces ----------

const MODE_NAME: Record<string, string> = { energy_saver: "Energy Saver", heat_pump: "Heat Pump", high_demand: "High Demand", electric: "Electric", vacation: "Vacation", gas: "Gas", off: "Off" };

/** A glass tank drawn to the hot water level, with a moving surface and bubbles while it heats. */
function GlassTank({ pct, heating, off, small }: { pct: number | null; heating: boolean; off: boolean; small?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const level = Math.max(0, Math.min(100, pct ?? 0));
  const top = 14 + 332 * (1 - level / 100); // liquid surface, inside a 332 tall tank starting at y 14
  const warm = off ? ["#94a3b8", "#475569"] : ["#fcd34d", "#ea580c"];
  const wave = (y: number, amp: number) => `M0 ${y} q 30 ${-amp} 60 0 t 60 0 t 60 0 t 60 0 t 60 0 V 360 H 0 Z`;
  return (
    <div className="relative w-full h-full" role="img" aria-label={`Hot water ${pct ?? "unknown"}%`}>
      <svg viewBox="0 0 176 360" className="absolute inset-0 w-full h-full">
        <defs>
          <clipPath id={`tank-clip-${uid}`}><rect x="14" y="14" width="132" height="332" rx="62" /></clipPath>
          <linearGradient id={`tank-liquid-${uid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={warm[0]} /><stop offset="100%" stopColor={warm[1]} /></linearGradient>
          <linearGradient id={`tank-glass-${uid}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.10" /><stop offset="35%" stopColor="#fff" stopOpacity="0.02" /><stop offset="100%" stopColor="#fff" stopOpacity="0.06" />
          </linearGradient>
          <radialGradient id={`tank-glow-${uid}`} cx="50%" cy="100%" r="80%"><stop offset="0%" stopColor="#f97316" stopOpacity="0.35" /><stop offset="100%" stopColor="#f97316" stopOpacity="0" /></radialGradient>
        </defs>
        {!off && <ellipse cx="80" cy="340" rx="90" ry="40" fill={`url(#tank-glow-${uid})`} />}
        <rect x="14" y="14" width="132" height="332" rx="62" fill="#0b0908" stroke="rgba(255,255,255,0.14)" strokeWidth="2" />
        <g clipPath={`url(#tank-clip-${uid})`}>
          <g className="tank-wave-slow" style={{ opacity: 0.45 }}><path d={wave(top + 2, 6)} fill={`url(#tank-liquid-${uid})`} transform="translate(0 0)" /></g>
          <g className="tank-wave"><path d={wave(top, 8)} fill={`url(#tank-liquid-${uid})`} /></g>
          {heating && !off && [22, 48, 70, 96, 118, 60, 104].map((x, i) => (
            <circle key={i} className="tank-bubble" cx={x + 14} cy={340} r={2 + (i % 3)} fill="#fff" fillOpacity={0.5}
              style={{ animationDelay: `${(i * 0.47) % 3.4}s` }} />
          ))}
          <rect x="14" y="14" width="132" height="332" fill={`url(#tank-glass-${uid})`} />
          <rect x="30" y="40" width="10" height="250" rx="5" fill="#fff" fillOpacity="0.07" />
        </g>
        {[25, 50, 75].map((t) => {
          const y = 14 + 332 * (1 - t / 100);
          return (
            <g key={t}>
              <line x1="132" x2="146" y1={y} y2={y} stroke="rgba(255,255,255,0.25)" strokeWidth="1.5" />
              {!small && <text x="152" y={y + 3.5} fontSize="10" fill="#64748b" fontFamily="ui-monospace, monospace">{t}</text>}
            </g>
          );
        })}
      </svg>
      <span className="absolute inset-y-0 left-0 w-[91%] flex flex-col items-center justify-center pointer-events-none">
        <span className={`${small ? "text-[20px]" : "text-[34px]"} leading-none font-bold font-mono tabular-nums drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)] ${off ? "text-slate-300" : "text-white"}`}>{pct ?? "--"}<span className={small ? "text-[11px]" : "text-[18px]"}>%</span></span>
        {!small && <span className="mt-1 text-[9px] font-mono tracking-[0.2em] text-white/70 drop-shadow">HOT WATER</span>}
      </span>
    </div>
  );
}

/** Heating, ready or off, with a pulsing dot while it heats. */
function HeaterStatus({ heater }: { heater: Heater }) {
  const hs = heater.state;
  const off = hs?.power === false || hs?.mode === "off";
  const heating = !!hs?.running && !off;
  return (
    <span className={`flex items-center gap-1.5 px-2.5 h-7 rounded-lg border text-[11px] font-medium whitespace-nowrap ${heating ? "bg-rose-500/10 border-rose-500/30 text-rose-200" : off ? "bg-white/5 border-white/10 text-slate-400" : "bg-emerald-500/10 border-emerald-500/25 text-emerald-300"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${heating ? "bg-rose-400 heat-pulse" : off ? "bg-slate-500" : "bg-emerald-400"}`} />
      {hs?.connected === false ? "Offline" : heating ? hs?.running : off ? "Off" : "Ready • not heating"}
    </span>
  );
}

/** Setpoint as an arc between the heater's lowest and highest temperature, with − and + on either side. */
function SetpointDial({ value, lo, hi, unit, off, mode, onNudge, small }: { value: number; lo: number; hi: number; unit: Unit; off: boolean; mode: string; onNudge: (d: number) => void; small?: boolean }) {
  const frac = Math.max(0, Math.min(1, (value - lo) / (hi - lo || 1)));
  const arc = 495; // 270° of a circle with r 105
  const btn = `${small ? "w-10 h-10 rounded-xl text-xl" : "w-14 h-14 rounded-2xl text-2xl"} bg-white/5 border border-white/10 text-white font-bold active:scale-95 disabled:opacity-30 transition-transform`;
  return (
    <div className="flex items-center justify-between gap-2">
      <button onClick={() => onNudge(-1)} disabled={value <= lo} aria-label="Lower temperature" className={btn}>−</button>
      <span className={`relative ${small ? "w-32 h-32" : "w-48 h-48"}`}>
        <svg viewBox="0 0 250 250" className="w-full h-full">
          <defs><linearGradient id="dial-heat" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stopColor="#f59e0b" /><stop offset="100%" stopColor="#f43f5e" /></linearGradient></defs>
          <circle cx="125" cy="125" r="105" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="14" strokeDasharray={`${arc} 660`} strokeLinecap="round" transform="rotate(135 125 125)" />
          <circle cx="125" cy="125" r="105" fill="none" stroke={off ? "#475569" : "url(#dial-heat)"} strokeWidth="14" strokeDasharray={`${Math.max(8, arc * frac)} 660`} strokeLinecap="round" transform="rotate(135 125 125)"
            style={{ filter: off ? undefined : "drop-shadow(0 0 8px rgba(244,63,94,0.45))", transition: "stroke-dasharray 0.4s" }} />
          {Array.from({ length: 7 }, (_, i) => {
            const ang = ((135 + (270 * i) / 6) * Math.PI) / 180;
            return <line key={i} x1={125 + 88 * Math.cos(ang)} y1={125 + 88 * Math.sin(ang)} x2={125 + 80 * Math.cos(ang)} y2={125 + 80 * Math.sin(ang)} stroke="rgba(255,255,255,0.2)" strokeWidth="2" />;
          })}
        </svg>
        <span className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`${small ? "text-[8px]" : "text-[10px]"} font-mono text-slate-400 tracking-widest`}>SET TO</span>
          <span className={`${small ? "text-3xl" : "text-5xl"} font-bold font-mono tabular-nums ${off ? "text-slate-500" : "text-white"}`}>{toUnit(value, unit)}°</span>
          <span className={`${small ? "text-[9px]" : "text-[11px]"} font-mono tracking-wider ${off ? "text-slate-500" : "text-amber-400"}`}>{(MODE_NAME[mode] ?? mode).toUpperCase()}</span>
        </span>
        {!small && <span className="absolute bottom-3 left-6 text-[10px] font-mono text-slate-500">{toUnit(lo, unit)}°</span>}
        {!small && <span className="absolute bottom-3 right-6 text-[10px] font-mono text-slate-500">{toUnit(hi, unit)}°</span>}
      </span>
      <button onClick={() => onNudge(1)} disabled={value >= hi} aria-label="Raise temperature" className={btn}>+</button>
    </div>
  );
}

/** The week as timelines, today highlighted, a line at the current time and each block's temperature. */
function WeekTimeline({ schedule }: { schedule: Schedule }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => { setNow(new Date()); const t = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(t); }, []);
  const tz = schedule.time_zone || "America/New_York";
  const parts = now ? new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now) : [];
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const today = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const nowMin = now ? (Number(get("hour")) % 24) * 60 + Number(get("minute")) : null;
  return (
    <div className="flex flex-col gap-1.5">
      {DAY_ROWS.map(({ d, s: label }) => {
        const isToday = d === today;
        return (
          <div key={d} className={`grid grid-cols-[44px_1fr] gap-2 items-center rounded-lg ${isToday ? "bg-amber-500/5" : ""}`}>
            <span className={`text-[11px] font-mono pl-1 ${isToday ? "text-amber-300 font-bold" : "text-slate-500"}`}>{label}</span>
            <div className={`relative h-6 rounded-md overflow-hidden ${isToday ? "bg-white/[0.07]" : "bg-white/[0.04]"}`}>
              {[6, 12, 18].map((h) => <span key={h} className="absolute inset-y-0 w-px bg-white/5" style={{ left: `${(h / 24) * 100}%` }} />)}
              {schedule.blocks.filter((b) => b.day === d).map((b, i) => {
                const a = toMin(b.start), z = toMin(b.stop) > a ? toMin(b.stop) : 1440;
                const wide = (z - a) / 1440 > 0.07;
                const offBlock = b.command.mode === "off";
                return (
                  <span key={i} title={`${b.start} to ${b.stop}${b.command.setpoint ? `, ${b.command.setpoint}°` : ""}`}
                    className={`absolute inset-y-0.5 rounded flex items-center justify-center text-[10px] font-mono font-bold overflow-hidden ${!schedule.enabled ? "bg-slate-600/60 text-slate-300"
                      : offBlock ? "bg-slate-500/40 text-slate-300" : "bg-gradient-to-r from-amber-500 to-orange-500 text-slate-950 shadow-[0_0_12px_rgba(245,158,11,0.35)]"}`}
                    style={{ left: `${(a / 1440) * 100}%`, width: `${((z - a) / 1440) * 100}%` }}>
                    {wide && (offBlock ? "OFF" : b.command.setpoint ? `${b.command.setpoint}°` : "")}
                  </span>
                );
              })}
              {isToday && nowMin != null && (
                <span className="absolute -inset-y-0 w-0.5 bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.9)]" style={{ left: `${(nowMin / 1440) * 100}%` }} />
              )}
            </div>
          </div>
        );
      })}
      <div className="grid grid-cols-[44px_1fr] gap-2"><span /><div className="flex justify-between text-[10px] font-mono text-slate-500"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>12a</span></div></div>
    </div>
  );
}

type TankPoint = { time: string; t?: string; tank: number; heating?: boolean; off?: boolean };

// Runs of consecutive points with a flag, as chart bands.
function bands(points: TankPoint[], key: "heating" | "off") {
  const out: { x1: string; x2: string }[] = [];
  let start: string | null = null;
  points.forEach((p, i) => {
    if (p[key] && start === null) start = p.time;
    if ((!p[key] || i === points.length - 1) && start !== null) { out.push({ x1: start, x2: p.time }); start = null; }
  });
  return out;
}

function TankChart({ points, legend }: { points: TankPoint[]; legend?: boolean }) {
  if (points.length < 3) return <NotConnected icon={Activity} title="Collecting history" text="The tank chart fills in as readings arrive every 5 minutes." />;
  const heat = bands(points, "heating"), off = bands(points, "off");
  const last = points[points.length - 1];
  return (
    <>
      <div className="relative flex-1 min-h-0">
        <Sized>{(w, h) => (
          <AreaChart width={w} height={h} data={points} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
            <defs>
              <linearGradient id="g-tank" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#fbbf24" stopOpacity={0.45} />
                <stop offset="60%" stopColor="#f97316" stopOpacity={0.12} />
                <stop offset="100%" stopColor="#f97316" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="g-tank-line" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#22d3ee" />
                <stop offset="100%" stopColor="#fbbf24" />
              </linearGradient>
              <filter id="tank-glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
            </defs>
            {off.map((b, i) => <ReferenceArea key={`o${i}`} x1={b.x1} x2={b.x2} fill="#64748b" fillOpacity={0.08} strokeOpacity={0} />)}
            {heat.map((b, i) => <ReferenceArea key={`h${i}`} x1={b.x1} x2={b.x2} fill="#f43f5e" fillOpacity={0.14} strokeOpacity={0} />)}
            <XAxis dataKey="time" stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} minTickGap={48} />
            <YAxis stroke="#64748b" fontSize={10} tickLine={false} axisLine={false} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} />
            <Tooltip {...TIP} formatter={(v, _n, p) => [`${v}%${(p.payload as TankPoint).heating ? " • heating" : (p.payload as TankPoint).off ? " • off" : ""}`, "Hot water"]} />
            <Area type="monotone" dataKey="tank" stroke="url(#g-tank-line)" fill="url(#g-tank)" strokeWidth={2.5} filter="url(#tank-glow)" isAnimationActive={false}
              dot={false} activeDot={{ r: 4, fill: "#fbbf24", stroke: "#110e0c", strokeWidth: 2 }} />
            <ReferenceDot x={last.time} y={last.tank} r={4} fill="#fbbf24" stroke="#110e0c" strokeWidth={2} />
          </AreaChart>
        )}</Sized>
      </div>
      {legend && (
        <div className="flex items-center gap-4 text-[10px] text-slate-400">
          <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded bg-gradient-to-r from-cyan-400 to-amber-400" />Hot water level</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-2.5 rounded-sm bg-rose-500/30" />Heating</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-2.5 rounded-sm bg-slate-500/25" />Off</span>
        </div>
      )}
    </>
  );
}

const DAY_ROWS = [{ d: 1, s: "MON" }, { d: 2, s: "TUE" }, { d: 3, s: "WED" }, { d: 4, s: "THU" }, { d: 5, s: "FRI" }, { d: 6, s: "SAT" }, { d: 0, s: "SUN" }];
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

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
  const [conedOpen, setConedOpen] = useState(false);
  const [energyOpen, setEnergyOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [editingSchedule, setEditingSchedule] = useState(false);
  const holdUntil = useRef(0); // ignore stale polls right after a command
  const [fit, setFit] = useState<{ z: number; h: number } | null>(null);

  // On iPad and larger, lay the dashboard out on a canvas 1180 wide (the iPad Air in landscape)
  // and scale it to the screen, so every iPad gets the same proportions instead of stretched panels.
  // Layout effect so the scale is in place before the first paint.
  useLayoutEffect(() => {
    const measure = () => {
      const w = document.documentElement.clientWidth;
      if (w >= 1024) setFit({ z: w / DESIGN_WIDTH, h: 0 }); else setFit(null);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => { window.removeEventListener("resize", measure); window.removeEventListener("orientationchange", measure); };
  }, []);
  useEffect(() => {
    document.documentElement.style.overflow = fit ? "hidden" : "";
    document.body.style.overflow = fit ? "hidden" : "";
  }, [fit]);

  // Sample screens can open on a section with ?s=water; the unit choice is remembered per device.
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get("s");
    if (s) setSection(s === "camera" ? "security" : s); // the Camera tab became Security
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
  const setpoint = useSetpoint(heater, send);
  const lights = useMemo(() => data.devices.filter((d): d is Light => d.kind === "light"), [data.devices]);
  const tv = data.devices.find((d): d is TV => d.kind === "tv");
  const cams = data.devices.filter((d): d is Camera => d.kind === "camera");
  const meter = data.devices.find((d): d is Meter => d.kind === "meter");
  const disconnectConed = async () => {
    try {
      const r = await fetch("/api/coned", { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      setData((d) => ({ ...d, devices: d.devices.filter((x) => x.kind !== "meter") }));
      setToast("Con Edison disconnected.");
    } catch (e) {
      setToast(`Couldn't disconnect Con Edison: ${(e as Error).message}`);
    }
  };
  const [camId, setCamId] = useState<string | null>(null);
  const cam = cams.find((c) => c.id === camId) ?? cams[0];
  const { seen: tvSeen, on: tvOn } = tvStatus(tv);
  const lightsIn = useCallback((roomId: string) => lights.filter((l) => roomIdOf(l) === roomId).sort((a, b) => a.name.localeCompare(b.name)), [lights]);
  const roomName = (id: string) => ROOMS.find((r) => r.id === id)?.name ?? "Other";
  // The kitchen's left, middle and right bulbs work as one circuit.
  const CIRCUIT = "kitchen-circuit";
  const circuit = useMemo(() => lights.filter((l) => roomIdOf(l) === "kitchen" && ["left", "middle", "right"].includes(shortName(l.name, "Kitchen").toLowerCase()))
    .sort((a, b) => ["left", "middle", "right"].indexOf(shortName(a.name, "Kitchen").toLowerCase()) - ["left", "middle", "right"].indexOf(shortName(b.name, "Kitchen").toLowerCase())), [lights]);
  const circuitLead = circuit.find((l) => l.state?.power && l.state?.online !== false) ?? circuit.find((l) => l.state?.online !== false) ?? circuit[0];
  const sendCircuit: Send = (_d, c, patch) => { circuit.filter((l) => l.state?.online !== false).forEach((l) => send(l, c, patch)); };
  // Light buttons: a single bulb, or the kitchen ceiling circuit as one button.
  const powerAll = (ls: Light[], on: boolean) => ls.filter((l) => l.state?.online !== false && !!l.state?.power !== on).forEach((l) => send(l, { action: "power", on }, { power: on }));
  const brightAll = (ls: Light[], v: number) => ls.filter((l) => l.state?.online !== false).forEach((l) => send(l, { action: "brightness", value: v }, { brightness: v, power: true }));
  const unitsIn = (roomId: string) => {
    const list = lightsIn(roomId);
    const grouped = roomId === "kitchen" && circuit.length > 0;
    return [
      ...(grouped ? [{ key: CIRCUIT, label: "Ceiling lights", lights: circuit }] : []),
      ...list.filter((l) => !grouped || !circuit.includes(l)).map((l) => ({ key: l.id, label: shortName(l.name, roomName(roomId)), lights: [l] })),
    ];
  };
  const tile = (u: { key: string; label: string; lights: Light[] }, big?: boolean) => (
    <LightTile key={u.key} lights={u.lights} label={u.label} big={big}
      onOpen={() => setLightId(u.key)} onPower={(on) => powerAll(u.lights, on)} onBright={(v) => brightAll(u.lights, v)} />
  );
  const setCircuit = (on: boolean) => circuit.filter((l) => l.state?.online !== false && !!l.state?.power !== on).forEach((l) => send(l, { action: "power", on }, { power: on }));
  const openLight = lights.find((l) => l.id === lightId) ?? null;
  const otherLights = lights.filter((l) => !ROOMS.some((r) => r.id === roomIdOf(l)));

  const setRoom = (roomId: string, on: boolean) =>
    lightsIn(roomId).filter((l) => l.state?.online !== false && !!l.state?.power !== on).forEach((l) => send(l, { action: "power", on }, { power: on }));

  // Modes. Each light gets a target; a light already there is left alone. The TV and the water
  // heater join in: Sleep and Away put the TV to sleep, Away shuts the heater off and pauses its
  // schedule, and any other mode resumes the schedule (which sets the heater for the current slot).
  type Target = { on: boolean; brightness?: number | "min"; scene?: string };
  const isTvLight = (l: Light) => /tv|backlight|65/i.test(l.name);
  const isFloorLamp = (l: Light) => /lamp/i.test(l.name);
  const sceneTarget = (name: string, l: Light): Target => {
    const room = roomIdOf(l);
    if (name === "Home") return { on: true };
    if (name === "Movie") {
      if (room === "living" && isTvLight(l)) return { on: true, scene: "Movie" };
      if (room === "living" && isFloorLamp(l)) return { on: true, brightness: "min" };
      return { on: false };
    }
    if (name === "Sleep") return room === "bedroom" ? { on: true, brightness: 20 } : { on: false };
    return { on: false }; // Away
  };

  const applyLight = async (l: Light, t: Target) => {
    const isOn = !!l.state?.power;
    if (!t.on) { if (isOn) await send(l, { action: "power", on: false }, { power: false }); return; }
    if (!isOn) await send(l, { action: "power", on: true }, { power: true });
    if (t.brightness !== undefined) {
      const value = t.brightness === "min" ? l.capabilities?.brightness?.min ?? 1 : t.brightness;
      if (l.state?.brightness !== value) await send(l, { action: "brightness", value }, { brightness: value, power: true });
    }
    if (t.scene) await send(l, { action: "scene", name: t.scene }, { power: true });
  };

  const setHeaterSchedule = async (enabled: boolean) => {
    if (!heater) return;
    const r = await fetch("/api/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: heater.id, enabled }) });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error);
    setSchedule(body);
  };

  const applyScene = async (name: string) => {
    setScene(name);
    const jobs: Promise<unknown>[] = lights.filter((l) => l.state?.online !== false).map((l) => applyLight(l, sceneTarget(name, l)));
    if ((name === "Sleep" || name === "Away") && tv && tvOn) jobs.push(Promise.resolve(send(tv, { action: "sleep" }, { screen: "off" })));
    if (heater) {
      jobs.push((async () => {
        try {
          if (name === "Away") {
            if (schedule?.enabled !== false) await setHeaterSchedule(false);
            if (heater.state?.power !== false) await send(heater, { action: "power", on: false }, { power: false, mode: "off" });
          } else if (schedule && !schedule.enabled) {
            await setHeaterSchedule(true);
            setTimeout(refresh, 6000);
          }
        } catch (e) {
          setToast(`Water heater: ${(e as Error).message}`);
        }
      })());
    }
    await Promise.all(jobs);
    setTimeout(() => setScene(null), 2000);
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
    return pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((x) => ({
      time: clockTime(x.t), t: x.t, tank: x.state.tank_pct as number,
      heating: !!x.state.running, off: x.state.mode === "off" || x.state.power === false,
    }));
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
    cams.forEach((c) => {
      if (c.state?.online === false) out.push({ id: `${c.id}-off`, level: "warn", icon: WifiOff, text: `${c.name} camera offline` });
      else if (c.state?.on_battery && c.state.battery != null && c.state.battery < 20) out.push({ id: `${c.id}-batt`, level: "info", icon: AlertTriangle, text: `${c.name} camera battery ${c.state.battery}%` });
    });
    const hs = heater?.state;
    if (heater && hs && !hs.connected) out.push({ id: "heater-off", level: "warn", icon: WifiOff, text: "Water heater offline" });
    if (hs?.alert_count) out.push({ id: "heater-alert", level: "warn", icon: AlertTriangle, text: `Water heater has ${hs.alert_count} alert${hs.alert_count > 1 ? "s" : ""} in the Rheem app` });
    if (hs && hs.power !== false && typeof hs.tank_pct === "number" && hs.tank_pct < 25) out.push({ id: "tank-low", level: "info", icon: Droplets, text: `Hot water low, ${hs.tank_pct}%` });
    if (meter?.recorded_at && Date.now() - Date.parse(meter.recorded_at) > 6 * 3600_000) out.push({ id: "coned-stale", level: "info", icon: Zap, text: "Con Edison data hasn't updated", since: ago(meter.recorded_at) });
    return out;
  }, [error, lights, heater, meter, data.history]); // eslint-disable-line react-hooks/exhaustive-deps

  const lightsOn = lights.filter((l) => l.state?.power && l.state?.online !== false).length;
  const onIn = (room: string) => lightsIn(room).filter((l) => l.state?.power && l.state?.online !== false).length;
  const lastUpdate = data.devices.map((d) => d.recorded_at).filter(Boolean).sort().at(-1) ?? null;

  const tabs: { id: string; label: string; icon: LucideIcon; meta?: string }[] = [
    { id: "overview", label: "Overview", icon: LayoutGrid },
    { id: "living", label: "Living", icon: Sofa, meta: `${onIn("living")} on` },
    { id: "kitchen", label: "Kitchen", icon: CookingPot, meta: `${onIn("kitchen")} on` },
    { id: "bedroom", label: "Bedroom", icon: BedDouble, meta: `${onIn("bedroom")} on` },
    { id: "water", label: "Water", icon: Flame, meta: heater?.state?.tank_pct != null ? `${heater.state.tank_pct}%` : undefined },
    { id: "security", label: "Security", icon: ShieldCheck, meta: cam?.state?.mode ? MODE_LABEL[cam.state.mode] : undefined },
    { id: "history", label: "History", icon: ChartColumn },
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
          {unitsIn(roomId).map((u) => tile(u, big))}
        </div>
        {list.length === 0 && <p className="text-[11px] text-slate-500">No lights in this room yet.</p>}
      </div>
    );
  };

  // ---------- views ----------

  const overview = (
    <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0 z-10">
      <div className="lg:col-span-4 flex flex-col gap-3 min-h-0">
        <div className={`${PANEL} p-3.5 flex flex-col gap-2.5 shrink-0`}>
          <PanelHead icon={Thermometer} tone={CYAN} title="Climate Controls" sub="Dual LG zones" right={unitToggle} />
          <Preview corner="br" className="flex flex-col">
            <SampleAcRow name="Living" room={74} set={72} mode="Cool" />
            <SampleAcRow name="Bedroom" room={71} set={68} mode="Cool" />
          </Preview>
        </div>
        <div className={`flex-1 min-h-[220px] ${PANEL} p-3.5 flex flex-col gap-3`}>
          {heater ? (
            <>
              <PanelHead icon={Flame} tone={AMBER} title="Water Heater"
                sub={`Rheem heat pump • schedule ${schedule?.enabled ? "on" : "off"}`}
                right={<button onClick={() => setSection("water")} className="px-3 h-9 rounded-xl text-[11px] font-medium bg-white/5 border border-white/10 text-slate-300 flex items-center gap-1">Details<ChevronRight className="w-3.5 h-3.5" /></button>} />
              {(() => {
                const hs = heater.state;
                const off = hs?.power === false || hs?.mode === "off";
                return (
                  <div className="flex items-stretch gap-3 shrink-0">
                    <div className="relative w-[64px] h-[150px] shrink-0"><GlassTank small pct={hs?.tank_pct ?? null} heating={!!hs?.running && !off} off={off} /></div>
                    <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-1.5">
                      <HeaterStatus heater={heater} />
                      <SetpointDial small value={setpoint.value} lo={setpoint.lo} hi={setpoint.hi} unit={unit} off={off} mode={off ? "off" : hs?.mode ?? ""} onNudge={setpoint.nudge} />
                    </div>
                  </div>
                );
              })()}
              <div className="relative flex-1 min-h-[70px] flex flex-col">
                <span className="text-[10px] font-mono tracking-widest text-slate-500 mb-1">HOT WATER • LAST 24 H</span>
                <div className="relative flex-1 min-h-0 flex flex-col"><TankChart points={tankPoints} /></div>
              </div>
            </>
          ) : <NotConnected icon={Flame} title="No water heater" text="It shows up here once the Rheem function reports it." />}
        </div>
      </div>

      <div className="lg:col-span-4 flex flex-col gap-3 min-h-0">
        <div className={`flex-1 min-h-[300px] ${PANEL} p-3.5 flex flex-col gap-2.5`}>
          <PanelHead icon={ShieldCheck} tone={AMBER} title="Security" sub="Camera and front door"
            right={cam ? <ModeChip cam={cam} onClick={() => setSection("security")} />
              : <button onClick={() => setSection("security")} className="px-3 h-9 rounded-xl text-[11px] font-semibold bg-amber-500/15 border border-amber-500/30 text-amber-300">Connect</button>} />
          {cam ? <RingFeed key={cam.id} cam={cam} /> : <Preview className="flex-1 min-h-0" corner="tr"><CamStandIn /></Preview>}
          {/* The lock row is its own positioned box so its "not connected" tag sits on the row, not on the camera. */}
          <div className="relative mt-1 pt-3 border-t border-white/10">
            <Preview corner="tr" label="LOCK • NOT CONNECTED"><LockSample /></Preview>
          </div>
        </div>
        <div className={`${PANEL} p-3.5 flex flex-col gap-2.5 shrink-0`}>
          <PanelHead icon={Tv} tone={CYAN} title="Living Room TV"
            sub={!tvSeen ? "Fire TV" : tvOn ? `Fire TV • ${tv?.state?.app_name ?? "On"}` : "Fire TV • asleep or off"}
            right={tvOn && tv?.state?.volume != null ? (
              <span className="flex items-center gap-1.5 px-2.5 h-8 rounded-lg bg-black/40 border border-white/10 text-[11px] font-mono text-cyan-300">
                {!tv.state.muted && <Equalizer />}
                {tv.state.muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}{tv.state.muted ? "MUTED" : `VOL ${tv.state.volume}`}
              </span>
            ) : undefined} />
          {tv && tvSeen ? <TvPanel tv={tv} send={send} /> : <Preview corner="br"><TvSample /></Preview>}
        </div>
      </div>

      <div className="lg:col-span-4 flex flex-col gap-3 min-h-0">
        <div className={`flex-1 min-h-0 ${PANEL} p-3.5 flex flex-col gap-2.5`}>
          <PanelHead icon={Palette} tone={AMBER} title="Lighting Console" sub={`${lightsOn} on • tap a room for its lights`}
            right={<span className="text-[10px] font-mono text-slate-500">Govee Cloud</span>} />
          <div className="flex-1 min-h-0 flex flex-col rounded-2xl border border-white/5 bg-black/25 divide-y divide-white/5 overflow-hidden">
            {ROOMS.map((r) => <RoomRow key={r.id} room={r} lights={lightsIn(r.id)} onOpen={() => setSection(r.id)} onAll={(on) => setRoom(r.id, on)} />)}
          </div>
          {otherLights.length > 0 && <div className="grid grid-cols-2 gap-2">{otherLights.map((l) => tile({ key: l.id, label: l.name, lights: [l] }))}</div>}
        </div>
        <EnergyTile meter={meter} onOpen={() => setEnergyOpen(true)} onConnect={() => setConedOpen(true)} />
      </div>
    </main>
  );

  // Appliances and tech in a room (not lights or the AC): the TV and the camera so far.
  const techIn = (room: string) => data.devices.filter((d) => (d.kind === "tv" || d.kind === "camera") && (d.room ?? "").toLowerCase().startsWith(room === "living" ? "living" : room));

  const techBox = (room: "living" | "bedroom") => {
    const items = techIn(room);
    const roomTv = items.find((d): d is TV => d.kind === "tv");
    const roomCam = items.find((d): d is Camera => d.kind === "camera");
    return (
      <div className={`flex-1 min-h-[150px] ${PANEL} p-4 flex flex-col gap-3 overflow-hidden`}>
        <PanelHead icon={Plug} tone={CYAN} title="Appliances & Tech" sub={items.length ? `${items.length} in the ${room === "living" ? "living room" : "bedroom"}` : "Nothing here yet"}
          right={roomCam ? (
            <button onClick={() => setSection("security")} aria-label={`Open the ${roomCam.name} camera`}
              className="flex items-center gap-1.5 px-3 h-9 rounded-xl text-[11px] font-medium border bg-amber-500/10 border-amber-500/25 text-amber-300 active:scale-95">
              <Video className="w-3.5 h-3.5" />Camera
              <span className={`w-1.5 h-1.5 rounded-full ${roomCam.state?.online === false ? "bg-rose-400" : "bg-emerald-400"}`} />
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          ) : undefined} />
        {roomTv && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-semibold text-slate-200 flex items-center gap-1.5"><Tv className="w-3.5 h-3.5 text-cyan-400" />{roomTv.name}</span>
              <span className="text-[11px] text-slate-400">{tvOn ? roomTv.state?.app_name ?? "On" : tvSeen ? "Asleep or off" : ""}{tvOn && roomTv.state?.volume != null ? ` • Vol ${roomTv.state.volume}` : ""}</span>
            </div>
            {tvSeen ? <TvPanel tv={roomTv} send={send} compact /> : <Preview><TvSample /></Preview>}
          </div>
        )}
        {roomCam && !roomTv && (
          <p className="text-[12px] text-slate-400">{roomCam.name} camera: {roomCam.state?.online === false ? "offline" : "online"}. Tap Camera to watch.</p>
        )}
        {!items.length && (
          <p className="text-[12px] text-slate-500 leading-relaxed">No appliances or tech assigned to the {room === "living" ? "living room" : "bedroom"} yet. Devices you add to this room will show up here.</p>
        )}
      </div>
    );
  };

  const zoneView = (room: "living" | "bedroom") => (
    <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0 z-10">
      <div className={`${PANEL} lg:col-span-7 p-5 flex flex-col gap-4 min-h-0`}>
        <PanelHead icon={Wind} tone={CYAN} title={`${room === "living" ? "Living Room" : "Bedroom"} AC`} sub="LG ducted unit"
          right={<div className="flex items-center gap-2">{unitToggle}<PowerBtn on={false} disabled label="AC power" /></div>} />
        <Preview className="flex-1 min-h-0"><AcZoneSample /></Preview>
      </div>
      <div className="lg:col-span-5 flex flex-col gap-3 min-h-0">
        <div className={`${PANEL} p-4 space-y-3`}>
          <PanelHead icon={Palette} tone={AMBER} title="Lights" sub="Tap a light's name for colors" />
          {room === "living" ? <>{roomLights("living", 2)}{roomLights("kitchen", 2)}</> : roomLights("bedroom", 2)}
        </div>
        {techBox(room)}
      </div>
    </main>
  );

  const kitchenView = (
    <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0 z-10">
      <div className={`lg:col-span-8 ${PANEL} p-5 flex flex-col gap-4`}>
        <PanelHead icon={Palette} tone={AMBER} title="Kitchen Lights" sub={`${onIn("kitchen")} on • tap a light's name for colors`}
          right={<button onClick={() => setRoom("kitchen", !lightsIn("kitchen").some((l) => l.state?.power && l.state?.online !== false))}
            className="px-3 h-10 rounded-xl text-xs text-slate-200 bg-white/5 border border-white/10 font-medium flex items-center gap-1.5"><Power className="w-3.5 h-3.5" />{onIn("kitchen") ? "All off" : "All on"}</button>} />
        <div className="grid grid-cols-2 gap-3">
          {unitsIn("kitchen").map((u) => tile(u, true))}
        </div>
      </div>
      <div className="lg:col-span-4 flex flex-col gap-3">
        <div className={`${PANEL} p-4 flex flex-col gap-3`}>
          <PanelHead icon={Wind} tone={CYAN} title="Shared AC" sub="Kitchen and living room are one zone" />
          <Preview corner="br">
            <div className="flex items-center justify-between bg-black/40 p-3 rounded-xl border border-white/5">
              <span className="text-[11px] text-slate-400">Room 74°</span>
              <span className="text-3xl font-bold font-mono">72°</span>
              <span className="text-[11px] font-mono text-cyan-400">COOL</span>
            </div>
          </Preview>
          <button onClick={() => setSection("living")} className="py-3 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-sm font-semibold">Open living room</button>
        </div>
      </div>
    </main>
  );

  // Today's heater numbers for the Water tab, from the last 24 hours of readings.
  const heaterDay = useMemo(() => {
    const h = heater ? data.history?.[heater.id] ?? [] : [];
    let heating = 0;
    for (let i = 0; i < h.length; i++) {
      if (!h[i].state?.running) continue;
      const next = h[i + 1] ? Date.parse(h[i + 1].t) : Date.now();
      heating += Math.min(next - Date.parse(h[i].t), 15 * 60_000);
    }
    const tanks = h.map((x) => x.state?.tank_pct).filter((x): x is number => typeof x === "number");
    return { heatingH: heating / 3600_000, low: tanks.length ? Math.min(...tanks) : null, readings: h.length };
  }, [data.history, heater]);
  const waterView = (
    <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0 z-10">
      <div className={`lg:col-span-5 ${PANEL} p-5 flex flex-col gap-4 overflow-hidden`}>
        {heater ? (() => {
          const hs = heater.state;
          const off = hs?.power === false || hs?.mode === "off";
          const heating = !!hs?.running && !off;
          const modes = heater.capabilities.modes.filter((m) => m !== "off");
          const onMode = modes.includes("energy_saver") ? "energy_saver" : modes[0] ?? "energy_saver";
          const next = schedule?.enabled ? (schedule.active ? `${schedule.active.command.mode === "off" ? "Off" : `${schedule.active.command.setpoint ?? ""}°`} until ${schedule.active.stop}` : schedule.next ? `${schedule.next.command.mode === "off" ? "Off" : "On"} at ${schedule.next.start}` : "No changes") : "Schedule off";
          return (
            <>
              <PanelHead icon={Flame} tone={AMBER} title="Water Heater" sub={`Rheem heat pump • ${hs?.connected === false ? "offline" : off ? "off" : MODE_NAME[hs?.mode ?? ""] ?? "on"}`} right={unitToggle} />
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`flex items-center gap-1.5 px-2.5 h-7 rounded-lg border text-[11px] font-medium ${heating ? "bg-rose-500/10 border-rose-500/30 text-rose-200" : off ? "bg-white/5 border-white/10 text-slate-400" : "bg-emerald-500/10 border-emerald-500/25 text-emerald-300"}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${heating ? "bg-rose-400 heat-pulse" : off ? "bg-slate-500" : "bg-emerald-400"}`} />
                  {heating ? hs?.running : off ? "Off" : "Ready • not heating"}
                </span>
                {hs?.connected === false && <span className="px-2.5 h-7 flex items-center rounded-lg bg-rose-500/10 border border-rose-500/30 text-[11px] text-rose-300">Offline</span>}
                {!!hs?.alert_count && <span className="px-2.5 h-7 flex items-center gap-1 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-300"><AlertTriangle className="w-3 h-3" />{hs.alert_count} alert{hs.alert_count > 1 ? "s" : ""}</span>}
                {(hs?.away || hs?.vacation) && <span className="px-2.5 h-7 flex items-center rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-[11px] text-cyan-300">{hs.vacation ? "Vacation" : "Away"}</span>}
              </div>
              <div className="flex-1 min-h-0 grid grid-cols-[150px_1fr] gap-4 items-stretch">
                <div className="min-h-0 relative py-1"><GlassTank pct={hs?.tank_pct ?? null} heating={heating} off={off} /></div>
                <div className="min-w-0 flex flex-col justify-center gap-3">
                  <SetpointDial value={setpoint.value} lo={setpoint.lo} hi={setpoint.hi} unit={unit} off={off} mode={off ? "off" : hs?.mode ?? ""} onNudge={setpoint.nudge} />
                  <div className="grid grid-cols-2 gap-1.5">
                    {modes.map((m) => {
                      const on = !off && hs?.mode === m;
                      return (
                        <button key={m} aria-pressed={on} onClick={() => !on && send(heater, { action: "set_mode", mode: m }, { mode: m, power: true })}
                          className={`h-10 rounded-xl text-[11px] font-semibold border transition-all active:scale-95 ${on ? "bg-amber-500 text-slate-950 border-amber-400 shadow-md shadow-amber-500/20" : "bg-white/5 border-white/10 text-slate-300"} ${modes.length % 2 && m === modes[modes.length - 1] ? "col-span-2" : ""}`}>
                          {MODE_NAME[m] ?? m}
                        </button>
                      );
                    })}
                  </div>
                  {heater.capabilities.supports_power && (
                    <button onClick={() => off
                      ? send(heater, { action: "set_mode", mode: onMode }, { power: true, mode: onMode })
                      : send(heater, { action: "power", on: false }, { power: false, mode: "off" })}
                      className={`h-11 rounded-xl border text-[13px] font-semibold flex items-center justify-center gap-2 active:scale-[0.99] ${off ? "bg-amber-500 text-slate-950 border-amber-400" : "bg-white/5 text-slate-200 border-white/10"}`}>
                      <Power className="w-4 h-4" />{off ? "Turn on" : "Turn off"}
                    </button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 shrink-0">
                <MiniStat label="HEATED • 24 H" value={heaterDay.readings ? hoursText(heaterDay.heatingH) : "--"} sub="Compressor and element" tone="text-rose-300" />
                <MiniStat label="LOWEST • 24 H" value={heaterDay.low != null ? `${heaterDay.low}%` : "--"} sub="Hot water left" tone="text-cyan-300" />
                <MiniStat label="SCHEDULE" value={schedule?.enabled ? "On" : "Off"} sub={next} tone={schedule?.enabled ? "text-amber-300" : "text-slate-400"} />
              </div>
            </>
          );
        })() : <NotConnected icon={Flame} title="No water heater" text="It shows up here once the Rheem function reports it." />}
      </div>
      <div className="lg:col-span-7 flex flex-col gap-3 min-h-0">
        <div className={`${PANEL} p-4 space-y-3 shrink-0`}>
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
          {schedule && <WeekTimeline schedule={schedule} />}
        </div>
        <div className={`flex-1 min-h-[180px] ${PANEL} p-4 flex flex-col gap-2`}>
          <PanelHead icon={Activity} tone={GREEN} title="Hot Water in Tank" sub="Last 24 hours, with when it was heating" />
          <div className="relative flex-1 min-h-[160px] flex flex-col gap-2"><TankChart points={tankPoints} legend /></div>
        </div>
      </div>
    </main>
  );

  const disconnectRing = async () => {
    if (!window.confirm("Disconnect Ring from the dashboard? You can connect it again any time.")) return;
    try {
      const r = await fetch("/api/ring/login", { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).error);
      setToast("Ring disconnected.");
      await load();
    } catch (e) {
      setToast(`Couldn't disconnect Ring: ${(e as Error).message}`);
    }
  };

  const securityView = !cam ? (
    <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0 z-10">
      <div className={`lg:col-span-8 ${PANEL} p-4 flex flex-col gap-3 min-h-[320px]`}>
        <PanelHead icon={Video} tone={AMBER} title="Living Room Camera" sub="Ring" />
        <div className="flex-1 flex items-center justify-center py-6">
          <RingConnect onConnected={() => { setToast("Ring connected."); refresh(); load(); }} />
        </div>
      </div>
      <div className="lg:col-span-4 flex flex-col gap-3 min-h-0">
        <div className={`${PANEL} p-4 flex flex-col gap-3 shrink-0`}>
          <PanelHead icon={DoorClosed} tone={GREEN} title="Front Door Lock" sub="Smart lock" />
          <Preview corner="tr"><LockPanelSample /></Preview>
        </div>
        <div className={`${PANEL} p-4 space-y-3`}>
          <PanelHead icon={ShieldCheck} tone={GREEN} title="Ring Mode" sub="Same modes as the Ring app" />
          <Preview corner="br">
            <span className="grid grid-cols-3 gap-1 p-1 bg-black/50 rounded-xl border border-white/5">
              {["Disarmed", "Home", "Away"].map((m) => <span key={m} className={`py-3 rounded-lg text-xs font-semibold text-center ${m === "Home" ? "bg-emerald-500 text-slate-950" : "text-slate-400"}`}>{m}</span>)}
            </span>
          </Preview>
        </div>
        <div className={`flex-1 min-h-[160px] ${PANEL} p-4 flex flex-col gap-2`}>
          <PanelHead icon={ShieldAlert} tone={AMBER} title="Recent Events" sub="Motion and doorbell" />
          <Preview className="flex-1 min-h-0" corner="tr">
            {[["Person detected", "10:02 PM", true], ["Motion", "08:15 PM", true], ["Motion", "01:22 PM", true]].map(([t, time]) => (
              <span key={`${t}${time}`} className="flex items-center gap-2.5 bg-black/30 p-2 rounded-xl border border-white/5">
                <span className="w-10 h-8 rounded-lg border border-white/10 flex items-center justify-center bg-[#2a211a]"><Footprints className="w-3.5 h-3.5 text-amber-400" /></span>
                <span className="flex-1 text-[12px] text-slate-200 truncate">{t as string}</span>
                <span className="text-[10px] font-mono text-slate-500">{time as string}</span>
              </span>
            ))}
          </Preview>
        </div>
      </div>
    </main>
  ) : (
    <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-0 z-10">
      <div className={`lg:col-span-8 ${PANEL} p-4 flex flex-col gap-3 min-h-[320px]`}>
        <PanelHead icon={Video} tone={AMBER} title={`${cam.name} Camera`}
          sub={`Ring • ${cam.state?.online === false ? "offline" : "tap Live for real time video"}`}
          right={cams.length > 1 ? (
            <div className="flex gap-1">{cams.map((c) => (
              <button key={c.id} onClick={() => setCamId(c.id)} className={`px-3 h-9 rounded-xl text-[11px] font-medium border ${c.id === cam.id ? "bg-white/10 border-amber-500/40 text-white" : "bg-white/5 border-white/10 text-slate-400"}`}>{c.name}</button>
            ))}</div>
          ) : undefined} />
        <RingFeed key={cam.id} cam={cam} big />
      </div>
      <div className="lg:col-span-4 flex flex-col gap-3 min-h-0">
        <div className={`${PANEL} p-4 flex flex-col gap-3 shrink-0`}>
          <PanelHead icon={DoorClosed} tone={GREEN} title="Front Door Lock" sub="Smart lock" />
          <Preview corner="tr"><LockPanelSample /></Preview>
        </div>
        <div className={`${PANEL} p-4 space-y-3`}>
          <PanelHead icon={ShieldCheck} tone={GREEN} title="Ring Mode" sub={cam.state?.mode && MODE_LABEL[cam.state.mode] ? "Same modes as the Ring app" : "Turn on Modes in the Ring app to use these"} />
          <div className={`grid grid-cols-3 gap-1 p-1 bg-black/50 rounded-xl border border-white/5 ${cam.state?.mode && MODE_LABEL[cam.state.mode] ? "" : "opacity-40 pointer-events-none"}`}>
            {(["disarmed", "home", "away"] as const).map((m) => {
              const on = cam.state?.mode === m;
              const Icon = m === "disarmed" ? ShieldAlert : m === "home" ? HomeIcon : ShieldCheck;
              return (
                <button key={m} aria-pressed={on} onClick={() => !on && send(cam, { action: "set_mode", mode: m }, { mode: m })}
                  className={`py-3 rounded-lg text-xs font-semibold flex flex-col items-center gap-1 transition-colors ${on ? (m === "disarmed" ? "bg-rose-500 text-slate-950" : "bg-emerald-500 text-slate-950") : "text-slate-400"}`}>
                  <Icon className="w-4 h-4" />{MODE_LABEL[m]}
                </button>
              );
            })}
          </div>
        </div>
        <div className={`flex-1 min-h-[160px] ${PANEL} p-4 flex flex-col gap-2`}>
          <PanelHead icon={BellRing} tone={AMBER} title="Recent Events" sub="Motion and doorbell, from Ring"
            right={<button onClick={disconnectRing} aria-label="Disconnect Ring" className="w-9 h-9 flex items-center justify-center rounded-xl bg-white/5 border border-white/10 text-slate-500"><LogOut className="w-3.5 h-3.5" /></button>} />
          <div className="space-y-1.5 overflow-hidden">
            {(cam.state?.events ?? []).filter((e) => e.t).slice(0, 6).map((e, i) => (
              <div key={`${e.t}${i}`} className="flex items-center gap-2.5 bg-black/30 p-2 rounded-xl border border-white/5">
                <span className={`w-10 h-8 rounded-lg border border-white/10 flex items-center justify-center ${e.person ? "bg-amber-500/10" : "bg-[#2a211a]"}`}>
                  {e.kind === "ding" ? <BellRing className="w-3.5 h-3.5 text-amber-400" /> : e.person ? <UserRound className="w-3.5 h-3.5 text-amber-300" /> : e.kind === "on_demand" ? <Video className="w-3.5 h-3.5 text-cyan-400" /> : <Footprints className="w-3.5 h-3.5 text-amber-400" />}
                </span>
                <span className="flex-1 text-[12px] text-slate-200 truncate">{eventLabel(e)}</span>
                <span className="text-[10px] font-mono text-slate-500">{clockTime(e.t!)}</span>
              </div>
            ))}
            {!(cam.state?.events ?? []).some((e) => e.t) && <p className="text-[12px] text-slate-500 px-1">No recent events.</p>}
          </div>
        </div>
      </div>
    </main>
  );

  const activity = data.activity ?? [];

  return (
    <div className={`${fit ? "fixed top-0 left-0 overflow-hidden" : "min-h-[100dvh] w-full relative"} bg-[#110e0c] text-slate-100 font-sans select-none flex flex-col gap-3 antialiased`}
      style={{
        padding: "max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left))",
        ...(fit ? { width: DESIGN_WIDTH, height: `calc(100dvh / ${fit.z})`, transform: `scale(${fit.z})`, transformOrigin: "0 0" } : {}),
      }}>
      <div className="fixed top-0 left-1/3 w-[600px] h-[600px] bg-amber-600/10 rounded-full blur-[180px] pointer-events-none" />
      <div className="fixed bottom-0 right-1/4 w-[500px] h-[500px] bg-indigo-600/10 rounded-full blur-[180px] pointer-events-none" />

      <header className="min-h-14 bg-[#1a1512]/80 backdrop-blur-2xl border border-white/10 rounded-2xl px-4 py-2 flex flex-wrap items-center justify-between gap-3 shrink-0 shadow-2xl relative z-30">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/apple-icon.png" alt="" width={32} height={32} className="w-8 h-8 rounded-xl shadow-lg shadow-violet-500/25 ring-1 ring-white/10" />
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
              className={`h-9 flex items-center gap-2 pl-2.5 pr-2 rounded-xl border text-[11px] font-medium transition-all active:scale-95 ${alerts.some((a) => a.level === "warn") ? "bg-rose-500/10 border-rose-500/30 text-rose-300 alert-pulse" : "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"}`}>
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

      {/* Keyed by the scale so charts measure again after the iPad scaling changes (e.g. rotation). */}
      <Fragment key={fit ? fit.z.toFixed(3) : "free"}>
        {section === "overview" && overview}
        {section === "living" && zoneView("living")}
        {section === "bedroom" && zoneView("bedroom")}
        {section === "kitchen" && kitchenView}
        {section === "water" && waterView}
        {section === "security" && securityView}
        {section === "history" && <HistoryView meter={meter} onConnectConed={() => setConedOpen(true)} />}
      </Fragment>

      {energyOpen && meter && <EnergyDetail meter={meter} onClose={() => setEnergyOpen(false)} onDisconnect={() => { setEnergyOpen(false); disconnectConed(); }} />}
      {conedOpen && <ConEdConnect onClose={() => setConedOpen(false)} onConnected={() => { setConedOpen(false); setToast("Con Edison connected."); load(); }} />}
      {openLight && <LightSheet key={openLight.id} light={openLight} send={send} onClose={() => setLightId(null)} />}
      {lightId === CIRCUIT && circuitLead && (
        <LightSheet key={CIRCUIT} light={circuitLead} send={sendCircuit} onClose={() => setLightId(null)}
          title="Kitchen ceiling lights" sub="Color for left, middle and right together"
          footer={
            <div className="pt-3 border-t border-white/10 flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-400 font-medium">Each bulb</span>
              <div className="flex gap-1.5">
                {circuit.map((l) => {
                  const lit = !!l.state?.power && l.state?.online !== false;
                  return (
                    <button key={l.id} onClick={() => setLightId(l.id)} disabled={l.state?.online === false}
                      className="h-8 px-2.5 rounded-lg bg-white/5 border border-white/10 text-[11px] text-slate-200 flex items-center gap-1.5 active:scale-95 disabled:opacity-40">
                      <span className="w-2 h-2 rounded-full border border-white/30" style={{ backgroundColor: lit ? lightHex(l) : "transparent" }} />
                      {shortName(l.name, "Kitchen")}
                    </button>
                  );
                })}
              </div>
            </div>
          } />
      )}
      {editingSchedule && heater && schedule && (
        <ScheduleEditor heater={heater} schedule={schedule} notify={setToast}
          onClose={() => setEditingSchedule(false)} onSaved={(s) => { setSchedule(s); setEditingSchedule(false); setToast("Schedule saved."); }} />
      )}
      {toast && <div role="status" className="fixed left-1/2 -translate-x-1/2 bottom-6 z-50 max-w-[calc(100vw-32px)] px-4 py-3 rounded-2xl bg-[#1c1613] border border-white/15 text-[13px] text-slate-100 shadow-2xl">{toast}</div>}
    </div>
  );
}
