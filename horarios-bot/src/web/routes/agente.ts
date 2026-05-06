import { Router } from 'express';
import { DateTime } from 'luxon';
import { config } from '../../config';
import { getAgentByPlannerId } from '../../services/agents';
import {
  getShiftsForAgentRange, getDaysOffForAgentRange, shiftWindow
} from '../../services/schedule';
import { getPunchesForShift } from '../../services/punches';
import { requireManager } from './auth';
import { getAgentBySlackId } from '../../services/agents';

export const agenteRouter = Router();

agenteRouter.get('/:plannerId', (req, res) => {
  const user = (req.session as any).user;
  const plannerId = parseInt(req.params.plannerId, 10);
  if (isNaN(plannerId)) {
    res.status(400).render('error', { message: 'planner_id invalido', user });
    return;
  }

  const agent = getAgentByPlannerId(plannerId);
  if (!agent) {
    res.status(404).render('error', { message: 'Agente no encontrado', user });
    return;
  }

  // #9a: manager/admin can see any drill-down. Agents can see their OWN.
  const isPriv = user?.role === 'manager' || user?.role === 'admin';
  if (!isPriv) {
    const own = getAgentBySlackId(user?.slack_id || '');
    if (!own || own.planner_id !== plannerId) {
      res.status(403).render('error', { message: 'Solo puedes ver tu propio detalle.', user });
      return;
    }
  }

  const monthParam = (req.query.month as string) || DateTime.utc().toFormat('yyyy-LL');
  const monthDate = DateTime.fromFormat(monthParam, 'yyyy-LL', { zone: 'utc' });
  if (!monthDate.isValid) {
    res.status(400).render('error', { message: 'Mes no valido (YYYY-MM)', user });
    return;
  }

  const monthStart = monthDate.startOf('month');
  const monthEnd = monthDate.endOf('month');
  const startStr = monthStart.toFormat('yyyy-LL-dd');
  const endStr = monthEnd.toFormat('yyyy-LL-dd');

  const shifts = getShiftsForAgentRange(plannerId, startStr, endStr);
  const daysOff = getDaysOffForAgentRange(plannerId, startStr, endStr);
  const dayOffSet = new Set(daysOff.map(d => d.date));

  const now = DateTime.utc();

  type Row = {
    date: string;
    dayName: string;
    isToday: boolean;
    kind: 'shift' | 'off' | 'empty';
    shift?: {
      dept: string; shiftId: string; label: string;
      startUtc: string; endUtc: string; custom: boolean; swapped: boolean;
      status: string; statusClass: string;
      punches: { type: string; ts: string; source: string; note: string | null }[];
      lateMin: number | null;
      breakExcessMin: number | null;
      forgotClockOut: boolean;
    };
    offReason?: string | null;
  };

  const rows: Row[] = [];
  let cursor = monthStart;
  while (cursor <= monthEnd) {
    const dateStr = cursor.toFormat('yyyy-LL-dd');
    const dayName = cursor.setLocale('es').toFormat('ccc dd');
    const isToday = dateStr === now.toFormat('yyyy-LL-dd');

    const sh = shifts.find(s => s.date === dateStr);
    if (sh) {
      const w = shiftWindow(cursor, sh);
      const punches = getPunchesForShift(agent.slack_id, dateStr, sh.shift.id);

      const clockIn = punches.find(p => p.type === 'clock_in');
      const clockOut = punches.find(p => p.type === 'clock_out');
      const breakIn = punches.find(p => p.type === 'break_in');
      const breakOut = punches.find(p => p.type === 'break_out');

      let status = 'Sin marcar';
      let statusClass = 'alert';

      if (now < w.start) {
        status = 'Programado';
        statusClass = 'upcoming';
      } else if (clockIn && clockOut) {
        status = 'Finalizado';
        statusClass = 'completed';
      } else if (clockIn && now < w.end) {
        status = breakIn && !breakOut ? 'En break' : 'En turno';
        statusClass = breakIn && !breakOut ? 'break' : 'active';
      } else if (clockIn && now >= w.end) {
        status = 'Sin clock out';
        statusClass = 'warning';
      } else if (now >= w.end) {
        status = 'Sin marcar';
        statusClass = 'alert';
      }

      let lateMin: number | null = null;
      if (clockIn) {
        const ts = DateTime.fromISO(clockIn.ts, { zone: 'utc' });
        const diff = Math.round(ts.diff(w.start, 'minutes').minutes);
        if (diff > 0) lateMin = diff;
      }

      let breakExcessMin: number | null = null;
      if (breakIn && breakOut) {
        const bIn = DateTime.fromISO(breakIn.ts, { zone: 'utc' });
        const bOut = DateTime.fromISO(breakOut.ts, { zone: 'utc' });
        const breakMin = Math.round(bOut.diff(bIn, 'minutes').minutes);
        if (breakMin > config.breakMaxMin) breakExcessMin = breakMin - config.breakMaxMin;
      }

      const forgotClockOut = !!(clockIn && !clockOut && now > w.end.plus({ hours: 4 }));

      rows.push({
        date: dateStr,
        dayName,
        isToday,
        kind: 'shift',
        shift: {
          dept: sh.dept,
          shiftId: sh.shift.id,
          label: sh.shift.label,
          startUtc: w.start.toFormat('HH:mm'),
          endUtc: w.end.toFormat('HH:mm'),
          custom: sh.startHour !== sh.shift.startHour || sh.endHour !== sh.shift.endHour,
          swapped: sh.source === 'swap',
          status, statusClass,
          punches: punches.map(p => ({
            type: p.type,
            ts: DateTime.fromISO(p.ts, { zone: 'utc' }).toFormat('HH:mm'),
            source: p.source,
            note: p.note
          })),
          lateMin, breakExcessMin, forgotClockOut
        }
      });
    } else if (dayOffSet.has(dateStr)) {
      const d = daysOff.find(x => x.date === dateStr)!;
      const isApprovedTimeOff = d.reason === 'vacaciones' || d.reason === 'permiso';
      // Only count days_off_entries with reason vacaciones/permiso as "time off".
      // 'rest' / 'time_off' / null come from planner imports and are just regular
      // days off (no shift scheduled) — render them as empty rather than as TO.
      if (isApprovedTimeOff) {
        rows.push({ date: dateStr, dayName, isToday, kind: 'off', offReason: d.reason });
      } else {
        rows.push({ date: dateStr, dayName, isToday, kind: 'empty' });
      }
    } else {
      rows.push({ date: dateStr, dayName, isToday, kind: 'empty' });
    }
    cursor = cursor.plus({ days: 1 });
  }

  // Aggregate stats for the month
  const stats = {
    shifts: shifts.length,
    // "Libres" = days with no shift assigned, regardless of whether the planner
    // marked them as rest. Approved time-off (vacaciones/permiso) counted separately.
    daysOff: rows.filter(r => r.kind === 'empty' || r.kind === 'off').length,
    timeOffDays: rows.filter(r => r.kind === 'off').length,
    late: rows.filter(r => r.shift?.lateMin && r.shift.lateMin > config.lateThresholdMin).length,
    breakExcess: rows.filter(r => r.shift?.breakExcessMin).length,
    forgotClockOut: rows.filter(r => r.shift?.forgotClockOut).length,
    completed: rows.filter(r => r.shift?.statusClass === 'completed').length,
    alerts: rows.filter(r => r.shift?.statusClass === 'alert').length
  };

  res.render('agente', {
    user,
    agent,
    rows,
    stats,
    monthLabel: monthStart.setLocale('es').toFormat('LLLL yyyy'),
    monthParam,
    prevMonth: monthStart.minus({ months: 1 }).toFormat('yyyy-LL'),
    nextMonth: monthStart.plus({ months: 1 }).toFormat('yyyy-LL')
  });
});
