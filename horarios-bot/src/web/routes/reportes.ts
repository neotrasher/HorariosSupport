import { Router } from 'express';
import { DateTime } from 'luxon';
import { buildReports } from '../../services/reports';
import { requireManager } from './auth';

export const reportesRouter = Router();

reportesRouter.use(requireManager);

/** CSV export of the same data the table shows. */
reportesRouter.get('/export.csv', (req, res) => {
  const now = DateTime.utc();
  const preset = (req.query.preset as string) || '';
  const startQ = (req.query.start as string) || '';
  const endQ = (req.query.end as string) || '';
  let start: DateTime, end: DateTime;
  if (preset) {
    const r = resolvePreset(preset, now);
    if (!r) return res.status(400).send('preset invalido');
    start = r.start; end = r.end;
  } else if (startQ && endQ) {
    start = DateTime.fromISO(startQ, { zone: 'utc' });
    end = DateTime.fromISO(endQ, { zone: 'utc' });
    if (!start.isValid || !end.isValid || end < start) return res.status(400).send('rango invalido');
  } else {
    start = now.startOf('month'); end = now.endOf('month');
  }
  const startStr = start.toFormat('yyyy-LL-dd');
  const endStr = end.toFormat('yyyy-LL-dd');

  const filterDept = ((req.query.dept as string) || '').trim();
  const filterAgent = ((req.query.agent as string) || '').trim();

  let rows = buildReports(startStr, endStr);
  if (filterDept) rows = rows.filter(r => r.agent.dept === filterDept);
  if (filterAgent) {
    const pid = parseInt(filterAgent, 10);
    if (!isNaN(pid)) rows = rows.filter(r => r.agent.planner_id === pid);
  }

  // CSV with UTF-8 BOM so Excel detects encoding correctly
  const headers = [
    'Agente', 'Slack ID', 'Dept', 'Turnos', 'Completos', 'Sin marcar',
    'Sin marcar (fechas)', 'Tardanzas', 'Min tarde', 'Tardanzas (detalle)',
    'Excesos break', 'Min exceso', 'Excesos break (detalle)',
    'Auto-clockouts', 'Auto-clockouts (fechas)',
    'Dias permiso', 'Dias vacaciones', 'Horas trabajadas'
  ];
  const escape = (v: any) => {
    const s = v === null || v === undefined ? '' : String(v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [headers.map(escape).join(',')];
  for (const r of rows) {
    lines.push([
      r.agent.name, r.agent.slack_id, r.agent.dept,
      r.shifts, r.completed, r.unmarked.count,
      r.unmarked.dates.join('; '),
      r.late.count, r.late.totalMin,
      r.late.incidents.map((i: any) => `${i.date}+${i.min}m`).join('; '),
      r.breakExcess.count, r.breakExcess.totalMin,
      r.breakExcess.incidents.map((i: any) => `${i.date}+${i.min}m`).join('; '),
      r.autoClockouts.count,
      r.autoClockouts.dates.join('; '),
      r.permisoDays, r.vacationDays, r.hoursWorked.toFixed(2)
    ].map(escape).join(','));
  }
  const csv = '﻿' + lines.join('\r\n');
  const fname = `reporte_${startStr}_a_${endStr}${filterDept ? '_' + filterDept : ''}${filterAgent ? '_ag' + filterAgent : ''}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(csv);
});

reportesRouter.get('/', (req, res) => {
  const user = (req.session as any).user;
  const now = DateTime.utc();

  // Resolve range. Priority: ?preset=... → fixed shortcut, ?start/end → custom,
  // otherwise default to current month.
  const preset = (req.query.preset as string) || '';
  const startQ = (req.query.start as string) || '';
  const endQ = (req.query.end as string) || '';

  let start: DateTime;
  let end: DateTime;
  let presetActive = preset;

  if (preset) {
    const r = resolvePreset(preset, now);
    if (!r) {
      res.status(400).render('error', { message: 'Preset invalido', user });
      return;
    }
    start = r.start;
    end = r.end;
  } else if (startQ && endQ) {
    start = DateTime.fromISO(startQ, { zone: 'utc' });
    end = DateTime.fromISO(endQ, { zone: 'utc' });
    if (!start.isValid || !end.isValid || end < start) {
      res.status(400).render('error', { message: 'Rango invalido', user });
      return;
    }
  } else {
    start = now.startOf('month');
    end = now.endOf('month');
    presetActive = 'this-month';
  }

  const startStr = start.toFormat('yyyy-LL-dd');
  const endStr = end.toFormat('yyyy-LL-dd');

  const filterDept = ((req.query.dept as string) || '').trim();
  const filterAgent = ((req.query.agent as string) || '').trim();

  const allRows = buildReports(startStr, endStr);

  const deptOptions = Array.from(new Set(allRows.map(r => r.agent.dept))).sort();
  const agentOptions = allRows
    .map(r => ({ planner_id: r.agent.planner_id, name: r.agent.name, dept: r.agent.dept }))
    .sort((a, b) => (a.dept + a.name).localeCompare(b.dept + b.name));

  let rows = allRows;
  if (filterDept) rows = rows.filter(r => r.agent.dept === filterDept);
  if (filterAgent) {
    const pid = parseInt(filterAgent, 10);
    if (!isNaN(pid)) rows = rows.filter(r => r.agent.planner_id === pid);
  }

  const totals = aggregate(rows);
  const byDept: Record<string, ReturnType<typeof aggregate>> = {};
  for (const r of rows) {
    if (!byDept[r.agent.dept]) byDept[r.agent.dept] = aggregate([]);
    byDept[r.agent.dept] = aggregate(rows.filter(x => x.agent.dept === r.agent.dept));
  }

  // For prev/next, shift by the SAME length as the current range
  const lengthDays = Math.round(end.diff(start, 'days').days) + 1;
  const prevStart = start.minus({ days: lengthDays });
  const prevEnd = end.minus({ days: lengthDays });
  const nextStart = start.plus({ days: lengthDays });
  const nextEnd = end.plus({ days: lengthDays });

  const rangeLabel = formatRangeLabel(start, end);

  res.render('reportes', {
    user,
    rows, totals, byDept,
    rangeLabel,
    startStr, endStr,
    prevStart: prevStart.toFormat('yyyy-LL-dd'),
    prevEnd: prevEnd.toFormat('yyyy-LL-dd'),
    nextStart: nextStart.toFormat('yyyy-LL-dd'),
    nextEnd: nextEnd.toFormat('yyyy-LL-dd'),
    presetActive,
    filterDept, filterAgent,
    deptOptions, agentOptions
  });
});

const PRESETS = [
  { key: 'this-month', label: 'Este mes' },
  { key: 'last-month', label: 'Mes pasado' },
  { key: 'this-week', label: 'Esta semana' },
  { key: 'last-week', label: 'Semana pasada' },
  { key: 'last-7', label: 'Ultimos 7 dias' },
  { key: 'last-30', label: 'Ultimos 30 dias' }
];
(reportesRouter as any).PRESETS = PRESETS;
export { PRESETS };

function resolvePreset(key: string, now: DateTime): { start: DateTime; end: DateTime } | null {
  switch (key) {
    case 'this-month':
      return { start: now.startOf('month'), end: now.endOf('month') };
    case 'last-month': {
      const lm = now.minus({ months: 1 });
      return { start: lm.startOf('month'), end: lm.endOf('month') };
    }
    case 'this-week':
      return { start: now.startOf('week'), end: now.endOf('week') };
    case 'last-week': {
      const lw = now.minus({ weeks: 1 });
      return { start: lw.startOf('week'), end: lw.endOf('week') };
    }
    case 'last-7':
      return { start: now.minus({ days: 6 }).startOf('day'), end: now.endOf('day') };
    case 'last-30':
      return { start: now.minus({ days: 29 }).startOf('day'), end: now.endOf('day') };
    default:
      return null;
  }
}

function formatRangeLabel(start: DateTime, end: DateTime): string {
  const sameMonth = start.year === end.year && start.month === end.month;
  // Whole month?
  if (sameMonth && start.day === 1 && end.day === end.endOf('month').day) {
    return start.setLocale('es').toFormat('LLLL yyyy');
  }
  // dd/MM/yyyy display range
  return `${start.toFormat('dd/LL/yyyy')} → ${end.toFormat('dd/LL/yyyy')}`;
}

function aggregate(rows: ReturnType<typeof buildReports>) {
  return rows.reduce((acc, r) => ({
    shifts: acc.shifts + r.shifts,
    completed: acc.completed + r.completed,
    unmarked: acc.unmarked + r.unmarked.count,
    lateCount: acc.lateCount + r.late.count,
    lateMin: acc.lateMin + r.late.totalMin,
    breakExcessCount: acc.breakExcessCount + r.breakExcess.count,
    breakExcessMin: acc.breakExcessMin + r.breakExcess.totalMin,
    autoClockouts: acc.autoClockouts + r.autoClockouts.count,
    permisoDays: acc.permisoDays + r.permisoDays,
    vacationDays: acc.vacationDays + r.vacationDays,
    hoursWorked: +(acc.hoursWorked + r.hoursWorked).toFixed(2),
    agents: acc.agents + 1
  }), {
    shifts: 0, completed: 0, unmarked: 0,
    lateCount: 0, lateMin: 0,
    breakExcessCount: 0, breakExcessMin: 0,
    autoClockouts: 0,
    permisoDays: 0, vacationDays: 0, hoursWorked: 0,
    agents: 0
  });
}
