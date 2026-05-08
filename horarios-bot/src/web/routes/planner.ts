import { Router } from 'express';
import { DateTime } from 'luxon';
import { expandPlanner, applyExpansion, ExpansionResult } from '../../services/plannerImport';
import { getPlannerState, setPlannerState } from '../../services/plannerState';
import { listAllAgents } from '../../services/agents';
import { requireManager } from './auth';
import { activeCycles } from '../../config';

export const plannerRouter = Router();

plannerRouter.use(requireManager);

declare module 'express-session' {
  interface SessionData {
    pendingPlanner?: ExpansionResult;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Visual editor (new default landing for /planner)
// ─────────────────────────────────────────────────────────────────────────

plannerRouter.get('/', (req, res) => {
  const user = (req.session as any).user;
  const today = DateTime.utc().startOf('day');
  const nextMonday = today.plus({ days: ((1 - today.weekday + 7) % 7) || 7 });
  const defaultEnd = nextMonday.plus({ weeks: 12 }).minus({ days: 1 });
  res.render('planner-editor', {
    user,
    defaultStart: nextMonday.toFormat('yyyy-LL-dd'),
    defaultEnd: defaultEnd.toFormat('yyyy-LL-dd'),
    activeCycles: activeCycles()
  });
});

// API: load current planner state + employees
plannerRouter.get('/api/state', (_req, res) => {
  const state = getPlannerState();
  // Active agents only, mapped to the planner's employee shape (id/name/dept/color)
  const agents = listAllAgents(false).map(a => ({
    id: a.planner_id, name: a.name, dept: a.dept,
    // Color: derive from agents table if you ever add it; for now reuse a stable hash-color
    color: stableColorFor(a.planner_id)
  }));
  res.json({ ok: true, state, employees: agents });
});

// API: save planner state
plannerRouter.post('/api/state', (req, res) => {
  const user = (req.session as any).user;
  const { schedule, daysOff } = req.body || {};
  if (!schedule || typeof schedule !== 'object') {
    return res.status(400).json({ ok: false, error: 'schedule missing' });
  }
  setPlannerState(schedule, daysOff || {}, user?.slack_id || null);
  res.json({ ok: true });
});

// Apply current saved state to a date range → reuses the existing preview flow
plannerRouter.post('/aplicar-state', (req, res) => {
  const user = (req.session as any).user;
  const startStr = (req.body.start_date as string || '').trim();
  const endStr = (req.body.end_date as string || '').trim();
  if (!startStr || !endStr) {
    res.status(400).render('error', { message: 'Selecciona un rango de fechas.', user });
    return;
  }
  const state = getPlannerState();
  if (!state.schedule || Object.keys(state.schedule).length === 0) {
    res.status(400).render('error', { message: 'El planner esta vacio. Edita primero antes de aplicar.', user });
    return;
  }
  const json = { schedule: state.schedule, daysOff: state.daysOff, version: 3 };
  const exp = expandPlanner(json, startStr, endStr);
  if (exp.errors.length) {
    res.status(400).render('error', { message: exp.errors.join(' · '), user });
    return;
  }
  (req.session as any).pendingPlanner = exp;
  const byDept: Record<string, number> = {};
  for (const e of exp.entries) byDept[e.dept] = (byDept[e.dept] || 0) + 1;
  const byEmployee: Record<number, number> = {};
  for (const e of exp.entries) byEmployee[e.plannerId] = (byEmployee[e.plannerId] || 0) + 1;
  res.render('planner', {
    user, mode: 'preview', error: null, exp, byDept, byEmployee
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Legacy JSON-upload flow (kept as fallback at /planner/upload)
// ─────────────────────────────────────────────────────────────────────────

plannerRouter.get('/upload', (req, res) => {
  const user = (req.session as any).user;
  const today = DateTime.utc().startOf('day');
  const nextMonday = today.plus({ days: ((1 - today.weekday + 7) % 7) || 7 });
  const defaultEnd = nextMonday.plus({ weeks: 12 }).minus({ days: 1 });
  res.render('planner', {
    user, mode: 'upload', error: null,
    defaultStart: nextMonday.toFormat('yyyy-LL-dd'),
    defaultEnd: defaultEnd.toFormat('yyyy-LL-dd')
  });
});

plannerRouter.post('/upload', (req, res) => {
  const user = (req.session as any).user;
  const startStr = (req.body.start_date as string || '').trim();
  const endStr = (req.body.end_date as string || '').trim();
  const json = (req.body.json as string || '').trim();
  const renderError = (msg: string) =>
    res.status(400).render('planner', {
      user, mode: 'upload', error: msg, defaultStart: startStr, defaultEnd: endStr
    });
  if (!startStr || !endStr) return renderError('Selecciona fecha de inicio y fin.');
  if (!json) return renderError('Pega o sube el JSON exportado del planner.');
  let parsed: any;
  try { parsed = JSON.parse(json); }
  catch { return renderError('JSON invalido. Verifica el archivo.'); }
  if (!parsed || typeof parsed !== 'object') return renderError('El JSON no parece valido.');
  const exp = expandPlanner(parsed, startStr, endStr);
  if (exp.errors.length) return renderError(exp.errors.join(' · '));
  (req.session as any).pendingPlanner = exp;
  const byDept: Record<string, number> = {};
  for (const e of exp.entries) byDept[e.dept] = (byDept[e.dept] || 0) + 1;
  const byEmployee: Record<number, number> = {};
  for (const e of exp.entries) byEmployee[e.plannerId] = (byEmployee[e.plannerId] || 0) + 1;
  res.render('planner', { user, mode: 'preview', error: null, exp, byDept, byEmployee });
});

// ─────────────────────────────────────────────────────────────────────────
// Shared apply / cancel (both editor and legacy use these)
// ─────────────────────────────────────────────────────────────────────────

plannerRouter.post('/aplicar', (req, res) => {
  const user = (req.session as any).user;
  const exp = (req.session as any).pendingPlanner as ExpansionResult | undefined;
  if (!exp) {
    res.status(400).render('error', { message: 'No hay un import pendiente. Vuelve a editar y aplicar.', user });
    return;
  }
  let stats;
  try { stats = applyExpansion(exp); }
  catch (e: any) {
    res.status(500).render('error', { message: `Error al aplicar: ${e?.message || 'desconocido'}`, user });
    return;
  }
  delete (req.session as any).pendingPlanner;
  console.log(`[planner] published ${stats.entriesInserted} entries + ${stats.daysOffInserted} days_off (${exp.rangeStart}→${exp.rangeEnd}) by ${user.name}`);
  res.render('planner', {
    user, mode: 'success', error: null, stats,
    rangeStart: exp.rangeStart, rangeEnd: exp.rangeEnd
  });
});

plannerRouter.post('/cancelar', (req, res) => {
  delete (req.session as any).pendingPlanner;
  res.redirect('/planner');
});

// Stable per-employee color (matches planner.html palette feel)
function stableColorFor(id: number): string {
  const palette = [
    '#10b981','#f43f5e','#ec4899','#f97316','#3b82f6','#d97706','#ef4444',
    '#16a34a','#4f46e5','#f59e0b','#b91c1c','#0284c7','#059669','#7c3aed',
    '#ea580c','#6366f1','#0d9488','#a855f7','#14b8a6'
  ];
  return palette[Math.abs(id * 2654435761) % palette.length];
}
