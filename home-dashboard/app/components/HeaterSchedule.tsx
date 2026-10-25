"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Heater, Schedule, ScheduleSlot } from "@/lib/types";

// Monday first, like the Rheem app. Values are JS weekdays (0 = Sunday).
const DAYS = [
  { d: 1, short: "Mon", long: "Monday" }, { d: 2, short: "Tue", long: "Tuesday" },
  { d: 3, short: "Wed", long: "Wednesday" }, { d: 4, short: "Thu", long: "Thursday" },
  { d: 5, short: "Fri", long: "Friday" }, { d: 6, short: "Sat", long: "Saturday" },
  { d: 0, short: "Sun", long: "Sunday" },
];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [6, 0];

const MODE_LABEL: Record<string, string> = {
  off: "Off", energy_saver: "Energy saver", heat_pump: "Heat pump", high_demand: "High demand",
  electric: "Electric", gas: "Gas", vacation: "Vacation", performance: "Performance",
};
const modeLabel = (m: string) => MODE_LABEL[m] ?? m.replace(/_/g, " ");

function to12h(t: string) {
  const [h, m] = t.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${suffix}`;
}

const byTime = (a: ScheduleSlot, b: ScheduleSlot) => a.at_time.localeCompare(b.at_time);
const describe = (s: ScheduleSlot) =>
  s.command.mode === "off" ? "Off" : `${modeLabel(s.command.mode)} at ${s.command.setpoint ?? ""}°`;

// The slot after the current one, wrapping around the week.
function nextSlot(slots: ScheduleSlot[], current: ScheduleSlot | null) {
  if (!slots.length) return null;
  const order = (s: ScheduleSlot) => ((s.day + 6) % 7) * 1440 + Number(s.at_time.slice(0, 2)) * 60 + Number(s.at_time.slice(3));
  const sorted = [...slots].sort((a, b) => order(a) - order(b));
  if (!current) return sorted[0];
  const i = sorted.findIndex((s) => s.day === current.day && s.at_time === current.at_time);
  return sorted[(i + 1) % sorted.length];
}

const dayName = (d: number) => DAYS.find((x) => x.d === d)?.long ?? "";

export default function HeaterSchedule({ heater, notify }: { heater: Heater; notify: (msg: string) => void }) {
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/schedule?device_id=${encodeURIComponent(heater.id)}`, { cache: "no-store" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setSchedule(body);
    } catch (e) {
      notify(`Couldn't load the schedule: ${(e as Error).message}`);
    }
  }, [heater.id, notify]);

  useEffect(() => { load(); }, [load]);

  const toggle = async () => {
    if (!schedule) return;
    setBusy(true);
    try {
      const r = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: heater.id, enabled: !schedule.enabled }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setSchedule(body);
    } catch (e) {
      notify(`Couldn't change the schedule: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!schedule) return <div className="sched"><p className="muted small">Loading schedule</p></div>;

  const next = nextSlot(schedule.slots, schedule.current);

  return (
    <div className="sched">
      <div className="sched-head">
        <h3 className="sched-title">Schedule</h3>
        <button role="switch" aria-checked={schedule.enabled} className={`switch ${schedule.enabled ? "is-on" : ""}`}
          onClick={toggle} disabled={busy || !schedule.slots.length} aria-label="Follow schedule">
          <span className="switch-knob" />
        </button>
      </div>

      {schedule.enabled ? (
        <>
          {schedule.current && (
            <p className="sched-line">Now: <b>{schedule.current.slot}</b>, {describe(schedule.current)}</p>
          )}
          {next && <p className="sched-line muted">Next: {next.slot} {dayName(next.day) !== dayName(schedule.current?.day ?? -1) ? `${dayName(next.day)} ` : ""}at {to12h(next.at_time)}, {describe(next)}</p>}
          <p className="muted small">Keep Follow Schedule off in the Rheem app so the two don't conflict.</p>
        </>
      ) : (
        <p className="sched-line muted">Off. The heater only changes when you change it.</p>
      )}

      <button className="btn btn-quiet btn-small sched-edit" onClick={() => setEditing(true)}>Edit schedule</button>

      {editing && (
        <ScheduleEditor heater={heater} schedule={schedule} notify={notify}
          onClose={() => setEditing(false)} onSaved={(s) => { setSchedule(s); setEditing(false); notify("Schedule saved."); }} />
      )}
    </div>
  );
}

// ---------- editor ----------

function ScheduleEditor({ heater, schedule, notify, onClose, onSaved }: {
  heater: Heater; schedule: Schedule; notify: (m: string) => void; onClose: () => void; onSaved: (s: Schedule) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const today = new Date().getDay();
  const [day, setDay] = useState(today);
  const [slots, setSlots] = useState<ScheduleSlot[]>(() =>
    schedule.slots.map((s) => ({ day: s.day, slot: s.slot, at_time: s.at_time, command: { ...s.command } })));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const modes = heater.capabilities.modes;
  const lo = heater.capabilities.setpoint_min_f ?? 110, hi = heater.capabilities.setpoint_max_f ?? 140;

  useEffect(() => { dialog.current?.showModal(); }, []);

  const daySlots = useMemo(() => slots.map((s, i) => ({ s, i })).filter(({ s }) => s.day === day).sort((a, b) => byTime(a.s, b.s)), [slots, day]);

  const update = (i: number, patch: Partial<ScheduleSlot> & { mode?: string; setpoint?: number }) => {
    setSlots((all) => all.map((s, j) => {
      if (j !== i) return s;
      const { mode, setpoint, ...rest } = patch;
      const command = { ...s.command, action: "set_state" };
      if (mode !== undefined) {
        command.mode = mode;
        if (mode !== "off" && command.setpoint == null) command.setpoint = Math.min(hi, Math.max(lo, 120));
      }
      if (setpoint !== undefined) command.setpoint = Math.min(hi, Math.max(lo, setpoint));
      return { ...s, ...rest, command };
    }));
    setDirty(true);
  };

  const copyTo = (targets: number[]) => {
    const source = slots.filter((s) => s.day === day);
    setSlots((all) => [
      ...all.filter((s) => s.day === day || !targets.includes(s.day)),
      ...targets.filter((t) => t !== day).flatMap((t) => source.map((s) => ({ ...s, day: t, command: { ...s.command } }))),
    ]);
    setDirty(true);
    notify(`Copied ${dayName(day)} to ${targets.length === 7 ? "every day" : targets === WEEKDAYS ? "weekdays" : "the weekend"}. Save to keep it.`);
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch("/api/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: heater.id, slots }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setDirty(false);
      onSaved(body);
    } catch (e) {
      notify(`Couldn't save the schedule: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (dirty && !window.confirm("Discard your schedule changes?")) return;
    dialog.current?.close();
  };

  return (
    <dialog ref={dialog} className="sheet sheet-wide" onClose={onClose} onCancel={(e) => { e.preventDefault(); close(); }}>
      <div className="sheet-inner">
        <div className="sheet-head">
          <h2 className="panel-title">Hot water schedule</h2>
          <button className="btn btn-quiet btn-small" onClick={close}>Cancel</button>
        </div>

        <div className="day-tabs" role="tablist" aria-label="Day">
          {DAYS.map(({ d, short, long }) => (
            <button key={d} role="tab" aria-selected={day === d} aria-label={long}
              className={`day-tab ${day === d ? "is-active" : ""} ${d === today ? "is-today" : ""}`} onClick={() => setDay(d)}>
              {short}
            </button>
          ))}
        </div>

        <ol className="slot-list">
          {daySlots.map(({ s, i }) => {
            const off = s.command.mode === "off";
            return (
              <li key={i} className={`slot-row ${off ? "is-off" : ""}`}>
                <span className="slot-name">{s.slot}</span>
                <label className="slot-field">
                  <span className="sr-only">{s.slot} start time</span>
                  <input type="time" value={s.at_time} step={900} className="slot-time"
                    onChange={(e) => e.target.value && update(i, { at_time: e.target.value })} />
                </label>
                <label className="slot-field">
                  <span className="sr-only">{s.slot} mode</span>
                  <select value={s.command.mode} className="slot-mode" onChange={(e) => update(i, { mode: e.target.value })}>
                    {modes.map((m) => <option key={m} value={m}>{modeLabel(m)}</option>)}
                  </select>
                </label>
                <div className="slot-temp" aria-label={`${s.slot} temperature`}>
                  <button className="step step-small" disabled={off || (s.command.setpoint ?? lo) <= lo}
                    onClick={() => update(i, { setpoint: (s.command.setpoint ?? lo) - 1 })} aria-label="Lower">−</button>
                  <span className="slot-temp-value">{off ? "–" : `${s.command.setpoint}°`}</span>
                  <button className="step step-small" disabled={off || (s.command.setpoint ?? lo) >= hi}
                    onClick={() => update(i, { setpoint: (s.command.setpoint ?? lo) + 1 })} aria-label="Raise">+</button>
                </div>
              </li>
            );
          })}
          {daySlots.length === 0 && <li className="muted">No slots on {dayName(day)}.</li>}
        </ol>

        <div className="copy-row">
          <span className="muted small">Copy {dayName(day)} to</span>
          <button className="chip" onClick={() => copyTo(WEEKDAYS)}>Weekdays</button>
          <button className="chip" onClick={() => copyTo(WEEKEND)}>Weekend</button>
          <button className="chip" onClick={() => copyTo([0, 1, 2, 3, 4, 5, 6])}>Every day</button>
        </div>

        <button className="btn btn-brass" onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving" : dirty ? "Save schedule" : "No changes"}
        </button>
      </div>
    </dialog>
  );
}
