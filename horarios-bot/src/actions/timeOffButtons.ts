import { App } from '@slack/bolt';
import { config } from '../config';
import { getAgentBySlackId } from '../services/agents';
import {
  getRequest, approveAndApply, reject, getDmTargets, TimeOffRequest
} from '../services/timeOff';
import { timeOffResolvedBlocks } from '../ui/blocks';

/**
 * Handles approve/reject buttons on time-off request DMs sent to managers.
 * On resolution: updates DB, edits all manager DMs to a resolved state, edits
 * the requester DM to show the outcome, and (if approved) creates days_off entries.
 */
export function registerTimeOffButtons(app: App) {
  app.action('time_off_approve', async ({ ack, body, client }) => {
    await ack();
    const action = (body as any).actions[0];
    const requestId = parseInt(action.value, 10);
    const approverSlackId = (body as any).user.id;

    const isAdmin = config.adminSlackIds.includes(approverSlackId);
    const isManager = config.managerSlackIds.includes(approverSlackId);
    if (!isAdmin && !isManager) {
      await client.chat.postEphemeral({
        channel: (body as any).channel.id,
        user: approverSlackId,
        text: '❌ Solo managers pueden aprobar.'
      });
      return;
    }

    const req = getRequest(requestId);
    if (!req || req.status !== 'pending') {
      await client.chat.postEphemeral({
        channel: (body as any).channel.id,
        user: approverSlackId,
        text: '⚠️ Esta solicitud ya fue resuelta.'
      });
      return;
    }

    // Admin can self-approve; manager cannot.
    if (req.requester_slack_id === approverSlackId && !isAdmin) {
      await client.chat.postEphemeral({
        channel: (body as any).channel.id,
        user: approverSlackId,
        text: '❌ No puedes aprobar tu propia solicitud. Pide a otro manager que la revise.'
      });
      return;
    }

    const agent = getAgentBySlackId(req.requester_slack_id);
    if (!agent) {
      await client.chat.postEphemeral({
        channel: (body as any).channel.id,
        user: approverSlackId,
        text: '❌ El agente solicitante ya no esta vinculado.'
      });
      return;
    }

    try {
      approveAndApply(requestId, approverSlackId, agent.planner_id);
    } catch (e: any) {
      console.error('time_off_approve failed:', e);
      await client.chat.postEphemeral({
        channel: (body as any).channel.id,
        user: approverSlackId,
        text: `❌ Error: ${e?.message || 'desconocido'}`
      });
      return;
    }

    await broadcastResolution(client, requestId, 'approved', approverSlackId);
  });

  app.action('time_off_reject', async ({ ack, body, client }) => {
    await ack();
    const action = (body as any).actions[0];
    const requestId = parseInt(action.value, 10);
    const approverSlackId = (body as any).user.id;

    const isAdminReject = config.adminSlackIds.includes(approverSlackId);
    const isManagerReject = config.managerSlackIds.includes(approverSlackId);
    if (!isAdminReject && !isManagerReject) {
      await client.chat.postEphemeral({
        channel: (body as any).channel.id,
        user: approverSlackId,
        text: '❌ Solo manager/admin pueden rechazar.'
      });
      return;
    }

    const req = getRequest(requestId);
    // #4a: admin can self-reject (consistency with self-approve). Manager cannot.
    if (req && req.requester_slack_id === approverSlackId && !isAdminReject) {
      await client.chat.postEphemeral({
        channel: (body as any).channel.id,
        user: approverSlackId,
        text: '❌ No puedes rechazar tu propia solicitud. Pide a otro manager que la revise.'
      });
      return;
    }

    // Open a modal to ask for rejection reason
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'time_off_reject_modal',
        private_metadata: String(requestId),
        title: { type: 'plain_text', text: 'Rechazar solicitud' },
        submit: { type: 'plain_text', text: 'Rechazar' },
        close: { type: 'plain_text', text: 'Volver' },
        blocks: [
          {
            type: 'input',
            block_id: 'reason',
            optional: true,
            label: { type: 'plain_text', text: 'Motivo del rechazo (opcional)' },
            element: {
              type: 'plain_text_input',
              action_id: 'v',
              multiline: true,
              placeholder: { type: 'plain_text', text: 'Ej: ya hay 3 personas de vacaciones esa semana...' }
            }
          }
        ]
      }
    });
  });

  app.view('time_off_reject_modal', async ({ ack, view, body, client }) => {
    await ack();
    const requestId = parseInt(view.private_metadata, 10);
    const approverSlackId = body.user.id;
    const reasonInput = (view.state.values.reason.v.value as string | undefined)?.trim() || null;

    const req = getRequest(requestId);
    if (!req || req.status !== 'pending') return;

    reject(requestId, approverSlackId, reasonInput);
    await broadcastResolution(client, requestId, 'rejected', approverSlackId, reasonInput);
  });
}

async function broadcastResolution(
  client: any,
  requestId: number,
  status: 'approved' | 'rejected',
  approverSlackId: string,
  rejectionReason: string | null = null
) {
  const req = getRequest(requestId);
  if (!req) return;

  // Update all manager DMs (the original ones with buttons → replaced with resolved state)
  const targets = getDmTargets(requestId);
  const approverBlocks = timeOffResolvedBlocks({
    type: req.type, startDate: req.start_date, endDate: req.end_date,
    startTime: req.start_time, endTime: req.end_time, reason: req.reason,
    status, approverSlackId, rejectionReason,
    audience: 'approver', requesterSlackId: req.requester_slack_id
  });
  for (const t of targets) {
    try {
      await client.chat.update({
        channel: t.channel, ts: t.ts,
        text: `Solicitud ${status === 'approved' ? 'aprobada' : 'rechazada'}`,
        blocks: approverBlocks
      });
    } catch (e) {
      console.error(`time_off broadcast: failed to update DM for ${t.slack_id}:`, e);
    }
  }

  // Update requester DM
  if (req.requester_dm_channel && req.requester_dm_ts) {
    try {
      await client.chat.update({
        channel: req.requester_dm_channel,
        ts: req.requester_dm_ts,
        text: `Tu solicitud fue ${status === 'approved' ? 'aprobada' : 'rechazada'}`,
        blocks: timeOffResolvedBlocks({
          type: req.type, startDate: req.start_date, endDate: req.end_date,
          startTime: req.start_time, endTime: req.end_time, reason: req.reason,
          status, approverSlackId, rejectionReason,
          audience: 'requester'
        })
      });
    } catch (e) {
      console.error('time_off broadcast: failed to update requester DM:', e);
    }
  }
}
