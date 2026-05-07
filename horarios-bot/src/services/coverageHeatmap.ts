/**
 * Coverage heatmap: for a date range, builds a [date][hour-of-UTC-day] matrix
 * with the count of scheduled agents covering each hour.
 *
 * Note: shifts can wrap past midnight (e.g. L1 Noche 19-27 = 19h that day +
 * 0-3h next day). We expand each shift across affected calendar dates so the
 * heatmap reflects actual coverage by wall-clock hour.
 */
import { db } from '../db';
import { SHIFTS } from '../config';

export interface HeatmapCell {
  date: string;       // YYYY-MM-DD
  hour: number;       // 0-23 UTC
  count: number;      // agents covering this hour
}

export interface HeatmapData {
  startDate: string;
  endDate: string;
  dept: string | null;
  /** dates[] in chronological order */
  dates: string[];
  /** Map: `${date}|${hour}` → count */
  counts: Map<string, number>;
  /** Min/max for color scaling */
  minCount: number;
  maxCount: number;
  /** Per-date totals (sum of agent-hours covered) */
  totalsByDate: Record<string, number>;
  /** Per-hour totals across all dates */
  totalsByHour: Record<number, number>;
}

interface ScheduleRow {
  date: string;
  dept: string;
  shift_id: string;
  planner_id: number;
  custom_start_hour: number | null;
  custom_end_hour: number | null;
}

/** Add 1 to count for each integer hour in [startHour, endHour) on `date`. */
function expandShift(
  date: string,
  startHour: number,
  endHour: number,
  counts: Map<string, number>,
  validDates: Set<string>
) {
  // Each integer hour the shift covers, attribute to the calendar day where it falls
  const start = Math.floor(startHour);
  const end = Math.ceil(endHour);
  for (let h = start; h < end; h++) {
    const dayOffset = Math.floor(h / 24);
    const hourOfDay = ((h % 24) + 24) % 24;
    let targetDate = date;
    if (dayOffset !== 0) {
      // Compute neighboring date string; +N or -N days
      const d = new Date(date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + dayOffset);
      targetDate = d.toISOString().slice(0, 10);
    }
    if (!validDates.has(targetDate)) continue; // outside the requested range
    const k = `${targetDate}|${hourOfDay}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
}

export function buildHeatmap(opts: {
  startDate: string;
  endDate: string;
  dept?: string | null;
}): HeatmapData {
  const counts = new Map<string, number>();
  const dates: string[] = [];
  // Expand date range
  const start = new Date(opts.startDate + 'T00:00:00Z');
  const end = new Date(opts.endDate + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  const validDates = new Set(dates);

  // Pull schedule rows in range (+1 day buffer for shifts that started prev day)
  const queryStart = new Date(start);
  queryStart.setUTCDate(queryStart.getUTCDate() - 1);
  const qsStr = queryStart.toISOString().slice(0, 10);

  let rows: ScheduleRow[];
  if (opts.dept) {
    rows = db.prepare(`
      SELECT s.* FROM schedule_entries s
      WHERE s.date >= ? AND s.date <= ? AND s.dept = ?
        AND NOT EXISTS (
          SELECT 1 FROM days_off_entries d
          WHERE d.planner_id = s.planner_id AND d.date = s.date
        )
    `).all(qsStr, opts.endDate, opts.dept) as ScheduleRow[];
  } else {
    rows = db.prepare(`
      SELECT s.* FROM schedule_entries s
      WHERE s.date >= ? AND s.date <= ?
        AND NOT EXISTS (
          SELECT 1 FROM days_off_entries d
          WHERE d.planner_id = s.planner_id AND d.date = s.date
        )
    `).all(qsStr, opts.endDate) as ScheduleRow[];
  }

  for (const row of rows) {
    const def = SHIFTS[row.dept]?.[row.shift_id];
    if (!def) continue;
    const startHour = row.custom_start_hour ?? def.startHour;
    const endHour = row.custom_end_hour ?? def.endHour;
    expandShift(row.date, startHour, endHour, counts, validDates);
  }

  // Compute totals + min/max
  let minCount = Infinity;
  let maxCount = 0;
  const totalsByDate: Record<string, number> = {};
  const totalsByHour: Record<number, number> = {};
  for (const date of dates) {
    let dayTotal = 0;
    for (let h = 0; h < 24; h++) {
      const c = counts.get(`${date}|${h}`) || 0;
      if (c < minCount) minCount = c;
      if (c > maxCount) maxCount = c;
      dayTotal += c;
      totalsByHour[h] = (totalsByHour[h] || 0) + c;
    }
    totalsByDate[date] = dayTotal;
  }
  if (minCount === Infinity) minCount = 0;

  return {
    startDate: opts.startDate,
    endDate: opts.endDate,
    dept: opts.dept ?? null,
    dates,
    counts,
    minCount,
    maxCount,
    totalsByDate,
    totalsByHour
  };
}
