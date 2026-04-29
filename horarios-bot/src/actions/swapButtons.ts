import { App } from '@slack/bolt';
import { config } from '../config';
import {
  getSwapRequest,
  markPartnerAccepted,
  markPartnerRejected,
  markApproverRejected,
  approveAndExecute,
  setApprovalDM,
  AssignmentSnapshot
} from '../services/swaps';
import {
  swapApproverDMBlocks,
  swapResolvedBlocks,
  swapPartnerDMBlocks
} from '../ui/blocks';

export function registerSwapButtons(app: App) {
  app.action('swap_partner_accept', async ({ ack, body, action, client }) => {
    await ack();
    const id = parseInt((action as any).value, 10);
    const swap = getSwapRequest(id);
    if (!swap) return;

    const actor = (body as any).user?.id;
    if (actor !== swap.partner_slack_id) {
      await ephemeral(client, body, '❌ Solo el compañero invitado puede responder.');
      return;
    }
    if (swap.status !== 'pending_partner') {
      await ephemeral(client, body, `⚠️ Esta solicitud ya está en estado: ${swap.status}.`);
      return;
    }

    markPartnerAccepted(id);

    const snap = parseSnapshots(swap);
    const previewArgs = {
      swapId: id,
      requesterSlackId: swap.requester_slack_id,
      partnerSlackId: swap.partner_slack_id,
      requesterDate: swap.requester_date,
      partnerDate: swap.partner_date,
      requesterSnapshot: snap.req,
      partnerSnapshot: snap.partner,
      note: swap.note
    };

    // Update the partner's own DM to reflect they accepted (no buttons)
    if (swap.partner_dm_channel && swap.partner_dm_ts) {
      try {
        await client.chat.update({
          channel: swap.partner_dm_channel,
          ts: swap.partner_dm_ts,
          text: 'Aceptaste el cambio. Esperando aprobación del manager.',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: '✅ *Aceptaste el cambio.* Esperando aprobación del manager.' } },
            ...swapPartnerDMBlocks(previewArgs).slice(1, 2)
          ]
        });
      } catch (e) { console.error('partner DM update failed:', e); }
    }

    // Notify requester
    try {
      await client.chat.postMessage({
        channel: swap.requester_slack_id,
        text: `✅ <@${swap.partner_slack_id}> aceptó tu solicitud #${id}. Pendiente de aprobación del manager.`
      });
    } catch { /* ignore */ }

    // DM all approvers
    const approvers = config.managerSlackIds.filter(Boolean);
    const sentTargets: string[] = [];
    let lastChannel = ''; let lastTs = '';
    for (const mgr of approvers) {
      try {
        const open = await client.conversations.open({ users: mgr });
        const ch = (open as any).channel?.id as string;
        const post = await client.chat.postMessage({
          channel: ch,
          text: `🔁 Cambio de turno pendiente de aprobación (#${id})`,
          blocks: swapApproverDMBlocks(previewArgs)
        });
        sentTargets.push(`${ch}:${post.ts}`);
        lastChannel = ch; lastTs = post.ts!;
      } catch (e) { console.error('approver DM failed for', mgr, e); }
    }
    if (sentTargets.length) setApprovalDM(id, lastChannel, lastTs, sentTargets);
  });

  app.action('swap_partner_reject', async ({ ack, body, action, client }) => {
    await ack();
    const id = parseInt((action as any).value, 10);
    const swap = getSwapRequest(id);
    if (!swap) return;

    const actor = (body as any).user?.id;
    if (actor !== swap.partner_slack_id) {
      await ephemeral(client, body, '❌ Solo el compañero invitado puede responder.');
      return;
    }
    if (swap.status !== 'pending_partner') {
      await ephemeral(client, body, `⚠️ Esta solicitud ya está en estado: ${swap.status}.`);
      return;
    }

    markPartnerRejected(id, null);
    const snap = parseSnapshots(swap);
    const blocks = swapResolvedBlocks({
      swapId: id,
      status: 'rejected_partner',
      requesterSlackId: swap.requester_slack_id,
      partnerSlackId: swap.partner_slack_id,
      requesterDate: swap.requester_date,
      partnerDate: swap.partner_date,
      requesterSnapshot: snap.req,
      partnerSnapshot: snap.partner,
      note: swap.note,
      resolverSlackId: actor
    });

    if (swap.partner_dm_channel && swap.partner_dm_ts) {
      try {
        await client.chat.update({
          channel: swap.partner_dm_channel, ts: swap.partner_dm_ts,
          text: 'Rechazaste la solicitud.', blocks
        });
      } catch { /* ignore */ }
    }
    try {
      await client.chat.postMessage({
        channel: swap.requester_slack_id,
        text: `❌ <@${swap.partner_slack_id}> rechazó tu solicitud #${id}.`
      });
    } catch { /* ignore */ }
  });

  app.action('swap_approve', async ({ ack, body, action, client }) => {
    await ack();
    const id = parseInt((action as any).value, 10);
    const actor = (body as any).user?.id;
    await handleApprovalDecision(client, id, actor, true);
  });

  app.action('swap_reject', async ({ ack, body, action, client }) => {
    await ack();
    const id = parseInt((action as any).value, 10);
    const actor = (body as any).user?.id;
    await handleApprovalDecision(client, id, actor, false);
  });
}

async function handleApprovalDecision(client: any, id: number, actor: string, approve: boolean) {
  const swap = getSwapRequest(id);
  if (!swap) return;

  if (!config.managerSlackIds.includes(actor)) {
    await client.chat.postMessage({
      channel: actor,
      text: '❌ Solo managers pueden aprobar cambios de turno.'
    }).catch(() => {});
    return;
  }
  if (swap.status !== 'pending_approval') {
    await client.chat.postMessage({
      channel: actor,
      text: `⚠️ Solicitud #${id} ya estaba en estado: ${swap.status}.`
    }).catch(() => {});
    return;
  }

  let result: { ok: true } | { ok: false; reason: string };
  if (approve) {
    result = approveAndExecute(id, actor);
  } else {
    markApproverRejected(id, actor, null);
    result = { ok: true };
  }

  if (!result.ok) {
    await client.chat.postMessage({
      channel: actor,
      text: `❌ No se pudo aprobar la solicitud #${id}: ${result.reason}`
    }).catch(() => {});
    return;
  }

  const fresh = getSwapRequest(id)!;
  const snap = parseSnapshots(fresh);
  const finalStatus = approve ? 'approved' : 'rejected_approver';
  const blocks = swapResolvedBlocks({
    swapId: id,
    status: finalStatus,
    requesterSlackId: fresh.requester_slack_id,
    partnerSlackId: fresh.partner_slack_id,
    requesterDate: fresh.requester_date,
    partnerDate: fresh.partner_date,
    requesterSnapshot: snap.req,
    partnerSnapshot: snap.partner,
    note: fresh.note,
    resolverSlackId: actor
  });

  // Update all approver DMs (so everyone sees the resolution)
  const targets = parseTargets(fresh.approval_dm_targets);
  for (const t of targets) {
    const [ch, ts] = t.split(':');
    try {
      await client.chat.update({ channel: ch, ts, text: `Solicitud #${id} resuelta`, blocks });
    } catch (e) { console.error('approver DM update failed:', e); }
  }
  // Update partner DM too
  if (fresh.partner_dm_channel && fresh.partner_dm_ts) {
    try {
      await client.chat.update({
        channel: fresh.partner_dm_channel, ts: fresh.partner_dm_ts,
        text: `Solicitud #${id} resuelta`, blocks
      });
    } catch { /* ignore */ }
  }

  // Notify requester + partner
  const verb = approve ? 'aprobada y aplicada' : 'rechazada por el manager';
  for (const u of [fresh.requester_slack_id, fresh.partner_slack_id]) {
    try {
      await client.chat.postMessage({
        channel: u,
        text: `${approve ? '✅' : '❌'} Solicitud #${id} ${verb} por <@${actor}>.`
      });
    } catch { /* ignore */ }
  }
}

async function ephemeral(client: any, body: any, text: string) {
  const ch = body.channel?.id || body.user?.id;
  const user = body.user?.id;
  if (!ch || !user) return;
  try {
    await client.chat.postEphemeral({ channel: ch, user, text });
  } catch {
    try { await client.chat.postMessage({ channel: user, text }); } catch { /* ignore */ }
  }
}

function parseSnapshots(swap: { requester_snapshot: string; partner_snapshot: string }): {
  req: AssignmentSnapshot; partner: AssignmentSnapshot
} {
  return {
    req: JSON.parse(swap.requester_snapshot),
    partner: JSON.parse(swap.partner_snapshot)
  };
}

function parseTargets(s: string | null): string[] {
  if (!s) return [];
  try { return JSON.parse(s) as string[]; } catch { return []; }
}
