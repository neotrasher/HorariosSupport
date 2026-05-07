/**
 * Daily checker — runs once per day. Sends:
 *   🎂 Birthday → message in attendance channel for today's birthdays
 *   📋 Evaluation reminder → DM to admins, 7 days before next_evaluation_date
 *
 * Uses daily_notifications table to dedupe (so multiple invocations on same UTC
 * day don't resend).
 */
import { App } from '@slack/bolt';
import { DateTime } from 'luxon';
import { db } from '../db';
import { config } from '../config';
import { listAgents } from '../services/agents';

/** True if we already sent this kind of notification for this target on this UTC date. */
function alreadySent(kind: string, target: string, date: string): boolean {
  const r = db.prepare(
    'SELECT 1 FROM daily_notifications WHERE kind = ? AND target = ? AND date = ?'
  ).get(kind, target, date);
  return !!r;
}

function markSent(kind: string, target: string, date: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO daily_notifications (kind, target, date) VALUES (?, ?, ?)'
  ).run(kind, target, date);
}

/** Returns true if `birthdate` (YYYY-MM-DD) matches today's month-day. */
function isBirthdayToday(birthdate: string, today: DateTime): boolean {
  const m = birthdate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  return today.month === month && today.day === day;
}

/** Computes age (years) on `today` based on birthdate. */
function ageOn(birthdate: string, today: DateTime): number | null {
  const m = birthdate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  let age = today.year - y;
  if (today.month < mo || (today.month === mo && today.day < d)) age--;
  return age >= 0 && age < 150 ? age : null;
}

export async function runDailyAlertsChecker(app: App): Promise<void> {
  const today = DateTime.utc();
  const todayStr = today.toFormat('yyyy-LL-dd');
  const agents = listAgents(); // active agents only

  // ── 🎂 Birthdays ──────────────────────────────────────────────────────
  for (const a of agents) {
    if (!a.birthdate) continue;
    if (!isBirthdayToday(a.birthdate, today)) continue;
    if (alreadySent('birthday', a.slack_id, todayStr)) continue;

    const age = ageOn(a.birthdate, today);
    const ageText = age != null ? ` cumple ${age} años hoy` : ' está de cumpleaños hoy';
    const text = `🎉🎂 ¡Feliz cumpleaños, <@${a.slack_id}>!${ageText} El equipo te desea un día genial. 🎈`;

    if (config.attendanceChannelId) {
      try {
        await app.client.chat.postMessage({
          channel: config.attendanceChannelId,
          text,
          unfurl_links: false
        });
        markSent('birthday', a.slack_id, todayStr);
      } catch (e) {
        console.error(`birthday post failed for ${a.slack_id}:`, e);
      }
    } else {
      // No channel configured — fallback to admin DMs so it isn't lost
      for (const adminId of config.adminSlackIds) {
        try {
          const im = await app.client.conversations.open({ users: adminId });
          const ch = (im as any).channel?.id;
          if (ch) await app.client.chat.postMessage({ channel: ch, text });
        } catch {}
      }
      markSent('birthday', a.slack_id, todayStr);
    }
  }

  // ── 📋 Evaluation reminders (7 days before) ──────────────────────────
  const targetDate = today.plus({ days: 7 }).toFormat('yyyy-LL-dd');
  for (const a of agents) {
    if (!a.next_evaluation_date) continue;
    if (a.next_evaluation_date !== targetDate) continue;
    if (alreadySent('evaluation_reminder', a.slack_id, todayStr)) continue;

    const text =
      `📋 Recordatorio de evaluación · *${a.name}* (${a.dept}) tiene su próxima evaluación el *${a.next_evaluation_date}* (en 7 días).` +
      `\n• Slack: <@${a.slack_id}>` +
      (a.last_evaluation_date ? `\n• Última evaluación: ${a.last_evaluation_date}` : '');

    let anySent = false;
    for (const adminId of config.adminSlackIds) {
      try {
        const im = await app.client.conversations.open({ users: adminId });
        const ch = (im as any).channel?.id;
        if (ch) {
          await app.client.chat.postMessage({ channel: ch, text });
          anySent = true;
        }
      } catch (e) {
        console.error(`evaluation reminder DM failed for admin ${adminId}:`, e);
      }
    }
    if (anySent) markSent('evaluation_reminder', a.slack_id, todayStr);
  }
}
