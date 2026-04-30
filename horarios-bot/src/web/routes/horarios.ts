import { Router } from 'express';
import { DateTime } from 'luxon';
import { config } from '../../config';
import { listAgents } from '../../services/agents';
import { getAllShiftsForDate, shiftWindow, cycleForDate } from '../../services/schedule';

export const horariosRouter = Router();

horariosRouter.get('/', (req, res) => {
  const user = (req.session as any).user;
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

  type ShiftRow = {
    dept: string; shiftId: string; label: string;
    startUtc: string; endUtc: string; agents: string[];
  };

  const groups = new Map<string, typeof shifts>();
  for (const s of shifts) {
    const key = `${s.dept}|${s.shift.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  const shiftRows: ShiftRow[] = Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => {
      const [dept, shiftId] = key.split('|');
      const sample = list[0];
      const w = shiftWindow(date, sample);
      return {
        dept, shiftId, label: sample.shift.label,
        startUtc: w.start.toFormat('HH:mm'),
        endUtc: w.end.toFormat('HH:mm'),
        agents: list.map(s => agentByPid.get(s.planner_id)?.name || `#${s.planner_id}`).sort()
      };
    });

  const prev = date.minus({ days: 1 }).toFormat('yyyy-LL-dd');
  const next = date.plus({ days: 1 }).toFormat('yyyy-LL-dd');

  res.render('horarios', {
    user,
    dateStr: date.toFormat('yyyy-LL-dd'),
    cycle,
    shiftRows,
    prev,
    next,
    isManager: user.role === 'manager'
  });
});
