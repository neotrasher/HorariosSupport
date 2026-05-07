/**
 * Smart coverage suggestions: given a pending time-off request, propose
 * agents who could cover each affected shift, ranked by:
 *   1. Same dept (hard filter)
 *   2. Free that day (no scheduled shift, no day-off, no approved time-off)
 *   3. High punctuality score
 *   4. Few extra shifts already covered recently (load balancing)
 */
import { DateTime } from 'luxon';
import { db } from '../db';
import { Agent, listAgents } from './agents';
import { findScheduleEntry, getShiftsForAgent } from './schedule';
import { buildReports } from './reports';
import { SHIFTS } from '../config';

export interface CoverageCandidate {
  agent: Agent;
  punctualityScore: number | null;
  punctualityGrade: string | null;
  recentShiftsCount: number;     // shifts in last 14 days (load proxy)
  reasons: string[];             // human-readable positives
  warnings: string[];            // human-readable negatives
}

export interface CoverageDate {
  date: string;
  shift: {
    dept: string;
    shiftId: string;
    label: string;
    startHour: number;
    endHour: number;
  } | null;
  candidates: CoverageCandidate[];
  isWeekend: boolean;
}

export interface CoverageReport {
  requesterSlackId: string;
  requesterName: string;
  requesterDept: string;
  type: string;
  startDate: string;
  endDate: string;
  perDate: CoverageDate[];
}

/** True if agent is on an approved or pending non-cancelled time-off request that overlaps `date`. */
function agentOnTimeOff(slackId: string, date: string): boolean {
  const r = db.prepare(`
    SELECT 1 FROM time_off_requests
    WHERE requester_slack_id = ?
      AND status = 'approved'
      AND start_date <= ? AND end_date >= ?
    LIMIT 1
  `).get(slackId, date, date);
  return !!r;
}

/** Count shifts for an agent in [today-14d, today]. Cheap load proxy. */
function recentShiftCount(plannerId: number): number {
  const today = DateTime.utc();
  const since = today.minus({ days: 14 }).toFormat('yyyy-LL-dd');
  const until = today.toFormat('yyyy-LL-dd');
  const r = db.prepare(`
    SELECT COUNT(*) AS c FROM schedule_entries
    WHERE planner_id = ? AND date >= ? AND date <= ?
  `).get(plannerId, since, until) as { c: number };
  return r?.c ?? 0;
}

/**
 * Build coverage suggestions for a time-off request. Returns one entry per date
 * in the request range. If the requester wasn't scheduled that date, `shift` is
 * null and `candidates` is empty (nothing to cover).
 */
export function suggestCoverage(opts: {
  requesterSlackId: string;
  startDate: string;
  endDate: string;
  type: string;
}): CoverageReport | null {
  // Resolve requester
  const requester = db.prepare('SELECT * FROM agents WHERE slack_id = ?')
    .get(opts.requesterSlackId) as Agent | undefined;
  if (!requester) return null;

  const allAgents = listAgents()
    .filter(a => a.dept === requester.dept && a.slack_id !== requester.slack_id);

  // Punctuality scores over the last 90 days for ranking
  const today = DateTime.utc();
  const punctSince = today.minus({ days: 90 }).toFormat('yyyy-LL-dd');
  const punctUntil = today.toFormat('yyyy-LL-dd');
  const reports = buildReports(punctSince, punctUntil);
  const scoreBySlackId = new Map<string, { score: number | null; grade: string | null }>();
  for (const r of reports) {
    scoreBySlackId.set(r.agent.slack_id, {
      score: r.punctuality.score,
      grade: r.punctuality.grade
    });
  }

  // Iterate dates in range
  const start = DateTime.fromISO(opts.startDate, { zone: 'utc' });
  const end = DateTime.fromISO(opts.endDate, { zone: 'utc' });
  if (!start.isValid || !end.isValid || end < start) return null;

  const perDate: CoverageDate[] = [];
  let cursor = start;
  while (cursor <= end) {
    const dateStr = cursor.toFormat('yyyy-LL-dd');
    const isWeekend = cursor.weekday === 6 || cursor.weekday === 7;

    // What was the requester scheduled to do that day?
    const scheduled = findScheduleEntry(requester.planner_id, dateStr);

    let entry: CoverageDate;
    if (!scheduled) {
      entry = {
        date: dateStr,
        shift: null,
        candidates: [],
        isWeekend
      };
    } else {
      const shiftDef = SHIFTS[scheduled.dept]?.[scheduled.shift_id];
      const shift = shiftDef ? {
        dept: scheduled.dept,
        shiftId: scheduled.shift_id,
        label: shiftDef.label,
        startHour: scheduled.custom_start_hour ?? shiftDef.startHour,
        endHour: scheduled.custom_end_hour ?? shiftDef.endHour
      } : null;

      // Score each candidate
      const candidates: CoverageCandidate[] = [];
      for (const a of allAgents) {
        const reasons: string[] = [];
        const warnings: string[] = [];

        // Has shift that day already?
        const ownShifts = getShiftsForAgent(a.planner_id, cursor);
        if (ownShifts.length > 0) continue; // hard filter — can't cover, already busy

        // On approved time-off?
        if (agentOnTimeOff(a.slack_id, dateStr)) {
          continue; // hard filter — they're off too
        }

        // Has a day-off entry (rest day or planned time-off)?
        const dayOffRow = db.prepare(
          'SELECT reason FROM days_off_entries WHERE planner_id = ? AND date = ?'
        ).get(a.planner_id, dateStr) as { reason: string | null } | undefined;
        if (dayOffRow) {
          const reason = (dayOffRow.reason || '').toLowerCase();
          if (reason === 'vacaciones' || reason === 'permiso') continue; // hard filter
          // 'rest' or null: it's a rest day — soft warning
          warnings.push('Es día de descanso programado');
        }

        const sc = scoreBySlackId.get(a.slack_id) || { score: null, grade: null };
        const recent = recentShiftCount(a.planner_id);

        if (sc.score !== null && sc.score >= 85) reasons.push(`Score ${sc.score} (${sc.grade})`);
        else if (sc.score !== null && sc.score >= 70) reasons.push(`Score ${sc.score}`);
        if (recent <= 8) reasons.push(`Carga baja (${recent} turnos en 14d)`);
        else if (recent >= 12) warnings.push(`Carga alta (${recent} turnos en 14d)`);

        candidates.push({
          agent: a,
          punctualityScore: sc.score,
          punctualityGrade: sc.grade,
          recentShiftsCount: recent,
          reasons,
          warnings
        });
      }

      // Sort: punctuality desc (nulls last) → recent shifts asc
      candidates.sort((a, b) => {
        const sa = a.punctualityScore ?? -1;
        const sb = b.punctualityScore ?? -1;
        if (sb !== sa) return sb - sa;
        return a.recentShiftsCount - b.recentShiftsCount;
      });

      entry = {
        date: dateStr,
        shift,
        candidates,
        isWeekend
      };
    }

    perDate.push(entry);
    cursor = cursor.plus({ days: 1 });
  }

  return {
    requesterSlackId: requester.slack_id,
    requesterName: requester.name,
    requesterDept: requester.dept,
    type: opts.type,
    startDate: opts.startDate,
    endDate: opts.endDate,
    perDate
  };
}
