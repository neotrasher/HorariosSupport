import { Router } from 'express';
import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config } from '../../config';
import { getAgentBySlackId } from '../../services/agents';
import {
  createRequest, listByRequester, listAll, listPending, getRequest,
  approveAndApply, reject, cancel, findOverlappingActive,
  setDmTargets, setRequesterDm, getDmTargets,
  TimeOffStatus
} from '../../services/timeOff';
import {
  timeOffApproverBlocks, timeOffRequesterBlocks, timeOffResolvedBlocks
} from '../../ui/blocks';
import { requireManager } from './auth';

/**
 * Web routes for time-off requests. Receives the Slack App so we can DM
 * managers/requester from web actions just like the bot does.
 */
export function buildSolicitudesRouter(slackApp: App | null): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const user = (req.session as any).user;
    const filterStatus = (req.query.status as string) as TimeOffStatus | undefined;

    let requests;
    if (user.role === 'manager') {
      requests = filterStatus ? listAll({ status: filterStatus }) : listAll();
    } else {
      requests = listByRequester(user.slack_id);
    }

    const pendingCount = listPending().length;

    const enriched = requests.map(r => {
      const a = getAgentBySlackId(r.requester_slack_id);
      const days = Math.round(
        (new Date(r.end_date).getTime() - new Date(r.start_date).getTime()) / 86400000
      ) + 1;
      return {
        ...r,
        requesterName: a?.name || r.requester_slack_id,
        days,
        createdLocal: DateTime.fromSQL(r.created_at, { zone: 'utc' }).toFormat('yyyy-LL-dd HH:mm') + ' UTC'
      };
    });

    res.render('solicitudes-list', {
      user,
      requests: enriched,
      filterStatus: filterStatus || '',
      pendingCount,
      isManager: user.role === 'manager'
    });
  });

  router.get('/nueva', (req, res) => {
    const user = (req.session as any).user;
    const agent = getAgentBySlackId(user.slack_id);
    if (!agent) {
      res.status(403).render('error', {
        message: 'Tu cuenta no esta vinculada a un agente. Pide a un manager que use /horario-link.',
        user
      });
      return;
    }
    res.render('solicitudes-new', { user, agent, error: null, form: { type: 'permiso', start_date: '', end_date: '', reason: '' } });
  });

  router.post('/nueva', async (req, res) => {
    const user = (req.session as any).user;
    const agent = getAgentBySlackId(user.slack_id);
    if (!agent) {
      res.status(403).render('error', { message: 'Cuenta no vinculada.', user });
      return;
    }

    const type = req.body.type as 'permiso' | 'vacaciones';
    const startDate = (req.body.start_date as string || '').trim();
    const endDate = (req.body.end_date as string || '').trim();
    const reason = (req.body.reason as string || '').trim() || null;

    const formState = { type, start_date: startDate, end_date: endDate, reason: reason || '' };
    const renderError = (msg: string) =>
      res.status(400).render('solicitudes-new', { user, agent, error: msg, form: formState });

    if (!['permiso', 'vacaciones'].includes(type)) return renderError('Tipo invalido.');
    if (!startDate || !endDate) return renderError('Las fechas son obligatorias.');
    if (endDate < startDate) return renderError('La fecha fin no puede ser anterior a la de inicio.');

    const overlap = findOverlappingActive(user.slack_id, startDate, endDate);
    if (overlap) {
      return renderError(`Ya tienes una solicitud ${overlap.status} que se traslapa (${overlap.start_date} → ${overlap.end_date}).`);
    }

    const reqRow = createRequest({
      requesterSlackId: user.slack_id,
      type, startDate, endDate, reason,
      source: 'web'
    });

    // Notify managers via Slack DMs (same as bot flow). Best-effort.
    if (slackApp) {
      const targets: { slack_id: string; channel: string; ts: string }[] = [];
      for (const managerId of config.managerSlackIds) {
        // If the requester is also a manager, don't send the approve buttons to themselves
        if (managerId === user.slack_id) continue;
        try {
          const im = await slackApp.client.conversations.open({ users: managerId });
          const ch = im.channel?.id;
          if (!ch) continue;
          const r = await slackApp.client.chat.postMessage({
            channel: ch,
            text: `Nueva solicitud de tiempo libre de ${agent.name}`,
            blocks: timeOffApproverBlocks({
              requestId: reqRow.id,
              requesterName: agent.name,
              requesterSlackId: user.slack_id,
              type, startDate, endDate, reason
            })
          });
          if (r.ts) targets.push({ slack_id: managerId, channel: ch, ts: r.ts });
        } catch (e) {
          console.error(`solicitudes web: failed to DM manager ${managerId}:`, e);
        }
      }
      setDmTargets(reqRow.id, targets);

      try {
        const im = await slackApp.client.conversations.open({ users: user.slack_id });
        const ch = im.channel?.id;
        if (ch) {
          const r = await slackApp.client.chat.postMessage({
            channel: ch,
            text: 'Solicitud enviada',
            blocks: timeOffRequesterBlocks({ type, startDate, endDate, reason })
          });
          if (r.ts) setRequesterDm(reqRow.id, ch, r.ts);
        }
      } catch (e) {
        console.error('solicitudes web: failed to DM requester:', e);
      }
    }

    res.redirect('/solicitudes');
  });

  router.post('/:id/cancel', (req, res) => {
    const user = (req.session as any).user;
    const id = parseInt(req.params.id, 10);
    cancel(id, user.slack_id);

    // Update Slack DMs (best-effort) — manager and requester
    (async () => {
      const r = getRequest(id);
      if (!r || !slackApp) return;
      const blocks = timeOffResolvedBlocks({
        type: r.type, startDate: r.start_date, endDate: r.end_date, reason: r.reason,
        status: 'cancelled', audience: 'approver', requesterSlackId: r.requester_slack_id
      });
      for (const t of getDmTargets(id)) {
        try {
          await slackApp.client.chat.update({ channel: t.channel, ts: t.ts, text: 'Solicitud cancelada', blocks });
        } catch (e) { console.error('cancel update DM failed:', e); }
      }
      if (r.requester_dm_channel && r.requester_dm_ts) {
        try {
          await slackApp.client.chat.update({
            channel: r.requester_dm_channel, ts: r.requester_dm_ts,
            text: 'Solicitud cancelada',
            blocks: timeOffResolvedBlocks({
              type: r.type, startDate: r.start_date, endDate: r.end_date, reason: r.reason,
              status: 'cancelled', audience: 'requester'
            })
          });
        } catch (e) { console.error('cancel update requester DM failed:', e); }
      }
    })();

    res.redirect('/solicitudes');
  });

  router.post('/:id/approve', requireManager, async (req, res) => {
    const user = (req.session as any).user;
    const id = parseInt(req.params.id, 10);
    const r = getRequest(id);
    if (!r || r.status !== 'pending') {
      res.redirect('/solicitudes');
      return;
    }
    if (r.requester_slack_id === user.slack_id) {
      res.status(403).render('error', { message: 'No puedes aprobar tu propia solicitud. Pide a otro manager que la revise.', user });
      return;
    }
    const agent = getAgentBySlackId(r.requester_slack_id);
    if (!agent) {
      res.status(400).render('error', { message: 'Agente no vinculado, no se puede aprobar.', user });
      return;
    }

    try {
      approveAndApply(id, user.slack_id, agent.planner_id);
    } catch (e: any) {
      res.status(500).render('error', { message: `Error al aprobar: ${e?.message}`, user });
      return;
    }

    if (slackApp) await broadcastWebResolution(slackApp, id, 'approved', user.slack_id);
    res.redirect('/solicitudes');
  });

  router.post('/:id/reject', requireManager, async (req, res) => {
    const user = (req.session as any).user;
    const id = parseInt(req.params.id, 10);
    const reasonInput = (req.body.rejection_reason as string || '').trim() || null;
    const r = getRequest(id);
    if (!r || r.status !== 'pending') {
      res.redirect('/solicitudes');
      return;
    }
    if (r.requester_slack_id === user.slack_id) {
      res.status(403).render('error', { message: 'No puedes rechazar tu propia solicitud.', user });
      return;
    }
    reject(id, user.slack_id, reasonInput);

    if (slackApp) await broadcastWebResolution(slackApp, id, 'rejected', user.slack_id, reasonInput);
    res.redirect('/solicitudes');
  });

  return router;
}

async function broadcastWebResolution(
  slackApp: App,
  requestId: number,
  status: 'approved' | 'rejected',
  approverSlackId: string,
  rejectionReason: string | null = null
) {
  const r = getRequest(requestId);
  if (!r) return;

  const approverBlocks = timeOffResolvedBlocks({
    type: r.type, startDate: r.start_date, endDate: r.end_date, reason: r.reason,
    status, approverSlackId, rejectionReason,
    audience: 'approver', requesterSlackId: r.requester_slack_id
  });
  for (const t of getDmTargets(requestId)) {
    try {
      await slackApp.client.chat.update({
        channel: t.channel, ts: t.ts,
        text: `Solicitud ${status === 'approved' ? 'aprobada' : 'rechazada'}`,
        blocks: approverBlocks
      });
    } catch (e) { console.error('web broadcast manager DM failed:', e); }
  }

  if (r.requester_dm_channel && r.requester_dm_ts) {
    try {
      await slackApp.client.chat.update({
        channel: r.requester_dm_channel, ts: r.requester_dm_ts,
        text: `Tu solicitud fue ${status === 'approved' ? 'aprobada' : 'rechazada'}`,
        blocks: timeOffResolvedBlocks({
          type: r.type, startDate: r.start_date, endDate: r.end_date, reason: r.reason,
          status, approverSlackId, rejectionReason,
          audience: 'requester'
        })
      });
    } catch (e) { console.error('web broadcast requester DM failed:', e); }
  }
}
