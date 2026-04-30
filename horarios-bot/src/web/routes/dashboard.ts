import { Router } from 'express';
import { DateTime } from 'luxon';
import { config } from '../../config';
import { listAgents } from '../../services/agents';
import { getAllShiftsForDate, shiftWindow } from '../../services/schedule';
import { getShiftState } from '../../services/punches';

export const dashboardRouter = Router();

dashboardRouter.get('/', (req, res) => {
  const user = (req.session as any).user;
  const now = DateTime.utc();
  const today = now.startOf('day');
  const yesterday = today.minus({ days: 1 });

  const agents = listAgents();
  const agentByPid = new Map(agents.map(a => [a.planner_id, a]));

  const shiftsToday = getAllShiftsForDate(today);
  const shiftsYesterday = getAllShiftsForDate(yesterday);

  type Row = {
    agent: string; dept: string; shiftLabel: string;
    startUtc: string; endUtc: string; status: string; statusClass: string;
  };

  const rows: Row[] = [];

  const processShift = (s: typeof shiftsToday[number], baseDate: DateTime) => {
    const w = shiftWindow(baseDate, s);
    const agent = agentByPid.get(s.planner_id);
    if (!agent) return;
    const shiftDate = baseDate.toFormat('yyyy-LL-dd');
    const state = getShiftState(agent.slack_id, shiftDate, s.shift.id);

    let status = '';
    let statusClass = '';

    if (now < w.start) {
      const mins = Math.round(w.start.diff(now, 'minutes').minutes);
      if (mins > 60) return;
      status = `Inicia en ${mins}m`;
      statusClass = 'upcoming';
    } else if (now > w.end) {
      if (state === 'completed') { status = 'Finalizado'; statusClass = 'completed'; }
      else if (state === 'in' || state === 'on_break') {
        const over = Math.round(now.diff(w.end, 'minutes').minutes);
        status = `Sin clock out (+${over}m)`;
        statusClass = 'warning';
      } else return;
    } else {
      if (state === 'in') { status = 'En turno'; statusClass = 'active'; }
      else if (state === 'on_break') { status = 'En break'; statusClass = 'break'; }
      else if (state === 'completed') { status = 'Finalizado (temprano)'; statusClass = 'completed'; }
      else {
        const late = Math.round(now.diff(w.start, 'minutes').minutes);
        status = `Sin marcar (+${late}m)`;
        statusClass = 'alert';
      }
    }

    rows.push({
      agent: agent.name, dept: s.dept, shiftLabel: `${s.shift.id} ${s.shift.label}`,
      startUtc: w.start.toFormat('HH:mm'), endUtc: w.end.toFormat('HH:mm'),
      status, statusClass
    });
  };

  for (const s of shiftsToday) processShift(s, today);
  for (const s of shiftsYesterday) {
    if (s.endHour > 24) processShift(s, yesterday);
  }

  const statusOrder: Record<string, number> = { alert: 0, warning: 1, active: 2, break: 3, upcoming: 4, completed: 5 };
  rows.sort((a, b) => (statusOrder[a.statusClass] ?? 9) - (statusOrder[b.statusClass] ?? 9));

  const counts = {
    active: rows.filter(r => r.statusClass === 'active' || r.statusClass === 'break').length,
    alert: rows.filter(r => r.statusClass === 'alert').length,
    warning: rows.filter(r => r.statusClass === 'warning').length,
    completed: rows.filter(r => r.statusClass === 'completed').length,
    upcoming: rows.filter(r => r.statusClass === 'upcoming').length,
    total: agents.length
  };

  res.render('dashboard', {
    user,
    now: now.toFormat('yyyy-LL-dd HH:mm'),
    rows,
    counts,
    isManager: user.role === 'manager'
  });
});
