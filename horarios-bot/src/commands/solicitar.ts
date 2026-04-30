import { App } from '@slack/bolt';
import { config } from '../config';
import { getAgentBySlackId } from '../services/agents';
import {
  createRequest, findOverlappingActive, getRequest, setDmTargets, setRequesterDm
} from '../services/timeOff';
import {
  timeOffModalView, timeOffApproverBlocks, timeOffRequesterBlocks
} from '../ui/blocks';

/**
 * /solicitar — opens a modal to request permiso or vacaciones.
 * On submit: validates, creates DB row, DMs all managers with approve/reject,
 * and DMs the requester a confirmation that we link to so we can update on resolution.
 */
export function registerSolicitar(app: App) {
  app.command('/solicitar', async ({ ack, command, client }) => {
    await ack();
    await client.views.open({
      trigger_id: command.trigger_id,
      view: timeOffModalView()
    });
  });

  app.view('time_off_submit', async ({ ack, view, body, client }) => {
    const slackId = body.user.id;
    const v = view.state.values;
    const type = v.type.v.selected_option?.value as 'permiso' | 'vacaciones' | undefined;
    const startDate = v.start_date.v.selected_date as string | undefined;
    const endDate = v.end_date.v.selected_date as string | undefined;
    const reason = (v.reason.v.value as string | undefined)?.trim() || null;

    const errors: Record<string, string> = {};
    if (!type) errors.type = 'Selecciona un tipo.';
    if (!startDate) errors.start_date = 'Selecciona la fecha de inicio.';
    if (!endDate) errors.end_date = 'Selecciona la fecha de fin.';
    if (startDate && endDate && endDate < startDate) {
      errors.end_date = 'Debe ser igual o posterior a la fecha de inicio.';
    }
    if (Object.keys(errors).length) {
      await ack({ response_action: 'errors', errors });
      return;
    }

    // Beyond schema-level checks: agent must be linked, no overlapping active request
    const agent = getAgentBySlackId(slackId);
    if (!agent) {
      await ack({
        response_action: 'errors',
        errors: { type: 'Tu cuenta no esta vinculada a un agente. Pide a un manager que use /horario-link.' }
      });
      return;
    }

    const overlap = findOverlappingActive(slackId, startDate!, endDate!);
    if (overlap) {
      await ack({
        response_action: 'errors',
        errors: { start_date: `Ya tienes una solicitud ${overlap.status} que se traslapa (${overlap.start_date} → ${overlap.end_date}).` }
      });
      return;
    }

    await ack();

    const req = createRequest({
      requesterSlackId: slackId,
      type: type!, startDate: startDate!, endDate: endDate!, reason,
      source: 'bot'
    });

    // DM all managers with approve/reject buttons
    const targets: { slack_id: string; channel: string; ts: string }[] = [];
    for (const managerId of config.managerSlackIds) {
      // If the requester is also a manager, don't send the approve buttons to themselves
      if (managerId === slackId) continue;
      try {
        const im = await client.conversations.open({ users: managerId });
        const ch = im.channel?.id;
        if (!ch) continue;
        const res = await client.chat.postMessage({
          channel: ch,
          text: `Nueva solicitud de tiempo libre de ${agent.name}`,
          blocks: timeOffApproverBlocks({
            requestId: req.id,
            requesterName: agent.name,
            requesterSlackId: slackId,
            type: type!, startDate: startDate!, endDate: endDate!, reason
          })
        });
        if (res.ts) targets.push({ slack_id: managerId, channel: ch, ts: res.ts });
      } catch (e) {
        console.error(`solicitar: failed to DM manager ${managerId}:`, e);
      }
    }
    setDmTargets(req.id, targets);

    // DM the requester a confirmation we can later edit on resolution
    try {
      const im = await client.conversations.open({ users: slackId });
      const ch = im.channel?.id;
      if (ch) {
        const res = await client.chat.postMessage({
          channel: ch,
          text: 'Solicitud enviada',
          blocks: timeOffRequesterBlocks({ type: type!, startDate: startDate!, endDate: endDate!, reason })
        });
        if (res.ts) setRequesterDm(req.id, ch, res.ts);
      }
    } catch (e) {
      console.error('solicitar: failed to DM requester:', e);
    }
  });
}
