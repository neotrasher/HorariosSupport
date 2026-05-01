import { Router } from 'express';
import { DateTime } from 'luxon';
import { SHIFTS } from '../../config';
import { listAgents } from '../../services/agents';
import {
  getAllShiftsForDate, getAllShiftsForRange, shiftWindow, cycleForDate
} from '../../services/schedule';

export const horariosRouter = Router();

type ViewMode = 'day' | 'week' | 'month';

horariosRouter.get('/', (req, res) => {
  const user = (req.session as any).user;
  const view = ((req.query.view as string) || 'day') as ViewMode;

  if (view === 'day') return renderDay(req, res, user);
  if (view === 'week') return renderWeek(req, res, user);
  if (view === 'month') return renderMonth(req, res, user);
  res.status(400).render('error', { message: 'Vista no valida (day/week/month)', user });
});

function renderDay(req: any, res: any, user: any) {
  const dateParam = req.query.date as string | undefined;
  const date = dateParam ? DateTime.fromISO(dateParam, { zone: 'utc' }) : DateTime.utc().startOf('day');
  if (!date.isValid) {
    res.status(400).render('error', { message: 'Fecha no valida', user });
    return;
  }

  const agents = listAgents();
  const agentByPid = new Map(agents.map(a => [a.planner_id, a]));
  const cycle = cycleForDate(date);
  const shifts = getAllShiftsForDate(date);

  const colorIndexFor = (id: number) => Math.abs(id * 2654435761 % 12);

  type AgentChip = { name: string; plannerId: number; colorIdx: number; native: boolean; nativeDept: string; custom: boolean; swapped: boolean };
  type ShiftRow = { id: string; label: string; startHour: number; endHour: number; agents: AgentChip[] };
  type DeptBlock = { dept: string; rows: ShiftRow[] };

  const blocks: DeptBlock[] = [];
  for (const dept of Object.keys(SHIFTS).sort()) {
    const shiftDefs = Object.values(SHIFTS[dept]);
    const rows: ShiftRow[] = shiftDefs.map(sh => ({
      id: sh.id, label: sh.label,
      startHour: sh.startHour, endHour: sh.endHour,
      agents: []
    }));
    for (const s of shifts) {
      if (s.dept !== dept) continue;
      const row = rows.find(r => r.id === s.shift.id);
      if (!row) continue;
      const a = agentByPid.get(s.planner_id);
      if (!a) continue;
      row.agents.push({
        name: a.name,
        plannerId: s.planner_id,
        colorIdx: colorIndexFor(s.planner_id),
        native: a.dept === dept,
        nativeDept: a.dept,
        custom: s.startHour !== s.shift.startHour || s.endHour !== s.shift.endHour,
        swapped: s.source === 'swap'
      });
    }
    rows.forEach(r => r.agents.sort((a, b) => a.name.localeCompare(b.name)));
    blocks.push({ dept, rows });
  }

  res.render('horarios-day', {
    user,
    view: 'day',
    dateStr: date.toFormat('yyyy-LL-dd'),
    dateLabelLocal: date.setLocale('es').toFormat('cccc d LLLL yyyy'),
    cycle,
    blocks,
    prev: date.minus({ days: 1 }).toFormat('yyyy-LL-dd'),
    next: date.plus({ days: 1 }).toFormat('yyyy-LL-dd'),
    today: DateTime.utc().toFormat('yyyy-LL-dd'),
    isManager: user.role === 'manager' || user.role === 'admin'
  });
}

function renderWeek(req: any, res: any, user: any) {
  const dateParam = req.query.date as string | undefined;
  const refDate = dateParam ? DateTime.fromISO(dateParam, { zone: 'utc' }) : DateTime.utc().startOf('day');
  if (!refDate.isValid) {
    res.status(400).render('error', { message: 'Fecha no valida', user });
    return;
  }

  const weekStart = refDate.startOf('week');
  const weekEnd = refDate.endOf('week');
  const startStr = weekStart.toFormat('yyyy-LL-dd');
  const endStr = weekEnd.toFormat('yyyy-LL-dd');

  const agents = listAgents();
  const agentByPid = new Map(agents.map(a => [a.planner_id, a]));
  const shifts = getAllShiftsForRange(startStr, endStr);

  const today = DateTime.utc().toFormat('yyyy-LL-dd');
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = weekStart.plus({ days: i });
    return {
      date: d.toFormat('yyyy-LL-dd'),
      dayCode: ['L', 'M', 'C', 'J', 'V', 'S', 'D'][i],
      dayName: d.setLocale('es').toFormat('ccc'),
      dayNum: d.day,
      isToday: d.toFormat('yyyy-LL-dd') === today
    };
  });

  // Build dept blocks: each block has shift rows × day cells with agent chips
  type AgentChip = { name: string; plannerId: number; colorIdx: number; native: boolean; nativeDept: string; custom: boolean; swapped: boolean };
  type Cell = { date: string; isToday: boolean; agents: AgentChip[] };
  type ShiftRow = { id: string; label: string; startHour: number; endHour: number; cells: Cell[] };
  type DeptBlock = { dept: string; rows: ShiftRow[] };

  // Stable color index per agent (so a given agent gets the same color across cells)
  const colorIndexFor = (id: number) => Math.abs(id * 2654435761 % 12);

  const blocks: DeptBlock[] = [];
  for (const dept of Object.keys(SHIFTS).sort()) { // L1, L2 alphabetical
    const shiftDefs = Object.values(SHIFTS[dept]);
    const rows: ShiftRow[] = shiftDefs.map(sh => ({
      id: sh.id,
      label: sh.label,
      startHour: sh.startHour,
      endHour: sh.endHour,
      cells: days.map(d => ({ date: d.date, isToday: d.isToday, agents: [] }))
    }));

    for (const s of shifts) {
      // Place shift in the row matching its native dept+shiftId; if a foreign-dept
      // agent covers another dept (eg L1 covers L2 shift), put them in that dept
      // block but mark non-native.
      if (s.dept !== dept) continue;
      const row = rows.find(r => r.id === s.shift.id);
      if (!row) continue;
      const dayIdx = days.findIndex(d => d.date === s.date);
      if (dayIdx < 0) continue;
      const a = agentByPid.get(s.planner_id);
      if (!a) continue;
      row.cells[dayIdx].agents.push({
        name: a.name,
        plannerId: s.planner_id,
        colorIdx: colorIndexFor(s.planner_id),
        native: a.dept === dept,
        nativeDept: a.dept,
        custom: s.startHour !== s.shift.startHour || s.endHour !== s.shift.endHour,
        swapped: s.source === 'swap'
      });
    }

    blocks.push({ dept, rows });
  }

  const cycle = cycleForDate(weekStart);
  res.render('horarios-week', {
    user,
    view: 'week',
    days,
    blocks,
    cycle,
    weekLabel: `${weekStart.toFormat('LL-dd')} → ${weekEnd.toFormat('LL-dd')}`,
    prev: weekStart.minus({ weeks: 1 }).toFormat('yyyy-LL-dd'),
    next: weekStart.plus({ weeks: 1 }).toFormat('yyyy-LL-dd'),
    today,
    isManager: user.role === 'manager' || user.role === 'admin'
  });
}

function renderMonth(req: any, res: any, user: any) {
  const monthParam = (req.query.month as string) || DateTime.utc().toFormat('yyyy-LL');
  const monthDate = DateTime.fromFormat(monthParam, 'yyyy-LL', { zone: 'utc' });
  if (!monthDate.isValid) {
    res.status(400).render('error', { message: 'Mes no valido (YYYY-MM)', user });
    return;
  }

  const monthStart = monthDate.startOf('month');
  const monthEnd = monthDate.endOf('month');
  const shifts = getAllShiftsForRange(monthStart.toFormat('yyyy-LL-dd'), monthEnd.toFormat('yyyy-LL-dd'));

  const agents = listAgents();
  const agentByPid = new Map(agents.map(a => [a.planner_id, a]));

  // Group by date → AGENT'S native dept → shift_id → count.
  // We count by native dept (not shift dept) because Diego wants to see
  // headcount by native dept regardless of cross-dept coverage.
  const byDate = new Map<string, Map<string, Map<string, number>>>();
  for (const s of shifts) {
    const a = agentByPid.get(s.planner_id);
    if (!a) continue;
    if (!byDate.has(s.date)) byDate.set(s.date, new Map());
    const dateMap = byDate.get(s.date)!;
    if (!dateMap.has(a.dept)) dateMap.set(a.dept, new Map());
    const deptMap = dateMap.get(a.dept)!;
    deptMap.set(s.shift.id, (deptMap.get(s.shift.id) ?? 0) + 1);
  }

  const firstDay = monthStart.startOf('week');
  const lastDay = monthEnd.endOf('week');

  type DeptSummary = { dept: string; total: number; shifts: { id: string; count: number }[] };
  type Cell = {
    date: string;
    dayNum: number;
    inMonth: boolean;
    isToday: boolean;
    depts: DeptSummary[];
    total: number;
  };
  const today = DateTime.utc().toFormat('yyyy-LL-dd');
  const weeks: Cell[][] = [];
  let cursor = firstDay;
  while (cursor <= lastDay) {
    const week: Cell[] = [];
    for (let i = 0; i < 7; i++) {
      const dateStr = cursor.toFormat('yyyy-LL-dd');
      const dateMap = byDate.get(dateStr);
      const depts: DeptSummary[] = dateMap
        ? Array.from(dateMap.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([dept, sm]) => ({
              dept,
              total: Array.from(sm.values()).reduce((s, n) => s + n, 0),
              shifts: Array.from(sm.entries())
                .map(([id, count]) => ({ id, count }))
                .sort((a, b) => a.id.localeCompare(b.id))
            }))
        : [];
      week.push({
        date: dateStr,
        dayNum: cursor.day,
        inMonth: cursor.month === monthStart.month,
        isToday: dateStr === today,
        depts,
        total: depts.reduce((s, d) => s + d.total, 0)
      });
      cursor = cursor.plus({ days: 1 });
    }
    weeks.push(week);
  }

  res.render('horarios-month', {
    user,
    view: 'month',
    monthLabel: monthStart.setLocale('es').toFormat('LLLL yyyy'),
    monthParam,
    prevMonth: monthStart.minus({ months: 1 }).toFormat('yyyy-LL'),
    nextMonth: monthStart.plus({ months: 1 }).toFormat('yyyy-LL'),
    weeks,
    isManager: user.role === 'manager'
  });
}
