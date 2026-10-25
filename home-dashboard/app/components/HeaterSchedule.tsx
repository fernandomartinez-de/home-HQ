"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Heater, Schedule, ScheduleBlock } from "@/lib/types";

// Monday first, like the Rheem app. Values are JS weekdays (0 = Sunday).
const DAYS = [
  { d: 1, short: "Mon", long: "Monday" }, { d: 2, short: "Tue", long: "Tuesday" },
  { d: 3, short: "Wed", long: "Wednesday" }, { d: 4, short: "Thu", long: "Thursday" },
  { d: 5, short: "Fri", long: "Friday" }, { d: 6, short: "Sat", long: "Saturday" },
  { d: 0, short: "Sun", long: "Sunday" },
];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [6, 0];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const MAX_BLOCKS = 4;

const dayName = (d: number) => DAYS.find((x) => x.d === d)?.long ?? "";

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m: number) => { const x = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`; };
const label = (start: string) => { const m = toMin(start); return m < 720 ? "Morning" : m < 1020 ? "Afternoon" : m < 1260 ? "Evening" : "Night"; };

function to12h(t: string) {
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

const describe = (b: ScheduleBlock) => `${b.command.setpoint}°`;

// Week math, in minutes from Sunday 00:00; a stop earlier than the start runs past midnight.
const WEEK = 10080;
const since = (a: number, b: number) => ((a - b) % WEEK + WEEK) % WEEK;
const startW = (b: ScheduleBlock) => b.day * 1440 + toMin(b.start);
const dur = (b: ScheduleBlock) => (toMin(b.stop) > toMin(b.start) ? toMin(b.stop) - toMin(b.start) : toMin(b.stop) + 1440 - toMin(b.start));
const overlaps = (a: ScheduleBlock, b: ScheduleBlock) => since(startW(b), startW(a)) < dur(a) || since(startW(a), startW(b)) < dur(b);

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

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000); // keep "now" and "next" current
    return () => clearInterval(t);
  }, [load]);

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
  const { active, next } = schedule;

  return (
    <div className="sched">
      <div className="sched-head">
        <h3 className="sched-title">Schedule</h3>
        <button role="switch" aria-checked={schedule.enabled} className={`switch ${schedule.enabled ? "is-on" : ""}`}
          onClick={toggle} disabled={busy || !schedule.blocks.length} aria-label="Follow schedule">
          <span className="switch-knob" />
        </button>
      </div>

      {schedule.enabled ? (
        <>
          {active
            ? <p className="sched-line">On now: <b>{active.slot}</b>, {describe(active)} until {to12h(active.stop)}</p>
            : <p className="sched-line">Off now.</p>}
          {next && (
            <p className="sched-line muted">
              Next: {next.slot}, {next.day !== new Date().getDay() ? `${dayName(next.day)} ` : ""}{to12h(next.start)} to {to12h(next.stop)}, {describe(next)}
            </p>
          )}
          <p className="muted small">Keep Follow Schedule off in the Rheem app so the two don&apos;t conflict.</p>
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
  const [blocks, setBlocks] = useState<ScheduleBlock[]>(() =>
    schedule.blocks.map((b) => ({ day: b.day, start: b.start, stop: b.stop, command: { ...b.command } })));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // Blocks always heat in Energy saver; only the times and temperature are editable.
  const onMode = heater.capabilities.modes.includes("energy_saver") ? "energy_saver" : heater.capabilities.modes.find((m) => m !== "off") ?? "energy_saver";
  const lo = heater.capabilities.setpoint_min_f ?? 110, hi = heater.capabilities.setpoint_max_f ?? 140;

  useEffect(() => { dialog.current?.showModal(); }, []);

  const dayBlocks = useMemo(
    () => blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.day === day).sort((x, y) => x.b.start.localeCompare(y.b.start)),
    [blocks, day],
  );

  // Which blocks clash with another one, so the editor can flag them before saving.
  const clashes = useMemo(() => {
    const bad = new Set<number>();
    blocks.forEach((a, i) => blocks.forEach((b, j) => { if (i < j && overlaps(a, b)) { bad.add(i); bad.add(j); } }));
    return bad;
  }, [blocks]);
  const sameTimes = blocks.some((b) => b.start === b.stop);

  const change = (i: number, patch: Partial<ScheduleBlock>, cmd?: Partial<ScheduleBlock["command"]>) => {
    setBlocks((all) => all.map((b, j) => (j === i ? { ...b, ...patch, command: { ...b.command, ...(cmd ?? {}) } } : b)));
    setDirty(true);
  };

  const add = () => {
    const last = dayBlocks.at(-1)?.b;
    // First free two hour window between 6 AM and 10 PM, in half hour steps.
    const probe = (s: number): ScheduleBlock => ({ day, start: fromMin(s), stop: fromMin(s + 120), command: { action: "set_state" } });
    let startMin = 360;
    while (startMin <= 1200 && blocks.some((b) => overlaps(probe(startMin), b))) startMin += 30;
    if (startMin > 1200) startMin = last ? toMin(last.stop) : 420;
    const start = fromMin(startMin);
    const stop = fromMin(startMin + 120);
    setBlocks((all) => [...all, {
      day, start, stop,
      command: { action: "set_state", mode: onMode, setpoint: last?.command.setpoint ?? Math.min(hi, Math.max(lo, 125)) },
    }]);
    setDirty(true);
  };

  const remove = (i: number) => { setBlocks((all) => all.filter((_, j) => j !== i)); setDirty(true); };

  const copyTo = (targets: number[], name: string) => {
    const source = blocks.filter((b) => b.day === day);
    setBlocks((all) => [
      ...all.filter((b) => b.day === day || !targets.includes(b.day)),
      ...targets.filter((t) => t !== day).flatMap((t) => source.map((b) => ({ ...b, day: t, command: { ...b.command } }))),
    ]);
    setDirty(true);
    notify(`Copied ${dayName(day)} to ${name}. Save to keep it.`);
  };

  const save = async () => {
    setSaving(true);
    const toSave = blocks.map((b) => ({ ...b, command: { ...b.command, action: "set_state", mode: onMode } }));
    try {
      const r = await fetch("/api/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: heater.id, blocks: toSave }),
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

  const dayHasClash = (d: number) => blocks.some((b, i) => b.day === d && clashes.has(i));
  const blocked = clashes.size > 0 || sameTimes;

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
              className={`day-tab ${day === d ? "is-active" : ""} ${d === today ? "is-today" : ""} ${dayHasClash(d) ? "has-clash" : ""}`}
              onClick={() => setDay(d)}>
              {short}
            </button>
          ))}
        </div>

        <p className="muted small">The heater runs during these blocks and is off the rest of {dayName(day)}.</p>

        <ol className="block-list">
          {dayBlocks.map(({ b, i }) => (
            <li key={i} className={`block-row ${clashes.has(i) || b.start === b.stop ? "has-clash" : ""}`}>
              <div className="block-top">
                <span className="block-name">{label(b.start)}</span>
                <button className="block-remove" onClick={() => remove(i)} aria-label={`Remove ${label(b.start)} block`}>Remove</button>
              </div>
              <div className="block-times">
                <label className="time-field">
                  <span>Start</span>
                  <input type="time" value={b.start} step={900} onChange={(e) => e.target.value && change(i, { start: e.target.value })} />
                </label>
                <label className="time-field">
                  <span>Stop</span>
                  <input type="time" value={b.stop} step={900} onChange={(e) => e.target.value && change(i, { stop: e.target.value })} />
                </label>
              </div>
              <div className="block-settings">
                <span className="block-temp-label">Temperature</span>
                <div className="slot-temp" aria-label="Temperature">
                  <button className="step step-small" disabled={(b.command.setpoint ?? lo) <= lo}
                    onClick={() => change(i, {}, { setpoint: (b.command.setpoint ?? lo) - 1 })} aria-label="Lower">−</button>
                  <span className="slot-temp-value">{b.command.setpoint}°</span>
                  <button className="step step-small" disabled={(b.command.setpoint ?? lo) >= hi}
                    onClick={() => change(i, {}, { setpoint: (b.command.setpoint ?? lo) + 1 })} aria-label="Raise">+</button>
                </div>
              </div>
              {toMin(b.stop) < toMin(b.start) && <p className="muted small">Runs past midnight into {dayName((b.day + 1) % 7)}.</p>}
              {b.start === b.stop && <p className="block-warn">Start and stop are the same time.</p>}
              {clashes.has(i) && <p className="block-warn">Overlaps another block. Adjust the times.</p>}
            </li>
          ))}
          {dayBlocks.length === 0 && <li className="muted">No blocks. The heater stays off all of {dayName(day)}.</li>}
        </ol>

        {dayBlocks.length < MAX_BLOCKS && (
          <button className="btn btn-quiet btn-small block-add" onClick={add}>Add a time block</button>
        )}

        <div className="copy-row">
          <span className="muted small">Copy {dayName(day)} to</span>
          <button className="chip" onClick={() => copyTo(WEEKDAYS, "weekdays")}>Weekdays</button>
          <button className="chip" onClick={() => copyTo(WEEKEND, "the weekend")}>Weekend</button>
          <button className="chip" onClick={() => copyTo(EVERY_DAY, "every day")}>Every day</button>
        </div>

        <button className="btn btn-brass" onClick={save} disabled={!dirty || saving || blocked}>
          {saving ? "Saving" : blocked ? "Fix the highlighted blocks to save" : dirty ? "Save schedule" : "No changes"}
        </button>
      </div>
    </dialog>
  );
}
