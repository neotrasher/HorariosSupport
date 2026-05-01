import { Router } from 'express';
import { DateTime } from 'luxon';
import { expandPlanner, applyExpansion, ExpansionResult } from '../../services/plannerImport';
import { requireManager } from './auth';

export const plannerRouter = Router();

plannerRouter.use(requireManager);

declare module 'express-session' {
  interface SessionData {
    pendingPlanner?: ExpansionResult;
  }
}

plannerRouter.get('/', (req, res) => {
  const user = (req.session as any).user;
  // Default range: next Monday → 12 weeks later
  const today = DateTime.utc().startOf('day');
  const nextMonday = today.plus({ days: ((1 - today.weekday + 7) % 7) || 7 });
  const defaultEnd = nextMonday.plus({ weeks: 12 }).minus({ days: 1 });

  res.render('planner', {
    user,
    mode: 'upload',
    error: null,
    defaultStart: nextMonday.toFormat('yyyy-LL-dd'),
    defaultEnd: defaultEnd.toFormat('yyyy-LL-dd')
  });
});

plannerRouter.post('/', (req, res) => {
  const user = (req.session as any).user;
  const startStr = (req.body.start_date as string || '').trim();
  const endStr = (req.body.end_date as string || '').trim();
  const json = (req.body.json as string || '').trim();

  const renderError = (msg: string) =>
    res.status(400).render('planner', {
      user, mode: 'upload', error: msg,
      defaultStart: startStr, defaultEnd: endStr
    });

  if (!startStr || !endStr) return renderError('Selecciona fecha de inicio y fin.');
  if (!json) return renderError('Pega o sube el JSON exportado del planner.');

  let parsed: any;
  try { parsed = JSON.parse(json); }
  catch { return renderError('JSON invalido. Verifica el archivo.'); }
  if (!parsed || typeof parsed !== 'object') return renderError('El JSON no parece valido.');

  const exp = expandPlanner(parsed, startStr, endStr);
  if (exp.errors.length) return renderError(exp.errors.join(' · '));

  // Stash in session so the confirm step doesn't need to re-upload
  (req.session as any).pendingPlanner = exp;

  // Stats per dept for display
  const byDept: Record<string, number> = {};
  for (const e of exp.entries) byDept[e.dept] = (byDept[e.dept] || 0) + 1;
  const byEmployee: Record<number, number> = {};
  for (const e of exp.entries) byEmployee[e.plannerId] = (byEmployee[e.plannerId] || 0) + 1;

  res.render('planner', {
    user,
    mode: 'preview',
    error: null,
    exp,
    byDept,
    byEmployee
  });
});

plannerRouter.post('/aplicar', (req, res) => {
  const user = (req.session as any).user;
  const exp = (req.session as any).pendingPlanner as ExpansionResult | undefined;
  if (!exp) {
    res.status(400).render('error', { message: 'No hay un import pendiente. Vuelve a subir el JSON.', user });
    return;
  }
  let stats;
  try {
    stats = applyExpansion(exp);
  } catch (e: any) {
    res.status(500).render('error', { message: `Error al aplicar: ${e?.message || 'desconocido'}`, user });
    return;
  }
  delete (req.session as any).pendingPlanner;
  console.log(`[planner] published ${stats.entriesInserted} entries + ${stats.daysOffInserted} days_off (${exp.rangeStart}→${exp.rangeEnd}) by ${user.name}`);

  res.render('planner', {
    user,
    mode: 'success',
    error: null,
    stats,
    rangeStart: exp.rangeStart,
    rangeEnd: exp.rangeEnd
  });
});

plannerRouter.post('/cancelar', (req, res) => {
  delete (req.session as any).pendingPlanner;
  res.redirect('/planner');
});
