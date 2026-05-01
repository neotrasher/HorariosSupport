import { DateTime } from 'luxon';
import { db } from '../db';
import { CYCLES } from '../config';
import {
  cycleForDate, dayCodeFromDate, clearScheduleRange,
  insertScheduleEntry, insertDayOffEntry
} from './schedule';

const VALID_DAYS = ['L', 'M', 'C', 'J', 'V', 'S', 'D'] as const;
const VALID_DEPTS = ['L1', 'L2'] as const;
const VALID_SHIFTS = ['M', 'T', 'E', 'N'] as const;

export type PlannerJson = {
  schedule?: Record<string, Record<string, Record<string, Record<string,
    number[] | { emps?: number[]; note?: string }
  >>>>;
  daysOff?: Record<string, Record<string, string[]>>;
  employees?: { id: number; name: string; dept: string }[];
  version?: number;
};

export type ExpansionResult = {
  entries: { date: string; dept: string; shiftId: string; plannerId: number; note: string | null }[];
  daysOff: { date: string; plannerId: number; reason: string | null }[];
  errors: string[];
  rangeStart: string;
  rangeEnd: string;
  daysCount: number;
};

/**
 * Expand a planner cycle-template JSON into date-based entries for a range.
 * Doesn't touch the DB — caller decides when to apply via applyExpansion.
 */
export function expandPlanner(json: PlannerJson, startStr: string, endStr: string): ExpansionResult {
  const start = DateTime.fromISO(startStr, { zone: 'utc' }).startOf('day');
  const end = DateTime.fromISO(endStr, { zone: 'utc' }).startOf('day');
  const result: ExpansionResult = {
    entries: [], daysOff: [], errors: [],
    rangeStart: startStr, rangeEnd: endStr, daysCount: 0
  };
  if (!start.isValid || !end.isValid || end < start) {
    result.errors.push('Rango invalido.');
    return result;
  }
  if (!json.schedule) {
    result.errors.push('JSON no tiene `schedule`.');
    return result;
  }

  // Pre-compute days_off lookup: planner_id → cycle → Set<dayCode>
  const dayOffLookup = new Map<number, Map<string, Set<string>>>();
  if (json.daysOff) {
    for (const [idStr, perCycle] of Object.entries(json.daysOff)) {
      const pid = parseInt(idStr, 10);
      if (isNaN(pid)) continue;
      const cycleMap = new Map<string, Set<string>>();
      for (const [cy, days] of Object.entries(perCycle)) {
        if (!CYCLES.includes(cy as any)) continue;
        cycleMap.set(cy, new Set(Array.isArray(days) ? days : []));
      }
      dayOffLookup.set(pid, cycleMap);
    }
  }

  // Walk every date in the range
  let cursor = start;
  let daysCount = 0;
  while (cursor <= end) {
    daysCount++;
    const dateStr = cursor.toFormat('yyyy-LL-dd');
    const cycle = cycleForDate(cursor);
    const day = dayCodeFromDate(cursor);

    const schedForCycle = json.schedule[cycle];
    if (schedForCycle) {
      for (const dept of VALID_DEPTS) {
        const deptObj = schedForCycle[dept];
        if (!deptObj) continue;
        const dayObj = deptObj[day];
        if (!dayObj) continue;
        for (const shiftId of VALID_SHIFTS) {
          const cell = dayObj[shiftId];
          if (!cell) continue;
          const emps = Array.isArray(cell)
            ? cell
            : Array.isArray(cell.emps) ? cell.emps : [];
          const note = !Array.isArray(cell) && typeof cell.note === 'string' && cell.note.trim() ? cell.note : null;
          for (const pid of emps) {
            if (typeof pid !== 'number') continue;
            // Skip if this planner_id has this day off in this cycle
            const offDays = dayOffLookup.get(pid)?.get(cycle);
            if (offDays?.has(day)) continue;
            result.entries.push({ date: dateStr, dept, shiftId, plannerId: pid, note });
          }
        }
      }
    }

    // Days off on this date
    for (const [pid, cycleMap] of dayOffLookup.entries()) {
      const offDays = cycleMap.get(cycle);
      if (offDays?.has(day)) {
        result.daysOff.push({ date: dateStr, plannerId: pid, reason: 'rest' });
      }
    }

    cursor = cursor.plus({ days: 1 });
  }
  result.daysCount = daysCount;
  return result;
}

export type ApplyStats = { entriesInserted: number; daysOffInserted: number; rangeCleared: boolean };

/**
 * Apply an expansion result transactionally: clear schedule_entries +
 * days_off_entries within the range, then insert all entries.
 */
export function applyExpansion(exp: ExpansionResult): ApplyStats {
  let entriesInserted = 0;
  let daysOffInserted = 0;
  const tx = db.transaction(() => {
    clearScheduleRange(exp.rangeStart, exp.rangeEnd);
    for (const e of exp.entries) {
      insertScheduleEntry({
        date: e.date, dept: e.dept, shiftId: e.shiftId,
        plannerId: e.plannerId, note: e.note,
        source: 'planner'
      });
      entriesInserted++;
    }
    for (const d of exp.daysOff) {
      insertDayOffEntry(d.plannerId, d.date, d.reason);
      daysOffInserted++;
    }
  });
  tx();
  return { entriesInserted, daysOffInserted, rangeCleared: true };
}
