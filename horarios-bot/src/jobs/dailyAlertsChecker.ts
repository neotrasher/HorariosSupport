/**
 * Daily checker — runs once per day. Sends:
 *   🎂 Birthday               → message in attendance channel for today's birthdays
 *   🎉 Work anniversary       → message in attendance channel when start_date hits
 *   📋 Evaluation reminder    → DM to admins, configurable days before
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

/**
 * Extract month + day (and optional year) from a birthdate / start_date field.
 * Accepts both 'YYYY-MM-DD' (full) and 'MM-DD' (partial, no year known).
 */
function parseDateParts(s: string): { month: number; day: number; year: number | null } | null {
  const full = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (full) {
    return { year: parseInt(full[1], 10), month: parseInt(full[2], 10), day: parseInt(full[3], 10) };
  }
  const partial = s.match(/^(\d{2})-(\d{2})$/);
  if (partial) {
    return { year: null, month: parseInt(partial[1], 10), day: parseInt(partial[2], 10) };
  }
  return null;
}

function isAnnualMatchToday(s: string, today: DateTime): boolean {
  const p = parseDateParts(s);
  if (!p) return false;
  return today.month === p.month && today.day === p.day;
}

/** Returns null if year unknown or invalid. */
function ageOn(birthdate: string, today: DateTime): number | null {
  const p = parseDateParts(birthdate);
  if (!p || p.year === null) return null;
  let age = today.year - p.year;
  if (today.month < p.month || (today.month === p.month && today.day < p.day)) age--;
  return age >= 0 && age < 150 ? age : null;
}

/** Years of service on `today` based on start_date. Null if no year or start in future. */
function yearsOfServiceOn(startDate: string, today: DateTime): number | null {
  const p = parseDateParts(startDate);
  if (!p || p.year === null) return null;
  let years = today.year - p.year;
  if (today.month < p.month || (today.month === p.month && today.day < p.day)) years--;
  return years > 0 && years < 100 ? years : null;
}

/** Pick a random URL from a comma/newline-separated config string. Returns null if empty. */
function randomGif(urlsConfig: string): string | null {
  if (!urlsConfig) return null;
  const list = urlsConfig
    .split(/[,\n]/)
    .map(s => s.trim())
    .filter(s => /^https?:\/\//.test(s));
  if (list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

/** Compose final message: optional mention prefix, body, optional GIF on its own line. */
function composeMessage(opts: { mention: string; body: string; gif: string | null }): string {
  const mentionPart = opts.mention ? `${opts.mention} ` : '';
  const gifPart = opts.gif ? `\n${opts.gif}` : '';
  return `${mentionPart}${opts.body}${gifPart}`;
}

async function postToChannelOrAdminDm(app: App, text: string): Promise<boolean> {
  if (config.attendanceChannelId) {
    try {
      await app.client.chat.postMessage({
        channel: config.attendanceChannelId,
        text,
        unfurl_links: true,   // we want GIFs to render
        unfurl_media: true
      });
      return true;
    } catch (e) {
      console.error('post failed:', e);
      return false;
    }
  }
  // Fallback: DM each admin
  let any = false;
  for (const adminId of config.adminSlackIds) {
    try {
      const im = await app.client.conversations.open({ users: adminId });
      const ch = (im as any).channel?.id;
      if (ch) {
        await app.client.chat.postMessage({ channel: ch, text });
        any = true;
      }
    } catch {}
  }
  return any;
}

export async function runDailyAlertsChecker(app: App): Promise<void> {
  const today = DateTime.utc();
  const todayStr = today.toFormat('yyyy-LL-dd');
  const agents = listAgents(); // active agents only

  // ── 🎂 Birthdays ──────────────────────────────────────────────────────
  for (const a of agents) {
    if (!a.birthdate) continue;
    if (!isAnnualMatchToday(a.birthdate, today)) continue;
    if (alreadySent('birthday', a.slack_id, todayStr)) continue;

    const age = ageOn(a.birthdate, today);
    const ageText = age != null ? ` cumple *${age} años* hoy` : ' está de cumpleaños hoy';
    const body = `🎉🎂 ¡Feliz cumpleaños, <@${a.slack_id}>!${ageText} El equipo te desea un día genial. 🎈`;
    const text = composeMessage({
      mention: config.birthdayMention,
      body,
      gif: randomGif(config.birthdayGifUrls)
    });

    const sent = await postToChannelOrAdminDm(app, text);
    if (sent) markSent('birthday', a.slack_id, todayStr);
  }

  // ── 🎉 Work anniversary ───────────────────────────────────────────────
  for (const a of agents) {
    if (!a.start_date) continue;
    if (!isAnnualMatchToday(a.start_date, today)) continue;
    if (alreadySent('anniversary', a.slack_id, todayStr)) continue;

    const years = yearsOfServiceOn(a.start_date, today);
    if (years === null || years < 1) continue; // first day or invalid → skip

    const yearLabel = years === 1 ? '1 año' : `${years} años`;
    const body = `🎉🎈 Hoy <@${a.slack_id}> cumple *${yearLabel}* en el equipo. ¡Gracias por tu trabajo y dedicación! 🙌`;
    const text = composeMessage({
      mention: config.anniversaryMention || config.birthdayMention,
      body,
      gif: randomGif(config.anniversaryGifUrls)
    });

    const sent = await postToChannelOrAdminDm(app, text);
    if (sent) markSent('anniversary', a.slack_id, todayStr);
  }

  // ── 📋 Evaluation reminders (config.evaluationReminderDays before) ───
  const reminderDays = config.evaluationReminderDays;
  const targetDate = today.plus({ days: reminderDays }).toFormat('yyyy-LL-dd');
  for (const a of agents) {
    if (!a.next_evaluation_date) continue;
    if (a.next_evaluation_date !== targetDate) continue;
    if (alreadySent('evaluation_reminder', a.slack_id, todayStr)) continue;

    const text =
      `📋 Recordatorio de evaluación · *${a.name}* (${a.dept}) tiene su próxima evaluación el *${a.next_evaluation_date}* (en ${reminderDays} días).` +
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
