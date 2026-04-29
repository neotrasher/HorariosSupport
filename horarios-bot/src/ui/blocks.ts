import { ShiftDef } from '../config';
import type { ShiftState } from '../services/punches';
import { describeSnapshot, AssignmentSnapshot } from '../services/swaps';

export function punchButtonsBlocks(opts: {
  state: ShiftState;
  dept: string;
  shift: ShiftDef;
  shiftDate: string;
  startISO: string;
  endISO: string;
}) {
  const { state, dept, shift, shiftDate, startISO, endISO } = opts;
  const startEpoch = Math.floor(new Date(startISO).getTime() / 1000);
  const endEpoch = Math.floor(new Date(endISO).getTime() / 1000);

  const stateLabel = {
    off: '⚪ Sin marcar',
    in: '🟢 En turno',
    on_break: '🟠 En break',
    completed: '✅ Turno finalizado'
  }[state];

  const value = `${shiftDate}|${dept}|${shift.id}`;

  const buttons: any[] = [];
  if (state === 'off') {
    buttons.push({
      type: 'button', style: 'primary',
      text: { type: 'plain_text', text: 'Clock In' },
      action_id: 'punch_clock_in', value
    });
  }
  if (state === 'in') {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Break In' },
      action_id: 'punch_break_in', value
    });
    buttons.push({
      type: 'button', style: 'danger',
      text: { type: 'plain_text', text: 'Clock Out' },
      action_id: 'punch_clock_out', value
    });
  }
  if (state === 'on_break') {
    buttons.push({
      type: 'button', style: 'primary',
      text: { type: 'plain_text', text: 'Break Out' },
      action_id: 'punch_break_out', value
    });
    buttons.push({
      type: 'button', style: 'danger',
      text: { type: 'plain_text', text: 'Clock Out' },
      action_id: 'punch_clock_out', value
    });
  }
  // state === 'completed' → no buttons; message frozen as "Turno finalizado"

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Tu turno de hoy* — ${dept} ${shift.label}\n` +
              `🕐 <!date^${startEpoch}^{time}|${shift.startHour}:00 UTC> → <!date^${endEpoch}^{time}|${shift.endHour}:00 UTC>\n` +
              `Estado: ${stateLabel}`
      }
    },
    ...(buttons.length ? [{ type: 'actions', elements: buttons }] : []),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Fecha: ${shiftDate} · Turno: ${shift.id}_` }]
    }
  ];
}

function fmtDateLong(iso: string): string {
  // iso = "YYYY-MM-DD"
  const dt = new Date(iso + 'T00:00:00Z');
  const days = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${days[dt.getUTCDay()]} ${dt.getUTCDate()} ${months[dt.getUTCMonth()]}`;
}

export function swapPreviewSection(opts: {
  requesterSlackId: string;
  partnerSlackId: string;
  requesterDate: string;
  partnerDate: string;
  requesterSnapshot: AssignmentSnapshot;
  partnerSnapshot: AssignmentSnapshot;
  note: string | null;
}) {
  const lines = [
    `*<@${opts.requesterSlackId}>* entrega:`,
    `  • ${fmtDateLong(opts.requesterDate)} (${opts.requesterDate}) — ${describeSnapshot(opts.requesterSnapshot)}`,
    ``,
    `*<@${opts.partnerSlackId}>* entrega:`,
    `  • ${fmtDateLong(opts.partnerDate)} (${opts.partnerDate}) — ${describeSnapshot(opts.partnerSnapshot)}`,
  ];
  if (opts.note) {
    lines.push('', `_Nota:_ ${opts.note}`);
  }
  return { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } };
}

export function swapPartnerDMBlocks(opts: {
  swapId: number;
  requesterSlackId: string;
  partnerSlackId: string;
  requesterDate: string;
  partnerDate: string;
  requesterSnapshot: AssignmentSnapshot;
  partnerSnapshot: AssignmentSnapshot;
  note: string | null;
}) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `🔁 *Solicitud de cambio de turno* de <@${opts.requesterSlackId}>` }
    },
    swapPreviewSection(opts),
    {
      type: 'actions',
      elements: [
        {
          type: 'button', style: 'primary',
          text: { type: 'plain_text', text: 'Aceptar' },
          action_id: 'swap_partner_accept',
          value: String(opts.swapId)
        },
        {
          type: 'button', style: 'danger',
          text: { type: 'plain_text', text: 'Rechazar' },
          action_id: 'swap_partner_reject',
          value: String(opts.swapId)
        }
      ]
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `_Solicitud #${opts.swapId} · pendiente de tu respuesta_` }] }
  ];
}

export function swapApproverDMBlocks(opts: {
  swapId: number;
  requesterSlackId: string;
  partnerSlackId: string;
  requesterDate: string;
  partnerDate: string;
  requesterSnapshot: AssignmentSnapshot;
  partnerSnapshot: AssignmentSnapshot;
  note: string | null;
}) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `🔁 *Cambio de turno pendiente de aprobación*\n<@${opts.partnerSlackId}> aceptó la solicitud de <@${opts.requesterSlackId}>.` }
    },
    swapPreviewSection(opts),
    {
      type: 'actions',
      elements: [
        {
          type: 'button', style: 'primary',
          text: { type: 'plain_text', text: 'Aprobar' },
          action_id: 'swap_approve',
          value: String(opts.swapId)
        },
        {
          type: 'button', style: 'danger',
          text: { type: 'plain_text', text: 'Rechazar' },
          action_id: 'swap_reject',
          value: String(opts.swapId)
        }
      ]
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `_Solicitud #${opts.swapId}_` }] }
  ];
}

export function swapResolvedBlocks(opts: {
  swapId: number;
  status: 'approved' | 'rejected_partner' | 'rejected_approver' | 'cancelled';
  requesterSlackId: string;
  partnerSlackId: string;
  requesterDate: string;
  partnerDate: string;
  requesterSnapshot: AssignmentSnapshot;
  partnerSnapshot: AssignmentSnapshot;
  note: string | null;
  resolverSlackId?: string | null;
  reason?: string | null;
}) {
  const headers: Record<string, string> = {
    approved: '✅ Cambio de turno aprobado y aplicado',
    rejected_partner: '❌ Solicitud rechazada por el compañero',
    rejected_approver: '❌ Solicitud rechazada por el aprobador',
    cancelled: '⚠️ Solicitud cancelada'
  };
  const blocks: any[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${headers[opts.status]}*` } },
    swapPreviewSection(opts)
  ];
  const ctx: string[] = [`Solicitud #${opts.swapId}`];
  if (opts.resolverSlackId) ctx.push(`por <@${opts.resolverSlackId}>`);
  if (opts.reason) ctx.push(`_${opts.reason}_`);
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ctx.join(' · ') }] });
  return blocks;
}

export function attendancePostBlocks(opts: {
  agentName: string; type: string; ts: string; dept: string; shiftId: string;
  excessMin?: number;
}) {
  const emoji = {
    clock_in: '🟢',
    clock_out: '🔴',
    break_in: '☕',
    break_out: '🔄'
  }[opts.type] || '•';
  const action = {
    clock_in: 'marcó entrada',
    clock_out: 'marcó salida',
    break_in: 'comenzó break',
    break_out: 'regresó del break'
  }[opts.type] || opts.type;
  const epoch = Math.floor(new Date(opts.ts).getTime() / 1000);
  const excess = opts.excessMin && opts.excessMin > 0 ? ` · ⚠️ *+${opts.excessMin} min extra*` : '';
  return [{
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `${emoji} *${opts.agentName}* ${action} · ${opts.dept} ${opts.shiftId} · <!date^${epoch}^{time}|${opts.ts} UTC>${excess}`
    }]
  }];
}
