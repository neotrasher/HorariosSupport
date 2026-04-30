import { Router } from 'express';
import { DateTime } from 'luxon';
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

  const groups = new Map<string, typeof shifts>();
  for (const s of shifts) {
    const key = `${s.dept}|${s.shift.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  const shiftRows = Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => {
      const [dept, shiftId] = key.split('|');
      const sample = list[0];
      const w = shiftWindow(date, sample);
      return {
        dept, shiftId, label: sample.shift.label,
        startUtc: w.start.toFormat('HH:mm'),
        endUtc: w.end.toFormat('HH:mm'),
        agents: list
          .map(s => ({ name: agentByPid.get(s.planner_id)?.name || `#${s.planner_id}`, plannerId: s.planner_id }))
          .sort((a, b) => a.name.localeCompare(b.name))
      };
    });

  res.render('horarios-day', {
    user,
    view: 'day',
    dateStr: date.toFormat('yyyy-LL-dd'),
    cycle,
    shiftRows,
    prev: date.minus({ days: 1 }).toFormat('yyyy-LL-dd'),
    next: date.plus({ days: 1 }).toFormat('yyyy-LL-dd'),
    today: DateTime.utc().toFormat('yyyy-LL-dd'),
    isManager: user.role === 'manager'
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
  const shifts = getAllShiftsForRange(startStr, endStr);

  // Build matrix: [agent][dayIndex] -> shift|null
  const days: { date: string; dayCode: string; dayName: string; isToday: boolean }[] = [];
  const today = DateTime.utc().toFormat('yyyy-LL-dd');
  for (let i = 0; i < 7; i++) {
    const d = weekStart.plus({ days: i });
    days.push({
      date: d.toFormat('yyyy-LL-dd'),
      dayCode: ['L', 'M', 'C', 'J', 'V', 'S', 'D'][i],
      dayName: d.setLocale('es').toFormat('ccc d'),
      isToday: d.toFormat('yyyy-LL-dd') === today
    });
  }

  const shiftByPidDate = new Map<string, typeof shifts[number]>();
  for (const s of shifts) shiftByPidDate.set(`${s.planner_id}|${s.date}`, s);

  type Row = {
    name: string;
    plannerId: number;
    dept: string;
    cells: ({
      shiftId: string; dept: string; label: string; startUtc: string; endUtc: string; custom: boolean;
    } | null)[];
  };

  const rows: Row[] = agents.map(a => {
    const cells = days.map(d => {
      const s = shiftByPidDate.get(`${a.planner_id}|${d.date}`);
      if (!s) return null;
      const w = shiftWindow(DateTime.fromISO(d.date, { zone: 'utc' }), s);
      return {
        shiftId: s.shift.id,
        dept: s.dept,
        label: s.shift.label,
        startUtc: w.start.toFormat('HH:mm'),
        endUtc: w.end.toFormat('HH:mm'),
        custom: s.startHour !== s.shift.startHour || s.endHour !== s.shift.endHour
      };
    });
    return { name: a.name, plannerId: a.planner_id, dept: a.dept, cells };
  });

  rows.sort((a, b) => (a.dept + a.name).localeCompare(b.dept + b.name));

  const cycle = cycleForDate(weekStart);
  res.render('horarios-week', {
    user,
    view: 'week',
    days,
    rows,
    cycle,
    weekLabel: `${weekStart.toFormat('LL-dd')} → ${weekEnd.toFormat('LL-dd')}`,
    prev: weekStart.minus({ weeks: 1 }).toFormat('yyyy-LL-dd'),
    next: weekStart.plus({ weeks: 1 }).toFormat('yyyy-LL-dd'),
    today,
    isManager: user.role === 'manager'
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

  // Group shifts by date → dept|shift → count
  const byDate = new Map<string, Map<string, number>>();
  for (const s of shifts) {
    if (!byDate.has(s.date)) byDate.set(s.date, new Map());
    const m = byDate.get(s.date)!;
    const key = `${s.dept}.${s.shift.id}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }

  const firstDay = monthStart.startOf('week');
  const lastDay = monthEnd.endOf('week');

  type Cell = {
    date: string;
    dayNum: number;
    inMonth: boolean;
    isToday: boolean;
    groups: { key: string; count: number }[];
    total: number;
  };
  const today = DateTime.utc().toFormat('yyyy-LL-dd');
  const weeks: Cell[][] = [];
  let cursor = firstDay;
  while (cursor <= lastDay) {
    const week: Cell[] = [];
    for (let i = 0; i < 7; i++) {
      const dateStr = cursor.toFormat('yyyy-LL-dd');
      const m = byDate.get(dateStr);
      const groups = m ? Array.from(m.entries()).map(([k, v]) => ({ key: k, count: v })).sort((a, b) => a.key.localeCompare(b.key)) : [];
      week.push({
        date: dateStr,
        dayNum: cursor.day,
        inMonth: cursor.month === monthStart.month,
        isToday: dateStr === today,
        groups,
        total: groups.reduce((s, g) => s + g.count, 0)
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
