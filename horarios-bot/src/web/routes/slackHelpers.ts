/**
 * Admin-only helpers that query Slack via the bot's own credentials.
 * Útil para encontrar IDs (subteams, channels) sin acceso al panel admin.
 *
 * Routes:
 *   GET /slack-helpers/usergroups  → lista user groups con handle + ID
 */
import { Router } from 'express';
import type { App as SlackApp } from '@slack/bolt';
import { requireAdmin } from './auth';

export function buildSlackHelpersRouter(slackApp: SlackApp | null): Router {
  const router = Router();
  router.use(requireAdmin);

  router.get('/usergroups', async (req, res) => {
    const user = (req.session as any).user;
    if (!slackApp) {
      res.render('slack-helpers-usergroups', { user, groups: [], error: 'Slack app no disponible' });
      return;
    }
    try {
      const result = await slackApp.client.usergroups.list({ include_disabled: false, include_users: false });
      const groups = (result.usergroups || []).map((g: any) => ({
        id: g.id,                       // S0XXXXXXX
        handle: g.handle || g.name,     // 'support'
        name: g.name,                   // 'Support team'
        userCount: g.user_count ?? 0,
        mentionTag: `<!subteam^${g.id}>` // ready-to-paste mention
      })).sort((a, b) => a.handle.localeCompare(b.handle));
      res.render('slack-helpers-usergroups', { user, groups, error: null });
    } catch (e: any) {
      console.error('usergroups list failed:', e);
      const msg = e?.data?.error === 'missing_scope'
        ? 'El bot no tiene el scope usergroups:read. Pídele al admin de Slack que lo agregue.'
        : (e?.data?.error || e?.message || 'Error desconocido');
      res.render('slack-helpers-usergroups', { user, groups: [], error: msg });
    }
  });

  return router;
}
