/**
 * Planner state service: persisted JSON template for the cycle-based planner
 * editor (4 cycles × dept × day × shift, plus per-agent days-off per cycle).
 * The editor reads/writes this blob; applying it to specific dates is done
 * separately via the existing planner-import flow.
 */
import { db } from '../db';

export type ScheduleCell = { emps: number[]; note: string };
export type ScheduleByCycle = Record<string, Record<string, Record<string, Record<string, ScheduleCell>>>>;
// daysOff[empId][cycle] = string[] of day codes ('L','M','C','J','V','S','D')
export type DaysOffByEmp = Record<string, Record<string, string[]>>;

export type PlannerState = {
  schedule: ScheduleByCycle;
  daysOff: DaysOffByEmp;
  updated_at: string | null;
  updated_by: string | null;
};

export function getPlannerState(): PlannerState {
  const r = db.prepare(
    'SELECT schedule_json, days_off_json, updated_at, updated_by FROM planner_state WHERE id = 1'
  ).get() as { schedule_json: string; days_off_json: string; updated_at: string; updated_by: string | null } | undefined;
  if (!r) {
    return { schedule: {}, daysOff: {}, updated_at: null, updated_by: null };
  }
  let schedule: ScheduleByCycle = {};
  let daysOff: DaysOffByEmp = {};
  try { schedule = JSON.parse(r.schedule_json); } catch { /* ignore */ }
  try { daysOff = JSON.parse(r.days_off_json); } catch { /* ignore */ }
  return { schedule, daysOff, updated_at: r.updated_at, updated_by: r.updated_by };
}

export function setPlannerState(schedule: ScheduleByCycle, daysOff: DaysOffByEmp, updatedBy: string | null) {
  db.prepare(`
    INSERT INTO planner_state (id, schedule_json, days_off_json, updated_at, updated_by)
    VALUES (1, ?, ?, datetime('now'), ?)
    ON CONFLICT(id) DO UPDATE SET
      schedule_json = excluded.schedule_json,
      days_off_json = excluded.days_off_json,
      updated_at    = excluded.updated_at,
      updated_by    = excluded.updated_by
  `).run(JSON.stringify(schedule), JSON.stringify(daysOff), updatedBy);
}
