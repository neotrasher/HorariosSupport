import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { getAgentBySlackId } from '../services/agents';
import {
  getAssignmentForDate,
  snapshotOf,
  describeAssignment,
  findOverlappingPending,
  createSwapRequest,
  setPartnerDM,
  getSwapRequest
} from '../services/swaps';
import { swapPartnerDMBlocks } from '../ui/blocks';

const MIN_HOURS_AHEAD = 24;

/**
 * /horario-swap → opens a modal to request a shift swap.
 * Flow: requester submits → DM to partner with Aceptar/Rechazar →
 *       on accept, DM to all managers with Aprobar/Rechazar.
 */
export function registerHorarioSwap(app: App) {
  app.command('/horario-swap', async ({ ack, body, client }) => {
    await ack();

    const requester = getAgentBySlackId(body.user_id);
    if (!requester) {
      await client.chat.postEphemeral({
        channel: body.channel_id,
        user: body.user_id,
        text: '❌ No estás vinculado al planner. Pídele al manager que ejecute `/horario-link`.'
      }).catch(() => {});
      return;
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'horario_swap_submit',
        title: { type: 'plain_text', text: 'Cambio de turno' },
        submit: { type: 'plain_text', text: 'Solicitar' },
        close: { type: 'plain_text', text: 'Cancelar' },
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'Solicita un intercambio con un compañero. Las solicitudes deben hacerse al menos *24 horas antes* del turno más cercano.' }
          },
          {
            type: 'input',
            block_id: 'my_date_block',
            label: { type: 'plain_text', text: 'Mi fecha (la que entrego)' },
            element: { type: 'datepicker', action_id: 'my_date' }
          },
          {
            type: 'input',
            block_id: 'partner_block',
            label: { type: 'plain_text', text: 'Compañero' },
            element: { type: 'users_select', action_id: 'partner' }
          },
          {
            type: 'input',
            block_id: 'partner_date_block',
            label: { type: 'plain_text', text: 'Fecha del compañero (la que recibo)' },
            element: { type: 'datepicker', action_id: 'partner_date' }
          },
          {
            type: 'input',
            block_id: 'note_block',
            optional: true,
            label: { type: 'plain_text', text: 'Nota' },
            element: { type: 'plain_text_input', action_id: 'note', multiline: true }
          }
        ]
      }
    });
  });

  app.view('horario_swap_submit', async ({ ack, view, body, client }) => {
    const v = view.state.values;
    const requesterSlackId = body.user.id;
    const myDate = v.my_date_block.my_date.selected_date as string | undefined;
    const partnerSlackId = v.partner_block.partner.selected_user as string | undefined;
    const partnerDate = v.partner_date_block.partner_date.selected_date as string | undefined;
    const note = (v.note_block.note.value as string | undefined)?.trim() || null;

    if (!myDate || !partnerSlackId || !partnerDate) {
      await ack({
        response_action: 'errors',
        errors: {
          my_date_block: !myDate ? 'Requerido' : '',
          partner_block: !partnerSlackId ? 'Requerido' : '',
          partner_date_block: !partnerDate ? 'Requerido' : ''
        } as any
      });
      return;
    }

    if (partnerSlackId === requesterSlackId) {
      await ack({
        response_action: 'errors',
        errors: { partner_block: 'No puedes intercambiar contigo mismo' }
      });
      return;
    }

    const requester = getAgentBySlackId(requesterSlackId);
    const partner = getAgentBySlackId(partnerSlackId);
    if (!requester) {
      await ack({ response_action: 'errors', errors: { my_date_block: 'No estás vinculado al planner' } });
      return;
    }
    if (!partner) {
      await ack({ response_action: 'errors', errors: { partner_block: 'El compañero no está vinculado al planner' } });
      return;
    }

    const myDT = DateTime.fromISO(myDate, { zone: 'utc' });
    const partnerDT = DateTime.fromISO(partnerDate, { zone: 'utc' });
    if (!myDT.isValid || !partnerDT.isValid) {
      await ack({ response_action: 'errors', errors: { my_date_block: 'Fecha inválida' } });
      return;
    }

    const myAssign = getAssignmentForDate(requester.planner_id, myDT);
    const partnerAssign = getAssignmentForDate(partner.planner_id, partnerDT);
    if (!myAssign) {
      await ack({
        response_action: 'errors',
        errors: { my_date_block: 'No tienes una asignación clara ese día (puede ser que la semana no esté cargada o tengas múltiples turnos)' }
      });
      return;
    }
    if (!partnerAssign) {
      await ack({
        response_action: 'errors',
        errors: { partner_date_block: 'El compañero no tiene una asignación clara ese día' }
      });
      return;
    }
    if (myAssign.kind === 'off' && partnerAssign.kind === 'off') {
      await ack({
        response_action: 'errors',
        errors: { my_date_block: 'Ambos tienen día libre, no hay nada que intercambiar' }
      });
      return;
    }

    // 24h cutoff: earliest start time of either assignment must be ≥24h from now.
    const now = DateTime.utc();
    const earliestStart = earliestStartUTC(myDT, myAssign, partnerDT, partnerAssign);
    if (earliestStart && earliestStart.diff(now, 'hours').hours < MIN_HOURS_AHEAD) {
      await ack({
        response_action: 'errors',
        errors: { my_date_block: `Las solicitudes deben hacerse con al menos ${MIN_HOURS_AHEAD}h de antelación` }
      });
      return;
    }

    const overlap = findOverlappingPending(requesterSlackId, partnerSlackId, myDate, partnerDate);
    if (overlap) {
      await ack({
        response_action: 'errors',
        errors: { my_date_block: `Ya hay una solicitud pendiente (#${overlap.id}) que toca alguna de estas fechas` }
      });
      return;
    }

    await ack();

    const id = createSwapRequest({
      requesterSlackId,
      partnerSlackId,
      requesterDate: myDate,
      partnerDate,
      requesterSnapshot: snapshotOf(myAssign),
      partnerSnapshot: snapshotOf(partnerAssign),
      note
    });

    const swap = getSwapRequest(id)!;
    const dmBlocks = swapPartnerDMBlocks({
      swapId: id,
      requesterSlackId,
      partnerSlackId,
      requesterDate: myDate,
      partnerDate,
      requesterSnapshot: snapshotOf(myAssign),
      partnerSnapshot: snapshotOf(partnerAssign),
      note
    });

    try {
      const open = await client.conversations.open({ users: partnerSlackId });
      const channel = (open as any).channel?.id as string;
      const post = await client.chat.postMessage({
        channel,
        text: `🔁 Solicitud de cambio de turno de <@${requesterSlackId}>`,
        blocks: dmBlocks
      });
      setPartnerDM(id, channel, post.ts!);
    } catch (e) {
      console.error('Failed to DM partner for swap', id, e);
    }

    try {
      await client.chat.postMessage({
        channel: requesterSlackId,
        text: `✅ Solicitud #${id} enviada a <@${partnerSlackId}>.\n` +
              `Tú entregas: ${describeAssignment(myAssign)} (${myDate})\n` +
              `Recibes: ${describeAssignment(partnerAssign)} (${partnerDate})`
      });
    } catch { /* ignore */ }
  });
}

function earliestStartUTC(
  reqDate: DateTime, reqAssign: ReturnType<typeof getAssignmentForDate>,
  partnerDate: DateTime, partnerAssign: ReturnType<typeof getAssignmentForDate>
): DateTime | null {
  const candidates: DateTime[] = [];
  if (reqAssign?.kind === 'shift') {
    candidates.push(reqDate.startOf('day').plus({ hours: reqAssign.shift.startHour }));
  } else if (reqAssign?.kind === 'off') {
    candidates.push(reqDate.startOf('day'));
  }
  if (partnerAssign?.kind === 'shift') {
    candidates.push(partnerDate.startOf('day').plus({ hours: partnerAssign.shift.startHour }));
  } else if (partnerAssign?.kind === 'off') {
    candidates.push(partnerDate.startOf('day'));
  }
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (a < b ? a : b));
}
