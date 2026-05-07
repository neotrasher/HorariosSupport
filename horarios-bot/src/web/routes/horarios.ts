import { Router } from 'express';
import { DateTime } from 'luxon';
import type { App as SlackApp } from '@slack/bolt';
import { SHIFTS, config } from '../../config';
import { listAgents, getAgentBySlackId, getAgentByPlannerId } from '../../services/agents';
import {
  getAllShiftsForDate, getAllShiftsForRange, shiftWindow, cycleForDate,
  getAllDaysOffForDate, getAllDaysOffForRange,
  removeAgentFromShift, addAgentToShift, moveAgentShift
} from '../../services/schedule';
import { logAudit } from '../../services/audit';
import { buildHeatmap } from '../../services/coverageHeatmap';

type ViewMode = 'day' | 'week' | 'month';

/**
 * Returns a localized human label like "L1.M (00:00–08:00 UTC)" for a shift.
 */
function shiftLabel(dept: string, shiftId: string): string {
  const sh = SHIFTS[dept]?.[shiftId];
  if (!sh) return `${dept}.${shiftId}`;
  const fmt = (h: number) => (h % 24).toString().padStart(2, '0');
  return `${dept}.${shiftId} (${fmt(sh.startHour)}:00–${fmt(sh.endHour)}:00 UTC)`;
}

/**
 * Best-effort DM to the affected agent when a manager edits their shifts
 * from /horarios. Silent on failure (network, unlinked account, etc).
 */
async function dmAgentEdit(
  slackApp: SlackApp | null,
  plannerId: number,
  managerName: string,
  payload:
    | { action: 'add'; date: string; dept: string; shiftId: string }
    | { action: 'remove'; date: string; dept: string; shiftId: string }
    | { action: 'move'; date: string; fromDept: string; fromShiftId: string; toDept: string; toShiftId: string }
) {
  if (!slackApp) return;
  const agent = getAgentByPlannerId(plannerId);
  if (!agent || !agent.slack_id) return;
  let text = '';
  if (payload.action === 'add') {
    text = `📅 *${managerName}* te agregó al turno *${shiftLabel(payload.dept, payload.shiftId)}* del *${payload.date}*.`;
  } else if (payload.action === 'remove') {
    text = `📅 *${managerName}* te quitó del turno *${shiftLabel(payload.dept, payload.shiftId)}* del *${payload.date}*.`;
  } else {
    text = `📅 *${managerName}* movió tu turno del *${payload.date}*: ~${shiftLabel(payload.fromDept, payload.fromShiftId)}~ → *${shiftLabel(payload.toDept, payload.toShiftId)}*.`;
  }
  try {
    const im = await slackApp.client.conversations.open({ users: agent.slack_id });
    const ch = (im as any).channel?.id;
    if (ch) {
      await slackApp.client.chat.postMessage({
        channel: ch,
        text,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `_Cambio manual desde Horarios web · ${DateTime.utc().toFormat('yyyy-LL-dd HH:mm')} UTC_` }] }
        ]
      });
    }
  } catch (e) {
    console.error(`[horarios edit] failed to DM agent ${agent.slack_id}:`, e);
  }
}

export function buildHorariosRouter(slackApp: SlackApp | null = null): Router {
  const horariosRouter = Router();

/**
 * Coverage heatmap. Shows agents-per-hour grid for a given month.
 * Optional ?dept=L1|L2 filters to one dept; default = all.
 */
horariosRouter.get('/heatmap', (req, res) => {
  const user = (req.session as any).user;
  const monthParam = (req.query.month as string) || DateTime.utc().toFormat('yyyy-LL');
  const monthDate = DateTime.fromFormat(monthParam, 'yyyy-LL', { zone: 'utc' });
  if (!monthDate.isValid) {
    res.status(400).render('error', { message: 'Mes invalido (YYYY-MM)', user });
    return;
  }
  const dept = ((req.query.dept as string) || '').trim() || null;
  const startDate = monthDate.startOf('month').toFormat('yyyy-LL-dd');
  const endDate = monthDate.endOf('month').toFormat('yyyy-LL-dd');
  const heatmap = buildHeatmap({ startDate, endDate, dept });
  res.render('horarios-heatmap', {
    user,
    view: 'heatmap',
    currentDate: startDate,
    monthParam,
    monthLabel: monthDate.setLocale('es').toFormat('LLLL yyyy'),
    prevMonth: monthDate.minus({ months: 1 }).toFormat('yyyy-LL'),
    nextMonth: monthDate.plus({ months: 1 }).toFormat('yyyy-LL'),
    dept,
    heatmap
  });
});

/**
 * Manual edit endpoint (manager/admin only). Accepts JSON:
 *   { action:'add'|'remove'|'move', plannerId, date, shiftId, dept, [toShiftId, toDept] }
 * On success, DMs the affected agent (best-effort) so they know about the change.
 */
horariosRouter.post('/edit', async (req, res) => {
  const user = (req.session as any).user;
  if (user?.role !== 'manager' && user?.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const { action, plannerId, date, shiftId, dept } = req.body || {};
  const pid = parseInt(plannerId, 10);
  if (!action || !pid || !date || !shiftId || !dept) {
    return res.status(400).json({ ok: false, error: 'missing fields' });
  }
  if (!SHIFTS[dept] || !SHIFTS[dept][shiftId]) {
    return res.status(400).json({ ok: false, error: 'invalid shift' });
  }
  try {
    const agentForLog = getAgentByPlannerId(pid);
    const targetName = agentForLog?.name || `pid#${pid}`;
    if (action === 'remove') {
      const n = removeAgentFromShift(pid, date, shiftId, dept);
      if (n > 0) {
        await dmAgentEdit(slackApp, pid, user?.name || 'manager', { action: 'remove', date, dept, shiftId });
        logAudit({
          actorSlackId: user.slack_id, actorName: user.name,
          action: 'shift.remove',
          targetKind: 'agent', targetId: String(pid),
          summary: `Quito a ${targetName} de ${dept}.${shiftId} el ${date}`,
          payload: { plannerId: pid, agentName: targetName, date, dept, shiftId }
        });
      }
      return res.json({ ok: true, removed: n });
    }
    if (action === 'add') {
      const ok = addAgentToShift({ plannerId: pid, date, shiftId, dept });
      if (ok) {
        await dmAgentEdit(slackApp, pid, user?.name || 'manager', { action: 'add', date, dept, shiftId });
        logAudit({
          actorSlackId: user.slack_id, actorName: user.name,
          action: 'shift.add',
          targetKind: 'agent', targetId: String(pid),
          summary: `Agrego a ${targetName} a ${dept}.${shiftId} el ${date}`,
          payload: { plannerId: pid, agentName: targetName, date, dept, shiftId }
        });
      }
      return res.json({ ok: true, added: ok });
    }
    if (action === 'move') {
      const { toShiftId, toDept } = req.body || {};
      if (!toShiftId || !toDept) return res.status(400).json({ ok: false, error: 'missing to_*' });
      if (!SHIFTS[toDept] || !SHIFTS[toDept][toShiftId]) {
        return res.status(400).json({ ok: false, error: 'invalid target shift' });
      }
      const result = moveAgentShift({
        plannerId: pid, date,
        fromShiftId: shiftId, fromDept: dept,
        toShiftId, toDept
      });
      if (result.removed > 0 || result.added) {
        await dmAgentEdit(slackApp, pid, user?.name || 'manager', {
          action: 'move', date,
          fromDept: dept, fromShiftId: shiftId,
          toDept, toShiftId
        });
        logAudit({
          actorSlackId: user.slack_id, actorName: user.name,
          action: 'shift.move',
          targetKind: 'agent', targetId: String(pid),
          summary: `Movio a ${targetName} de ${dept}.${shiftId} -> ${toDept}.${toShiftId} el ${date}`,
          payload: { plannerId: pid, agentName: targetName, date, fromDept: dept, fromShiftId: shiftId, toDept, toShiftId }
        });
      }
      return res.json({ ok: true, ...result });
    }
    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'error' });
  }
});

horariosRouter.get('/', (req, res) => {
  const user = (req.session as any).user;
  const view = ((req.query.view as string) || 'week') as ViewMode;

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

  const dateStr = date.toFormat('yyyy-LL-dd');

  // Resolve viewer's timezone for the local-hour display toggle
  const viewerAgent = getAgentBySlackId(user?.slack_id || '');
  const localTz = (viewerAgent?.timezone) || (config as any).displayTimezone || 'UTC';

  // For each shift row, compute UTC and local hour windows
  for (const block of blocks) {
    for (const row of block.rows as any[]) {
      const startDt = date.startOf('day').plus({ hours: row.startHour });
      const endDt   = date.startOf('day').plus({ hours: row.endHour });
      row.startUtcStr   = startDt.toFormat('HH:mm');
      row.endUtcStr     = endDt.toFormat('HH:mm');
      row.startLocalStr = startDt.setZone(localTz).toFormat('HH:mm');
      row.endLocalStr   = endDt.setZone(localTz).toFormat('HH:mm');
    }
  }

  // Collect agents off-duty (vacaciones / permiso) on this date
  const offRows = getAllDaysOffForDate(dateStr);
  type OffAgent = { name: string; plannerId: number; dept: string; reason: string | null; isVac: boolean };
  const offAgents: OffAgent[] = offRows
    .map(o => {
      const a = agentByPid.get(o.planner_id);
      if (!a) return null;
      return {
        name: a.name, plannerId: o.planner_id, dept: a.dept,
        reason: o.reason, isVac: (o.reason || '').toLowerCase() === 'vacaciones'
      } as OffAgent;
    })
    .filter((x): x is OffAgent => !!x)
    .sort((a, b) => a.dept.localeCompare(b.dept) || a.name.localeCompare(b.name));

  res.render('horarios-day', {
    user,
    view: 'day',
    dateStr,
    currentDate: dateStr,
    dateLabelLocal: date.setLocale('es').toFormat('cccc d LLLL yyyy'),
    cycle,
    blocks,
    offAgents,
    localTz,
    allAgents: agents
      .filter(a => a.active !== 0)
      .map(a => ({ plannerId: a.planner_id, name: a.name, dept: a.dept }))
      .sort((a, b) => a.dept.localeCompare(b.dept) || a.name.localeCompare(b.name)),
    shiftDefs: Object.keys(SHIFTS).sort().flatMap(d =>
      Object.values(SHIFTS[d]).map(s => ({
        dept: d, id: s.id, label: s.label, startHour: s.startHour, endHour: s.endHour
      }))
    ),
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

  // Compute UTC + local hour windows for each shift row (week view)
  const viewerAgentW = getAgentBySlackId(user?.slack_id || '');
  const localTzW = (viewerAgentW?.timezone) || (config as any).displayTimezone || 'UTC';
  const refForWindow = weekStart.startOf('day');
  for (const block of blocks) {
    for (const row of block.rows as any[]) {
      const startDt = refForWindow.plus({ hours: row.startHour });
      const endDt   = refForWindow.plus({ hours: row.endHour });
      row.startUtcStr   = startDt.toFormat('HH:mm');
      row.endUtcStr     = endDt.toFormat('HH:mm');
      row.startLocalStr = startDt.setZone(localTzW).toFormat('HH:mm');
      row.endLocalStr   = endDt.setZone(localTzW).toFormat('HH:mm');
    }
  }

  // Agents off-duty per day for this week
  type OffAgent = { name: string; plannerId: number; dept: string; reason: string | null; isVac: boolean };
  const offByDate = new Map<string, OffAgent[]>();
  for (const o of getAllDaysOffForRange(startStr, endStr)) {
    const a = agentByPid.get(o.planner_id);
    if (!a) continue;
    const arr = offByDate.get(o.date) || [];
    arr.push({
      name: a.name, plannerId: o.planner_id, dept: a.dept,
      reason: o.reason, isVac: (o.reason || '').toLowerCase() === 'vacaciones'
    });
    offByDate.set(o.date, arr);
  }
  const offRow = days.map(d => ({
    date: d.date, isToday: d.isToday,
    agents: (offByDate.get(d.date) || []).sort((a, b) => a.dept.localeCompare(b.dept) || a.name.localeCompare(b.name))
  }));

  const cycle = cycleForDate(weekStart);
  res.render('horarios-week', {
    user,
    view: 'week',
    days,
    blocks,
    offRow,
    cycle,
    localTz: localTzW,
    allAgents: agents
      .filter(a => a.active !== 0)
      .map(a => ({ plannerId: a.planner_id, name: a.name, dept: a.dept }))
      .sort((a, b) => a.dept.localeCompare(b.dept) || a.name.localeCompare(b.name)),
    currentDate: refDate.toFormat('yyyy-LL-dd'),
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
    currentDate: monthStart.toFormat('yyyy-LL-dd'),
    prevMonth: monthStart.minus({ months: 1 }).toFormat('yyyy-LL'),
    nextMonth: monthStart.plus({ months: 1 }).toFormat('yyyy-LL'),
    weeks,
    isManager: user.role === 'manager'
  });
}

  return horariosRouter;
}
