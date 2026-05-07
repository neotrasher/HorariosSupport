/**
 * Admin/manager dashboard insights — aggregates HR/operational data into
 * a single payload for the home page hero section. All UTC-based.
 */
import { DateTime } from 'luxon';
import { db } from '../db';
import { listAgents } from './agents';
import { buildReports } from './reports';
import { vacationDaysUsedInYear } from './timeOff';
import { config } from '../config';

export interface InsightAgentMini {
  slack_id: string;
  name: string;
  dept: string;
}

export interface InsightScored extends InsightAgentMini {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  pastShifts: number;
}

export interface InsightVacation extends InsightAgentMini {
  used: number;
  entitled: number;
  available: number;
}

export interface InsightUpcomingDate extends InsightAgentMini {
  date: string;
  daysUntil: number;
}

export interface AdminInsights {
  pendingRequests: number;
  teamScoreAvg: number | null;          // 0-100 or null
  teamScoreEvaluated: number;           // how many agents had score data
  topPerformers: InsightScored[];       // best 3
  needsAttention: InsightScored[];      // worst 3 (D or F)
  vacationCritical: InsightVacation[];  // <= 3 days available
  upcomingEvaluations: InsightUpcomingDate[];  // within next 30 days
  upcomingBirthdays: InsightUpcomingDate[];    // within next 30 days
  shiftsThisWeek: number;
  unmarkedThisWeek: number;
  lateThisWeek: number;
}

/** Days from today (UTC) until target date string YYYY-MM-DD; negative = past. */
function daysUntilDate(target: string, today: DateTime): number {
  const t = DateTime.fromISO(target, { zone: 'utc' });
  if (!t.isValid) return Number.POSITIVE_INFINITY;
  return Math.round(t.startOf('day').diff(today.startOf('day'), 'days').days);
}

/**
 * Compute days until the next occurrence of a birthday's month/day.
 * Accepts 'YYYY-MM-DD' (full) and 'MM-DD' (partial, no year known).
 * Returns -1 if format invalid.
 */
function daysUntilAnnual(birthdate: string, today: DateTime): number {
  const full = birthdate.match(/^\d{4}-(\d{2})-(\d{2})$/);
  const partial = birthdate.match(/^(\d{2})-(\d{2})$/);
  let monthStr: string, dayStr: string;
  if (full) { monthStr = full[1]; dayStr = full[2]; }
  else if (partial) { monthStr = partial[1]; dayStr = partial[2]; }
  else return -1;
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  let next = today.set({ month, day }).startOf('day');
  if (next < today.startOf('day')) {
    next = next.plus({ years: 1 });
  }
  return Math.round(next.diff(today.startOf('day'), 'days').days);
}

export function computeAdminInsights(): AdminInsights {
  const today = DateTime.utc();
  const year = today.year;

  const agents = listAgents().filter(a => a.dept !== 'MGMT');
  const agentMini = (a: typeof agents[number]): InsightAgentMini => ({
    slack_id: a.slack_id, name: a.name, dept: a.dept
  });

  // ── Pending requests count ──────────────────────────────────────────
  const pendingRow = db.prepare(
    "SELECT COUNT(*) AS c FROM time_off_requests WHERE status = 'pending'"
  ).get() as { c: number };
  const pendingRequests = pendingRow?.c ?? 0;

  // ── Punctuality (last 90 days) ──────────────────────────────────────
  const punctSince = today.minus({ days: 90 }).toFormat('yyyy-LL-dd');
  const punctUntil = today.toFormat('yyyy-LL-dd');
  const reports = buildReports(punctSince, punctUntil);
  const scored: InsightScored[] = [];
  for (const r of reports) {
    if (r.agent.dept === 'MGMT') continue;
    if (r.punctuality.score === null) continue;
    scored.push({
      slack_id: r.agent.slack_id,
      name: r.agent.name,
      dept: r.agent.dept,
      score: r.punctuality.score,
      grade: r.punctuality.grade,
      pastShifts: r.punctuality.pastShifts
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const teamScoreEvaluated = scored.length;
  const teamScoreAvg = teamScoreEvaluated > 0
    ? Math.round(scored.reduce((s, x) => s + x.score, 0) / teamScoreEvaluated)
    : null;
  const topPerformers = scored.slice(0, 3);
  const needsAttention = scored
    .filter(s => s.grade === 'D' || s.grade === 'F')
    .slice(-3)
    .reverse(); // worst first

  // ── Vacation critical (<= 3 days available) ─────────────────────────
  const vacationCritical: InsightVacation[] = [];
  for (const a of agents) {
    if (a.vacation_days_per_year == null) continue;
    const used = vacationDaysUsedInYear(a.slack_id, year);
    const available = a.vacation_days_per_year - used;
    if (available <= 3) {
      vacationCritical.push({
        ...agentMini(a), used, entitled: a.vacation_days_per_year, available
      });
    }
  }
  vacationCritical.sort((a, b) => a.available - b.available);

  // ── Upcoming evaluations + birthdays (next 30 days) ─────────────────
  const upcomingEvaluations: InsightUpcomingDate[] = [];
  const upcomingBirthdays: InsightUpcomingDate[] = [];
  for (const a of agents) {
    if (a.next_evaluation_date) {
      const d = daysUntilDate(a.next_evaluation_date, today);
      if (d >= 0 && d <= 30) {
        upcomingEvaluations.push({
          ...agentMini(a),
          date: a.next_evaluation_date,
          daysUntil: d
        });
      }
    }
    if (a.birthdate) {
      const d = daysUntilAnnual(a.birthdate, today);
      if (d >= 0 && d <= 30) {
        upcomingBirthdays.push({
          ...agentMini(a),
          date: a.birthdate,
          daysUntil: d
        });
      }
    }
  }
  upcomingEvaluations.sort((a, b) => a.daysUntil - b.daysUntil);
  upcomingBirthdays.sort((a, b) => a.daysUntil - b.daysUntil);

  // ── Week stats (current ISO week) ───────────────────────────────────
  const weekStart = today.startOf('week').toFormat('yyyy-LL-dd');
  const weekEnd = today.endOf('week').toFormat('yyyy-LL-dd');
  const weekReports = buildReports(weekStart, weekEnd);
  let shiftsThisWeek = 0;
  let unmarkedThisWeek = 0;
  let lateThisWeek = 0;
  for (const r of weekReports) {
    shiftsThisWeek += r.shifts;
    unmarkedThisWeek += r.unmarked.count;
    lateThisWeek += r.late.count;
  }

  return {
    pendingRequests,
    teamScoreAvg,
    teamScoreEvaluated,
    topPerformers,
    needsAttention,
    vacationCritical,
    upcomingEvaluations,
    upcomingBirthdays,
    shiftsThisWeek,
    unmarkedThisWeek,
    lateThisWeek
  };
}
