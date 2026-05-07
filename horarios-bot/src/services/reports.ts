import { DateTime } from 'luxon';
import { db } from '../db';
import { config, SHIFTS } from '../config';
import { Agent, listAllAgents } from './agents';

export type PunctualityScore = {
  /** 0-100, null when no data (no past shifts in range). */
  score: number | null;
  /** A / B / C / D / F or null. */
  grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  /** Past shifts evaluated (denominator). */
  pastShifts: number;
};

export type AgentReport = {
  agent: Agent;
  shifts: number;
  /** Shifts whose end time is already in the past (denominator for punctuality). */
  pastShifts: number;
  completed: number;
  late: { count: number; totalMin: number; incidents: { date: string; min: number }[] };
  breakExcess: { count: number; totalMin: number; incidents: { date: string; min: number }[] };
  unmarked: { count: number; dates: string[] };
  autoClockouts: { count: number; dates: string[] };
  permisoDays: number;
  vacationDays: number;
  otherOffDays: number;
  hoursWorked: number;
  punctuality: PunctualityScore;
};

/**
 * Compute a punctuality score (0-100) from already-aggregated metrics.
 * Penalty weights are read from config (editable in /settings):
 *   • unmarked      → config.punctualityWeightUnmarked
 *   • late          → config.punctualityWeightLate
 *   • autoClockout  → config.punctualityWeightAutoClockout
 * Letter grade: A ≥95, B ≥85, C ≥70, D ≥50, F <50.
 */
export function computePunctuality(opts: {
  pastShifts: number;
  unmarked: number;
  late: number;
  autoClockouts: number;
}): PunctualityScore {
  if (opts.pastShifts <= 0) {
    return { score: null, grade: null, pastShifts: 0 };
  }
  const penalty =
    config.punctualityWeightUnmarked     * opts.unmarked +
    config.punctualityWeightLate         * opts.late +
    config.punctualityWeightAutoClockout * opts.autoClockouts;
  const raw = 100 * (1 - penalty / opts.pastShifts);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  let grade: PunctualityScore['grade'];
  if (score >= 95) grade = 'A';
  else if (score >= 85) grade = 'B';
  else if (score >= 70) grade = 'C';
  else if (score >= 50) grade = 'D';
  else grade = 'F';
  return { score, grade, pastShifts: opts.pastShifts };
}

type PunchRow = {
  slack_id: string;
  type: string;
  ts: string;
  source: string;
  shift_date: string | null;
  shift_id: string | null;
};

type ScheduleRow = {
  date: string;
  dept: string;
  shift_id: string;
  planner_id: number;
  custom_start_hour: number | null;
  custom_end_hour: number | null;
};

/**
 * Build per-agent metrics for an arbitrary UTC date range (inclusive).
 * Both startStr and endStr are 'YYYY-MM-DD'. Use buildMonthlyReports for the
 * monthly shorthand. 3 SQL hits + in-memory aggregation; flat cost.
 */
export function buildReports(startStr: string, endStr: string): AgentReport[] {
  const rangeStart = DateTime.fromISO(startStr, { zone: 'utc' }).startOf('day');
  const rangeEnd = DateTime.fromISO(endStr, { zone: 'utc' }).endOf('day');
  if (!rangeStart.isValid || !rangeEnd.isValid || rangeEnd < rangeStart) return [];
  const now = DateTime.utc();

  const agents = listAllAgents(true); // include inactive for historical accuracy
  const byPlannerId = new Map(agents.map(a => [a.planner_id, a]));
  const bySlackId = new Map(agents.map(a => [a.slack_id, a]));

  // 1) Schedule entries in the month
  const schedRows = db.prepare(`
    SELECT * FROM schedule_entries WHERE date >= ? AND date <= ?
  `).all(startStr, endStr) as ScheduleRow[];

  // 2) Days off in the month
  const daysOffRows = db.prepare(`
    SELECT planner_id, date, reason FROM days_off_entries WHERE date >= ? AND date <= ?
  `).all(startStr, endStr) as { planner_id: number; date: string; reason: string | null }[];

  // 3) Punches with shift_date in the range (or with null shift_date but ts in the range)
  const punchRows = db.prepare(`
    SELECT slack_id, type, ts, source, shift_date, shift_id FROM punches
    WHERE (shift_date >= ? AND shift_date <= ?)
       OR (shift_date IS NULL AND ts >= ? AND ts <= ?)
  `).all(
    startStr, endStr,
    rangeStart.toUTC().toISO(), rangeEnd.toUTC().toISO()
  ) as PunchRow[];

  // Index punches by (slack_id, shift_date, shift_id, type)
  type PunchKey = string;
  const punchKey = (slackId: string, date: string, shiftId: string, type: string) =>
    `${slackId}|${date}|${shiftId}|${type}`;
  const punchIndex = new Map<PunchKey, PunchRow>();
  for (const p of punchRows) {
    if (!p.shift_date || !p.shift_id) continue;
    // For a (slack, shift_date, shift_id, type), prefer the LATEST one
    const k = punchKey(p.slack_id, p.shift_date, p.shift_id, p.type);
    const existing = punchIndex.get(k);
    if (!existing || p.ts > existing.ts) punchIndex.set(k, p);
  }

  // Initialize per-agent buckets
  const byAgent = new Map<string, AgentReport>();
  for (const a of agents) {
    byAgent.set(a.slack_id, {
      agent: a,
      shifts: 0, pastShifts: 0, completed: 0,
      late: { count: 0, totalMin: 0, incidents: [] },
      breakExcess: { count: 0, totalMin: 0, incidents: [] },
      unmarked: { count: 0, dates: [] },
      autoClockouts: { count: 0, dates: [] },
      permisoDays: 0, vacationDays: 0, otherOffDays: 0,
      hoursWorked: 0,
      punctuality: { score: null, grade: null, pastShifts: 0 }
    });
  }

  // Aggregate scheduled shifts
  for (const row of schedRows) {
    const agent = byPlannerId.get(row.planner_id);
    if (!agent) continue;
    const bucket = byAgent.get(agent.slack_id);
    if (!bucket) continue;

    const shiftDef = SHIFTS[row.dept]?.[row.shift_id];
    if (!shiftDef) continue;
    const startHour = row.custom_start_hour ?? shiftDef.startHour;
    const endHour = row.custom_end_hour ?? shiftDef.endHour;
    const baseDate = DateTime.fromISO(row.date, { zone: 'utc' });
    const shiftStart = baseDate.startOf('day').plus({ hours: startHour });
    const shiftEnd = baseDate.startOf('day').plus({ hours: endHour });

    bucket.shifts++;

    // Skip metrics for future shifts (no opportunity to be late/complete yet)
    if (now < shiftEnd) continue;
    bucket.pastShifts++;

    const clockIn = punchIndex.get(punchKey(agent.slack_id, row.date, row.shift_id, 'clock_in'));
    const clockOut = punchIndex.get(punchKey(agent.slack_id, row.date, row.shift_id, 'clock_out'));
    const breakIn = punchIndex.get(punchKey(agent.slack_id, row.date, row.shift_id, 'break_in'));
    const breakOut = punchIndex.get(punchKey(agent.slack_id, row.date, row.shift_id, 'break_out'));

    if (!clockIn) {
      bucket.unmarked.count++;
      bucket.unmarked.dates.push(row.date);
      continue;
    }

    // Late?
    const ciTs = DateTime.fromISO(clockIn.ts, { zone: 'utc' });
    const lateMin = Math.round(ciTs.diff(shiftStart, 'minutes').minutes);
    if (lateMin > config.lateThresholdMin) {
      bucket.late.count++;
      bucket.late.totalMin += lateMin;
      bucket.late.incidents.push({ date: row.date, min: lateMin });
    }

    if (clockOut) {
      bucket.completed++;
      const coTs = DateTime.fromISO(clockOut.ts, { zone: 'utc' });
      const workedHours = coTs.diff(ciTs, 'hours').hours;
      let breakHours = 0;
      if (breakIn && breakOut) {
        breakHours = DateTime.fromISO(breakOut.ts, { zone: 'utc' })
          .diff(DateTime.fromISO(breakIn.ts, { zone: 'utc' }), 'hours').hours;
      }
      bucket.hoursWorked += Math.max(0, workedHours - breakHours);
      if (clockOut.source === 'auto') {
        bucket.autoClockouts.count++;
        bucket.autoClockouts.dates.push(row.date);
      }
    }

    if (breakIn && breakOut) {
      const bIn = DateTime.fromISO(breakIn.ts, { zone: 'utc' });
      const bOut = DateTime.fromISO(breakOut.ts, { zone: 'utc' });
      const breakMin = Math.round(bOut.diff(bIn, 'minutes').minutes);
      if (breakMin > config.breakMaxMin) {
        const excess = breakMin - config.breakMaxMin;
        bucket.breakExcess.count++;
        bucket.breakExcess.totalMin += excess;
        bucket.breakExcess.incidents.push({ date: row.date, min: excess });
      }
    }
  }

  // Days off classification
  for (const d of daysOffRows) {
    const agent = byPlannerId.get(d.planner_id);
    if (!agent) continue;
    const bucket = byAgent.get(agent.slack_id);
    if (!bucket) continue;
    const reason = (d.reason || '').toLowerCase();
    if (reason === 'permiso') bucket.permisoDays++;
    else if (reason === 'vacaciones') bucket.vacationDays++;
    else bucket.otherOffDays++;
  }

  // Round hoursWorked to 2 decimals + compute punctuality score
  for (const b of byAgent.values()) {
    b.hoursWorked = +b.hoursWorked.toFixed(2);
    b.punctuality = computePunctuality({
      pastShifts: b.pastShifts,
      unmarked: b.unmarked.count,
      late: b.late.count,
      autoClockouts: b.autoClockouts.count
    });
  }

  return Array.from(byAgent.values())
    // Skip pure-manager rows (dept MGMT or no shifts in any month) — they don't
    // take shifts so they'd just be a row of zeros cluttering the report.
    .filter(b => b.agent.dept !== 'MGMT' && (b.agent.active || b.shifts > 0))
    .filter(b => b.shifts > 0 || b.permisoDays > 0 || b.vacationDays > 0 || b.otherOffDays > 0)
    .sort((a, b) => (a.agent.dept + a.agent.name).localeCompare(b.agent.dept + b.agent.name));
}

/** Convenience: monthly shorthand wrapper around buildReports. */
export function buildMonthlyReports(monthYYYYMM: string): AgentReport[] {
  const m = DateTime.fromFormat(monthYYYYMM, 'yyyy-LL', { zone: 'utc' });
  if (!m.isValid) return [];
  return buildReports(
    m.startOf('month').toFormat('yyyy-LL-dd'),
    m.endOf('month').toFormat('yyyy-LL-dd')
  );
}

export function reportsToCsv(rows: AgentReport[]): string {
  const headers = [
    'Agente', 'Slack ID', 'Planner ID', 'Dept', 'Activo',
    'Turnos', 'Completos', 'Sin marcar',
    'Tardanzas', 'Min tarde total',
    'Excesos break', 'Min exceso break total',
    'Auto clockouts',
    'Permisos (dias)', 'Vacaciones (dias)', 'Libres otros (dias)',
    'Horas trabajadas'
  ];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const cells = [
      escapeCsv(r.agent.name),
      r.agent.slack_id,
      String(r.agent.planner_id),
      r.agent.dept,
      r.agent.active ? 'Si' : 'No',
      String(r.shifts), String(r.completed), String(r.unmarked.count),
      String(r.late.count), String(r.late.totalMin),
      String(r.breakExcess.count), String(r.breakExcess.totalMin),
      String(r.autoClockouts.count),
      String(r.permisoDays), String(r.vacationDays), String(r.otherOffDays),
      r.hoursWorked.toFixed(2)
    ];
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

function escapeCsv(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
