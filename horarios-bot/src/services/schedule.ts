import { DateTime } from 'luxon';
import { db } from '../db';
import { config, CYCLES, SHIFTS, ShiftDef } from '../config';

const DAY_INDEX: Record<string, number> = { L: 1, M: 2, C: 3, J: 4, V: 5, S: 6, D: 7 };

export function dayCodeFromDate(d: DateTime): string {
  const idx = d.weekday;
  const entry = Object.entries(DAY_INDEX).find(([, v]) => v === idx);
  return entry ? entry[0] : 'L';
}

/** Cycle (A/B/C/D) for the Monday-week containing the given UTC date — used for display only. */
export function cycleForDate(d: DateTime): 'A' | 'B' | 'C' | 'D' {
  const anchor = DateTime.fromISO(config.anchorDate, { zone: 'utc' }).startOf('day');
  const target = d.toUTC().startOf('day');
  const targetMonday = target.minus({ days: target.weekday - 1 });
  const anchorMonday = anchor.minus({ days: anchor.weekday - 1 });
  const weeks = Math.floor(targetMonday.diff(anchorMonday, 'weeks').weeks);
  const anchorIdx = CYCLES.indexOf(config.anchorCycle);
  const idx = ((anchorIdx + weeks) % 4 + 4) % 4;
  return CYCLES[idx];
}

export type ScheduleEntryRow = {
  id: number;
  date: string;
  dept: string;
  shift_id: string;
  planner_id: number;
  custom_start_hour: number | null;
  custom_end_hour: number | null;
  note: string | null;
  source: string;
};

export type ResolvedShift = {
  id: number;
  planner_id: number;
  dept: string;
  shift: ShiftDef;
  startHour: number;
  endHour: number;
  date: string;
  cycle: string;
  day: string;
  note: string | null;
};

function resolve(row: ScheduleEntryRow): ResolvedShift | null {
  const shift = SHIFTS[row.dept]?.[row.shift_id];
  if (!shift) return null;
  const date = DateTime.fromISO(row.date, { zone: 'utc' });
  return {
    id: row.id,
    planner_id: row.planner_id,
    dept: row.dept,
    shift,
    startHour: row.custom_start_hour ?? shift.startHour,
    endHour: row.custom_end_hour ?? shift.endHour,
    date: row.date,
    cycle: cycleForDate(date),
    day: dayCodeFromDate(date),
    note: row.note
  };
}

export function clearScheduleRange(startDate: string, endDate: string) {
  db.prepare('DELETE FROM schedule_entries WHERE date >= ? AND date <= ?').run(startDate, endDate);
  db.prepare('DELETE FROM days_off_entries WHERE date >= ? AND date <= ?').run(startDate, endDate);
}

export function clearAllSchedules() {
  db.prepare('DELETE FROM schedule_entries').run();
  db.prepare('DELETE FROM days_off_entries').run();
}

export function insertScheduleEntry(opts: {
  date: string;
  dept: string;
  shiftId: string;
  plannerId: number;
  customStartHour?: number | null;
  customEndHour?: number | null;
  note?: string | null;
  source?: string;
}) {
  db.prepare(`
    INSERT INTO schedule_entries
      (date, dept, shift_id, planner_id, custom_start_hour, custom_end_hour, note, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.date, opts.dept, opts.shiftId, opts.plannerId,
    opts.customStartHour ?? null, opts.customEndHour ?? null,
    opts.note ?? null, opts.source ?? 'import'
  );
}

export function insertDayOffEntry(plannerId: number, date: string, reason: string | null = null) {
  db.prepare(`
    INSERT OR IGNORE INTO days_off_entries (planner_id, date, reason) VALUES (?, ?, ?)
  `).run(plannerId, date, reason);
}

export function isDayOff(plannerId: number, date: string): boolean {
  const r = db.prepare('SELECT 1 FROM days_off_entries WHERE planner_id = ? AND date = ?')
    .get(plannerId, date);
  return !!r;
}

/** Returns shift assignments for a given UTC date for a given planner_id. */
export function getShiftsForAgent(plannerId: number, date: DateTime): ResolvedShift[] {
  const dateStr = date.toUTC().toFormat('yyyy-LL-dd');
  if (isDayOff(plannerId, dateStr)) return [];
  const rows = db.prepare(`
    SELECT * FROM schedule_entries WHERE date = ? AND planner_id = ?
  `).all(dateStr, plannerId) as ScheduleEntryRow[];
  return rows.map(resolve).filter((x): x is ResolvedShift => !!x);
}

/** All scheduled shifts on a given UTC date (across all agents). */
export function getAllShiftsForDate(date: DateTime): ResolvedShift[] {
  const dateStr = date.toUTC().toFormat('yyyy-LL-dd');
  const rows = db.prepare(`
    SELECT s.* FROM schedule_entries s
    WHERE s.date = ?
      AND NOT EXISTS (
        SELECT 1 FROM days_off_entries d
        WHERE d.planner_id = s.planner_id AND d.date = s.date
      )
  `).all(dateStr) as ScheduleEntryRow[];
  return rows.map(resolve).filter((x): x is ResolvedShift => !!x);
}

/** UTC start/end DateTimes for a resolved shift. */
export function shiftWindow(date: DateTime, rs: { startHour: number; endHour: number }): { start: DateTime; end: DateTime } {
  const base = date.toUTC().startOf('day');
  return {
    start: base.plus({ hours: rs.startHour }),
    end: base.plus({ hours: rs.endHour })
  };
}

/** Lookup an agent's single schedule_entries row on a date (or undefined). Multi-row returns first. */
export function findScheduleEntry(plannerId: number, date: string): ScheduleEntryRow | undefined {
  return db.prepare(`
    SELECT * FROM schedule_entries WHERE planner_id = ? AND date = ?
  `).get(plannerId, date) as ScheduleEntryRow | undefined;
}

export function countScheduleEntries(plannerId: number, date: string): number {
  const r = db.prepare('SELECT COUNT(*) AS c FROM schedule_entries WHERE planner_id = ? AND date = ?')
    .get(plannerId, date) as { c: number };
  return r.c;
}
