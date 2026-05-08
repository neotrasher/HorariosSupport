import { Router } from 'express';
import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { config } from '../../config';
import { getAgentBySlackId, listAgents } from '../../services/agents';
import {
  createRequest, listByRequester, listAll, listPending, getRequest,
  approveAndApply, reject, cancel, cancelByManager, deleteRequest, findOverlappingActive,
  setDmTargets, setRequesterDm, getDmTargets, vacationDaysUsedInYear,
  TimeOffStatus
} from '../../services/timeOff';
import { logAudit } from '../../services/audit';
import { suggestCoverage } from '../../services/coverage';
import {
  listAllSwaps, listSwapsForUser, listPendingSwaps,
  describeSnapshot, AssignmentSnapshot, SwapStatus
} from '../../services/swaps';
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

  /**
   * Resolve the redirect target after a mutating action: prefer the page the
   * user came from (so filters like ?agent=...&status=... stay applied),
   * fall back to /solicitudes. Validates same-origin to prevent open redirects.
   */
  function backTo(req: any): string {
    const ref = (req.headers.referer || '') as string;
    try {
      const u = new URL(ref);
      // Only honor referers that point to the solicitudes LIST (/solicitudes
      // with optional query). For sub-pages like /nueva or /:id/coverage we
      // fall back to the list to avoid re-showing the form / coverage view.
      if (u.pathname === '/solicitudes') {
        return '/solicitudes' + (u.search || '');
      }
    } catch {}
    return '/solicitudes';
  }

  router.get('/', (req, res) => {
    const user = (req.session as any).user;
    const view = (req.query.view as string) === 'swaps' ? 'swaps' : 'timeoff';
    const filterStatus = (req.query.status as string) || '';
    const filterAgent = ((req.query.agent as string) || '').trim();

    const isPriv = user.role === 'manager' || user.role === 'admin';

    // Always compute counts for the tab badges (cheap)
    const pendingTimeOffCount = listPending().length;
    const pendingSwapsCount = listPendingSwaps().length;

    let requests: any[] = [];
    let swaps: any[] = [];

    if (view === 'swaps') {
      let rawSwaps = isPriv
        ? (filterStatus ? listAllSwaps({ status: filterStatus as SwapStatus }) : listAllSwaps())
        : listSwapsForUser(user.slack_id);
      if (isPriv && filterAgent) {
        rawSwaps = rawSwaps.filter(s =>
          s.requester_slack_id === filterAgent || s.partner_slack_id === filterAgent
        );
      }
      swaps = rawSwaps.map(s => {
        const reqA = getAgentBySlackId(s.requester_slack_id);
        const partA = getAgentBySlackId(s.partner_slack_id);
        let reqSnap: AssignmentSnapshot | null = null;
        let partSnap: AssignmentSnapshot | null = null;
        try { reqSnap = JSON.parse(s.requester_snapshot); } catch {}
        try { partSnap = JSON.parse(s.partner_snapshot); } catch {}
        return {
          ...s,
          requesterName: reqA?.name || s.requester_slack_id,
          partnerName: partA?.name || s.partner_slack_id,
          requesterSnapshotLabel: reqSnap ? describeSnapshot(reqSnap) : '—',
          partnerSnapshotLabel: partSnap ? describeSnapshot(partSnap) : '—',
          createdLocal: DateTime.fromSQL(s.created_at, { zone: 'utc' }).toFormat('yyyy-LL-dd HH:mm') + ' UTC'
        };
      });
    } else {
      let rawRequests;
      if (isPriv) {
        rawRequests = filterStatus
          ? listAll({ status: filterStatus as TimeOffStatus })
          : listAll();
        if (filterAgent) rawRequests = rawRequests.filter(r => r.requester_slack_id === filterAgent);
      } else {
        rawRequests = listByRequester(user.slack_id);
      }
      requests = rawRequests.map(r => {
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
    }

    // For privileged users, list of agents with at least one request (for the filter dropdown)
    const agentOptions = isPriv
      ? listAgents()
          .filter(a => a.active !== 0)
          .map(a => ({ slack_id: a.slack_id, name: a.name }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];

    res.render('solicitudes-list', {
      user,
      view,
      requests,
      swaps,
      pendingCount: pendingTimeOffCount,
      pendingSwapsCount,
      filterStatus: filterStatus || '',
      filterAgent,
      agentOptions,
      isManager: isPriv
    });
  });

  router.get('/nueva', (req, res) => {
    const user = (req.session as any).user;
    const isPriv = user.role === 'manager' || user.role === 'admin';
    const agent = getAgentBySlackId(user.slack_id);
    // Manager/admin can create on behalf of others (no need to be linked themselves).
    // Regular agents must be linked.
    if (!isPriv && !agent) {
      res.status(403).render('error', {
        message: 'Tu cuenta no esta vinculada a un agente. Pide a un manager que use /horario-link.',
        user
      });
      return;
    }
    const allAgents = isPriv
      ? listAgents().filter(a => a.active !== 0).sort((a, b) => a.name.localeCompare(b.name))
      : [];
    // For agent view: show their own vacation balance. For privileged users it
    // gets recomputed client-side as they pick a target agent.
    const year = DateTime.utc().year;
    const myBalance = agent ? {
      year,
      used: vacationDaysUsedInYear(agent.slack_id, year),
      entitled: agent.vacation_days_per_year ?? null
    } : null;
    // Map of slack_id → { year, used, entitled } for all agents (privileged use)
    const balanceByAgent: Record<string, { year: number; used: number; entitled: number | null }> = {};
    if (isPriv) {
      for (const a of allAgents) {
        balanceByAgent[a.slack_id] = {
          year, used: vacationDaysUsedInYear(a.slack_id, year),
          entitled: a.vacation_days_per_year ?? null
        };
      }
    }
    res.render('solicitudes-new', {
      user, agent, allAgents, isPriv,
      error: null,
      myBalance, balanceByAgent,
      form: { type: 'permiso', start_date: '', end_date: '', reason: '', target_slack_id: '' }
    });
  });

  router.post('/nueva', async (req, res) => {
    const user = (req.session as any).user;
    const isPriv = user.role === 'manager' || user.role === 'admin';

    const type = req.body.type as 'permiso' | 'vacaciones';
    const startDate = (req.body.start_date as string || '').trim();
    const endDate = (req.body.end_date as string || '').trim();
    const reason = (req.body.reason as string || '').trim() || null;
    const targetSlackId = (req.body.target_slack_id as string || '').trim();

    // Decide on whose behalf the request is being created
    const requesterSlackId = isPriv && targetSlackId ? targetSlackId : user.slack_id;
    const targetAgent = getAgentBySlackId(requesterSlackId);

    const allAgents = isPriv
      ? listAgents().filter(a => a.active !== 0).sort((a, b) => a.name.localeCompare(b.name))
      : [];
    const formState = { type, start_date: startDate, end_date: endDate, reason: reason || '', target_slack_id: targetSlackId };
    const renderError = (msg: string) =>
      res.status(400).render('solicitudes-new', { user, agent: targetAgent || null, allAgents, isPriv, error: msg, form: formState, myBalance: null, balanceByAgent: {} });

    if (!targetAgent) {
      return renderError(isPriv
        ? 'Selecciona un agente o deja en blanco para crearla a tu nombre.'
        : 'Tu cuenta no esta vinculada a un agente.');
    }

    if (!['permiso', 'vacaciones'].includes(type)) return renderError('Tipo invalido.');
    if (!startDate || !endDate) return renderError('Las fechas son obligatorias.');
    if (endDate < startDate) return renderError('La fecha fin no puede ser anterior a la de inicio.');

    const overlap = findOverlappingActive(requesterSlackId, startDate, endDate);
    if (overlap) {
      return renderError(`Ya hay una solicitud ${overlap.status} que se traslapa (${overlap.start_date} → ${overlap.end_date}).`);
    }

    const reqRow = createRequest({
      requesterSlackId,
      type, startDate, endDate, reason,
      source: 'web'
    });

    // Notify managers via Slack DMs (same as bot flow). Best-effort.
    if (slackApp) {
      const targets: { slack_id: string; channel: string; ts: string }[] = [];
      // Admin can self-approve, so include their DM. Manager cannot self-approve,
      // so skip them only if they're the actual requester (not just the creator).
      for (const managerId of config.managerSlackIds) {
        if (managerId === requesterSlackId && user.role !== 'admin') continue;
        try {
          const im = await slackApp.client.conversations.open({ users: managerId });
          const ch = im.channel?.id;
          if (!ch) continue;
          const r = await slackApp.client.chat.postMessage({
            channel: ch,
            text: `Nueva solicitud de tiempo libre de ${targetAgent.name}`,
            blocks: timeOffApproverBlocks({
              requestId: reqRow.id,
              requesterName: targetAgent.name,
              requesterSlackId,
              type, startDate, endDate, reason
            })
          });
          if (r.ts) targets.push({ slack_id: managerId, channel: ch, ts: r.ts });
        } catch (e) {
          console.error(`solicitudes web: failed to DM manager ${managerId}:`, e);
        }
      }
      // Also DM admins so they get the Approve/Reject buttons (even for their own requests).
      for (const adminId of config.adminSlackIds) {
        if (config.managerSlackIds.includes(adminId)) continue; // already notified above
        try {
          const im = await slackApp.client.conversations.open({ users: adminId });
          const ch = im.channel?.id;
          if (!ch) continue;
          const r = await slackApp.client.chat.postMessage({
            channel: ch,
            text: `Nueva solicitud de tiempo libre de ${targetAgent.name}`,
            blocks: timeOffApproverBlocks({
              requestId: reqRow.id,
              requesterName: targetAgent.name,
              requesterSlackId,
              type, startDate, endDate, reason
            })
          });
          if (r.ts) targets.push({ slack_id: adminId, channel: ch, ts: r.ts });
        } catch (e) {
          console.error(`solicitudes web: failed to DM admin ${adminId}:`, e);
        }
      }
      setDmTargets(reqRow.id, targets);

      // DM the requester (the agent the solicitud is FOR) — even when created by a manager
      try {
        const im = await slackApp.client.conversations.open({ users: requesterSlackId });
        const ch = im.channel?.id;
        if (ch) {
          const r = await slackApp.client.chat.postMessage({
            channel: ch,
            text: requesterSlackId === user.slack_id ? 'Solicitud enviada' : 'Tu manager creó una solicitud a tu nombre',
            blocks: timeOffRequesterBlocks({ type, startDate, endDate, reason })
          });
          if (r.ts) setRequesterDm(reqRow.id, ch, r.ts);
        }
      } catch (e) {
        console.error('solicitudes web: failed to DM requester:', e);
      }
    }

    res.redirect(backTo(req));
  });

  router.post('/:id/cancel', (req, res) => {
    const user = (req.session as any).user;
    const id = parseInt(req.params.id, 10);
    // #6b: manager/admin can cancel anyone's pending request; agents only their own.
    const isPriv = user.role === 'manager' || user.role === 'admin';
    const r = getRequest(id);
    if (isPriv) cancelByManager(id);
    else cancel(id, user.slack_id);
    if (r) {
      const a = getAgentBySlackId(r.requester_slack_id);
      logAudit({
        actorSlackId: user.slack_id, actorName: user.name,
        action: 'timeoff.cancel',
        targetKind: 'request', targetId: String(id),
        summary: `Cancelo solicitud #${id} de ${a?.name || r.requester_slack_id} (${r.type} ${r.start_date}→${r.end_date})`,
        payload: { id, type: r.type, start: r.start_date, end: r.end_date, requester: r.requester_slack_id, byPriv: isPriv }
      });
    }

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

    res.redirect(backTo(req));
  });

  // Smart coverage suggestions for a pending time-off request (manager/admin only).
  router.get('/:id/coverage', requireManager, (req, res) => {
    const user = (req.session as any).user;
    const id = parseInt(req.params.id, 10);
    const r = getRequest(id);
    if (!r) {
      res.status(404).render('error', { message: 'Solicitud no encontrada.', user });
      return;
    }
    const report = suggestCoverage({
      requesterSlackId: r.requester_slack_id,
      startDate: r.start_date,
      endDate: r.end_date,
      type: r.type
    });
    if (!report) {
      res.status(400).render('error', { message: 'No se pudo calcular cobertura.', user });
      return;
    }
    res.render('solicitudes-coverage', {
      user, request: r, report
    });
  });

  router.post('/:id/approve', requireManager, async (req, res) => {
    const user = (req.session as any).user;
    const id = parseInt(req.params.id, 10);
    const r = getRequest(id);
    if (!r || r.status !== 'pending') {
      res.redirect(backTo(req));
      return;
    }
    // Admin can self-approve; manager cannot.
    if (r.requester_slack_id === user.slack_id && user.role !== 'admin') {
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
    logAudit({
      actorSlackId: user.slack_id, actorName: user.name,
      action: 'timeoff.approve',
      targetKind: 'request', targetId: String(id),
      summary: `Aprobo ${r.type} de ${agent.name} (${r.start_date}→${r.end_date})`,
      payload: { id, type: r.type, start: r.start_date, end: r.end_date, requester: r.requester_slack_id, plannerId: agent.planner_id }
    });

    if (slackApp) await broadcastWebResolution(slackApp, id, 'approved', user.slack_id);
    res.redirect(backTo(req));
  });

  router.post('/:id/reject', requireManager, async (req, res) => {
    const user = (req.session as any).user;
    const id = parseInt(req.params.id, 10);
    const reasonInput = (req.body.rejection_reason as string || '').trim() || null;
    const r = getRequest(id);
    if (!r || r.status !== 'pending') {
      res.redirect(backTo(req));
      return;
    }
    // #4a: admin can self-reject (consistency with self-approve). Manager cannot.
    if (r.requester_slack_id === user.slack_id && user.role !== 'admin') {
      res.status(403).render('error', { message: 'No puedes rechazar tu propia solicitud. Pide a otro manager que la revise.', user });
      return;
    }
    reject(id, user.slack_id, reasonInput);
    {
      const a = getAgentBySlackId(r.requester_slack_id);
      logAudit({
        actorSlackId: user.slack_id, actorName: user.name,
        action: 'timeoff.reject',
        targetKind: 'request', targetId: String(id),
        summary: `Rechazo ${r.type} de ${a?.name || r.requester_slack_id} (${r.start_date}→${r.end_date})${reasonInput ? ' · ' + reasonInput : ''}`,
        payload: { id, type: r.type, start: r.start_date, end: r.end_date, requester: r.requester_slack_id, reason: reasonInput }
      });
    }

    if (slackApp) await broadcastWebResolution(slackApp, id, 'rejected', user.slack_id, reasonInput);
    res.redirect(backTo(req));
  });

  router.post('/:id/delete', requireManager, async (req, res) => {
    const user = (req.session as any).user;
    const id = parseInt(req.params.id, 10);
    const r = getRequest(id);
    if (!r) {
      res.redirect(backTo(req));
      return;
    }
    // If approved, look up plannerId so days_off rollback is possible
    const agent = getAgentBySlackId(r.requester_slack_id);
    const plannerId = agent ? agent.planner_id : null;

    deleteRequest(id, plannerId);
    logAudit({
      actorSlackId: user.slack_id, actorName: user.name,
      action: 'timeoff.delete',
      targetKind: 'request', targetId: String(id),
      summary: `Elimino ${r.status} ${r.type} de ${agent?.name || r.requester_slack_id} (${r.start_date}→${r.end_date})`,
      payload: { id, type: r.type, status: r.status, start: r.start_date, end: r.end_date, requester: r.requester_slack_id, plannerId }
    });

    // Best-effort: tombstone any DMs (so old buttons can't act on a dead row)
    if (slackApp) {
      const tombstoneBlocks = [{
        type: 'section',
        text: { type: 'mrkdwn', text: `🗑️ _Solicitud eliminada por un manager. ${r.status === 'approved' ? 'El horario original se restablece.' : ''}_` }
      }];
      for (const t of getDmTargets(id)) {
        try {
          await slackApp.client.chat.update({
            channel: t.channel, ts: t.ts, text: 'Solicitud eliminada', blocks: tombstoneBlocks
          });
        } catch (e) { /* ignore */ }
      }
      if (r.requester_dm_channel && r.requester_dm_ts) {
        try {
          await slackApp.client.chat.update({
            channel: r.requester_dm_channel, ts: r.requester_dm_ts,
            text: 'Tu solicitud fue eliminada', blocks: tombstoneBlocks
          });
        } catch (e) { /* ignore */ }
      }
    }

    res.redirect(backTo(req));
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
