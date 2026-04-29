import { App } from '@slack/bolt';
import { linkAgent, listAgents, unlinkAgent } from '../services/agents';
import { db } from '../db';

/**
 * /horario-link
 *   (no args)               → list current links
 *   @user planner_id [dept] → link Slack user to a planner_id (dept inferred if omitted)
 *   unlink @user            → mark user inactive
 */
export function registerHorarioLink(app: App) {
  app.command('/horario-link', async ({ ack, command, client, respond }) => {
    await ack();
    const text = (command.text || '').trim();

    if (!text) {
      const agents = listAgents();
      if (!agents.length) {
        await respond({
          response_type: 'ephemeral',
          text: '_No hay agentes vinculados aún._\nUso: `/horario-link @usuario planner_id [L1|L2]`'
        });
        return;
      }
      const lines = agents.map(a =>
        `• <@${a.slack_id}> → \`${a.planner_id}\` *${a.name}* (${a.dept})${a.role === 'manager' ? ' 👑' : ''}`
      );
      await respond({
        response_type: 'ephemeral',
        text: `*Agentes vinculados (${agents.length}):*\n${lines.join('\n')}`
      });
      return;
    }

    const parts = text.split(/\s+/);

    if (parts[0] === 'unlink' && parts[1]) {
      const slackId = parseUserMention(parts[1]);
      if (!slackId) {
        await respond({ response_type: 'ephemeral', text: '❌ Menciona al usuario con @' });
        return;
      }
      unlinkAgent(slackId);
      await respond({ response_type: 'ephemeral', text: `✅ <@${slackId}> desvinculado.` });
      return;
    }

    const slackId = parseUserMention(parts[0]);
    const plannerId = parseInt(parts[1], 10);
    let dept = (parts[2] || '').toUpperCase();

    if (!slackId || !plannerId) {
      await respond({
        response_type: 'ephemeral',
        text: 'Uso: `/horario-link @usuario planner_id [L1|L2]`\n' +
              'Ejemplo: `/horario-link @carlos 14 L2`\n' +
              'Listar: `/horario-link`\n' +
              'Quitar: `/horario-link unlink @usuario`'
      });
      return;
    }

    // Try to fetch Slack user info for the name
    let name = `User ${slackId}`;
    try {
      const info = await client.users.info({ user: slackId });
      name = info.user?.real_name || info.user?.name || name;
    } catch { /* ignore */ }

    if (!dept) {
      // Infer from existing schedules for this planner_id
      const row = db.prepare('SELECT dept FROM schedule_entries WHERE planner_id = ? LIMIT 1')
        .get(plannerId) as { dept: string } | undefined;
      dept = row?.dept || 'L1';
    }
    if (dept !== 'L1' && dept !== 'L2') {
      await respond({ response_type: 'ephemeral', text: '❌ El departamento debe ser L1 o L2.' });
      return;
    }

    linkAgent(slackId, plannerId, name, dept);
    await respond({
      response_type: 'ephemeral',
      text: `✅ <@${slackId}> (${name}) vinculado a planner_id \`${plannerId}\` (${dept}).`
    });
  });
}

function parseUserMention(s: string): string | null {
  // Slack mentions arrive as <@U01ABC123|name> or <@U01ABC123>
  const m = s.match(/<@([A-Z0-9]+)(\|[^>]+)?>/);
  return m ? m[1] : null;
}
