import { Router } from 'express';
import { DateTime } from 'luxon';
import { config } from '../../config';
import { listAgents } from '../../services/agents';
import { getAllShiftsForDate, shiftWindow } from '../../services/schedule';
import { getShiftState } from '../../services/punches';
import { computeAdminInsights } from '../../services/adminInsights';

export const dashboardRouter = Router();

dashboardRouter.get('/', (req, res) => {
  const user = (req.session as any).user;

  // #7b: viewers (logged-in via Slack but not linked to an agent and not
  // in manager/admin lists) see a minimal page asking them to get linked,
  // not the live operational dashboard.
  if (user.role === 'viewer') {
    res.render('dashboard-unlinked', { user });
    return;
  }

  const now = DateTime.utc();
  const today = now.startOf('day');
  const yesterday = today.minus({ days: 1 });
  const tomorrow = today.plus({ days: 1 });

  const agents = listAgents();
  const agentByPid = new Map(agents.map(a => [a.planner_id, a]));

  const shiftsToday = getAllShiftsForDate(today);
  const shiftsYesterday = getAllShiftsForDate(yesterday);
  const shiftsTomorrow = getAllShiftsForDate(tomorrow);

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
      if (mins > 8 * 60) return;
      if (mins >= 60) {
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        status = m ? `Inicia en ${h}h${m}m` : `Inicia en ${h}h`;
      } else {
        status = `Inicia en ${mins}m`;
      }
      statusClass = 'upcoming';
    } else if (now > w.end) {
      const hoursAgo = now.diff(w.end, 'hours').hours;
      if (state === 'completed') {
        if (hoursAgo > 8) return;
        status = 'Finalizado';
        statusClass = 'completed';
      }
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
  // Process all of yesterday's shifts so we catch:
  //  - overnight shifts still active (e.g., L2.N 19→27)
  //  - regular shifts that finished within the last 8h (Finalizados window)
  for (const s of shiftsYesterday) processShift(s, yesterday);
  // Tomorrow's shifts that might be within the 8h upcoming window
  // (e.g., L1.M at 00:00 UTC seen from 22:00 UTC today).
  for (const s of shiftsTomorrow) processShift(s, tomorrow);

  const statusOrder: Record<string, number> = { alert: 0, warning: 1, completed: 2, active: 3, break: 4, upcoming: 5 };
  rows.sort((a, b) => (statusOrder[a.statusClass] ?? 9) - (statusOrder[b.statusClass] ?? 9));

  const counts = {
    active: rows.filter(r => r.statusClass === 'active' || r.statusClass === 'break').length,
    alert: rows.filter(r => r.statusClass === 'alert').length,
    warning: rows.filter(r => r.statusClass === 'warning').length,
    completed: rows.filter(r => r.statusClass === 'completed').length,
    upcoming: rows.filter(r => r.statusClass === 'upcoming').length,
    total: agents.length
  };

  // Admin/manager-only insights panel — computed only when needed
  const isPriv = user.role === 'manager' || user.role === 'admin';
  const insights = isPriv ? computeAdminInsights() : null;

  res.render('dashboard', {
    user,
    now: now.toFormat('yyyy-LL-dd HH:mm'),
    rows,
    counts,
    isManager: user.role === 'manager',
    isAdmin: user.role === 'admin',
    insights
  });
});
