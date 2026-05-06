import { Router } from 'express';
import { DateTime } from 'luxon';
import { config } from '../../config';
import { getAgentBySlackId } from '../../services/agents';
import {
  getShiftsForAgentRange, getDaysOffForAgentRange, shiftWindow
} from '../../services/schedule';

export const miHorarioRouter = Router();

miHorarioRouter.get('/', (req, res) => {
  const user = (req.session as any).user;
  const agent = getAgentBySlackId(user.slack_id);

  const monthParam = (req.query.month as string) || DateTime.utc().toFormat('yyyy-LL');
  const monthDate = DateTime.fromFormat(monthParam, 'yyyy-LL', { zone: 'utc' });
  if (!monthDate.isValid) {
    res.status(400).render('error', { message: 'Mes no valido (formato YYYY-MM)', user });
    return;
  }

  const monthStart = monthDate.startOf('month');
  const monthEnd = monthDate.endOf('month');
  const startStr = monthStart.toFormat('yyyy-LL-dd');
  const endStr = monthEnd.toFormat('yyyy-LL-dd');

  const shifts = agent ? getShiftsForAgentRange(agent.planner_id, startStr, endStr) : [];
  const daysOff = agent ? getDaysOffForAgentRange(agent.planner_id, startStr, endStr) : [];

  const shiftByDate = new Map<string, typeof shifts[number]>();
  for (const s of shifts) shiftByDate.set(s.date, s);
  const dayOffSet = new Set(daysOff.map(d => d.date));

  // Build calendar grid: weeks starting Monday
  const firstDay = monthStart.startOf('week'); // Luxon: Monday
  const lastDay = monthEnd.endOf('week');
  type Cell = {
    date: string;
    dayNum: number;
    inMonth: boolean;
    isToday: boolean;
    shift?: {
      dept: string; shiftId: string; label: string;
      startUtc: string; endUtc: string;
      startLocal: string; endLocal: string;
      custom: boolean; swapped: boolean;
    };
    dayOff?: { reason: string | null };
  };

  // Resolve which timezone to display "local" hours in. Priority:
  //   1. agent.timezone (per-agent override)
  //   2. system displayTimezone setting
  //   3. UTC
  const localTz = (agent?.timezone) || config.displayTimezone || 'UTC';

  const today = DateTime.utc().toFormat('yyyy-LL-dd');
  const weeks: Cell[][] = [];
  let cursor = firstDay;
  while (cursor <= lastDay) {
    const week: Cell[] = [];
    for (let i = 0; i < 7; i++) {
      const dateStr = cursor.toFormat('yyyy-LL-dd');
      const cell: Cell = {
        date: dateStr,
        dayNum: cursor.day,
        inMonth: cursor.month === monthStart.month,
        isToday: dateStr === today
      };
      const sh = shiftByDate.get(dateStr);
      if (sh) {
        const w = shiftWindow(cursor, sh);
        cell.shift = {
          dept: sh.dept,
          shiftId: sh.shift.id,
          label: sh.shift.label,
          startUtc:   w.start.toFormat('HH:mm'),
          endUtc:     w.end.toFormat('HH:mm'),
          startLocal: w.start.setZone(localTz).toFormat('HH:mm'),
          endLocal:   w.end.setZone(localTz).toFormat('HH:mm'),
          custom: sh.startHour !== sh.shift.startHour || sh.endHour !== sh.shift.endHour,
          swapped: sh.source === 'swap'
        };
      } else if (dayOffSet.has(dateStr)) {
        const d = daysOff.find(x => x.date === dateStr)!;
        cell.dayOff = { reason: d.reason };
      }
      week.push(cell);
      cursor = cursor.plus({ days: 1 });
    }
    weeks.push(week);
  }

  const totalShifts = shifts.length;
  const totalDaysOff = daysOff.length;
  const isEmpty = totalShifts === 0 && totalDaysOff === 0;

  res.render('mi-horario', {
    user,
    agent,
    monthLabel: monthStart.setLocale('es').toFormat('LLLL yyyy'),
    monthParam,
    prevMonth: monthStart.minus({ months: 1 }).toFormat('yyyy-LL'),
    nextMonth: monthStart.plus({ months: 1 }).toFormat('yyyy-LL'),
    weeks,
    totalShifts,
    totalDaysOff,
    isEmpty,
    localTz
  });
});
