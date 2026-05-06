import { Router } from 'express';
import { DateTime } from 'luxon';
import { listAudit, distinctActions, distinctActors } from '../../services/audit';
import { requireAdmin } from './auth';

export const auditoriaRouter = Router();

auditoriaRouter.use(requireAdmin);

auditoriaRouter.get('/', (req, res) => {
  const user = (req.session as any).user;
  const action = (req.query.action as string) || '';
  const actor = (req.query.actor as string) || '';
  const since = (req.query.since as string) || DateTime.utc().minus({ days: 30 }).toFormat('yyyy-LL-dd');
  const limit = Math.min(500, Math.max(50, parseInt((req.query.limit as string) || '200', 10) || 200));

  const entries = listAudit({
    action: action || undefined,
    actor: actor || undefined,
    since: since || undefined,
    limit
  });
  // Parse payload JSON for ease of templating
  const rows = entries.map(e => {
    let payload: any = null;
    try { payload = e.payload ? JSON.parse(e.payload) : null; } catch {}
    return {
      ...e,
      payload,
      tsLabel: DateTime.fromSQL(e.ts, { zone: 'utc' }).toFormat('yyyy-LL-dd HH:mm') + ' UTC'
    };
  });
  res.render('auditoria', {
    user, rows,
    action, actor, since, limit,
    actions: distinctActions(),
    actors: distinctActors(),
    totalShown: rows.length
  });
});
