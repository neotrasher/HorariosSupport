/**
 * Public ICS calendar feed — no authentication required.
 * GET /cal/:token.ics
 *
 * Returns a valid iCalendar file with the agent's upcoming shifts (±90 days).
 * Subscribe once in Google Calendar / Outlook / Apple Calendar and it auto-updates.
 */
import { Router } from 'express';
import { DateTime } from 'luxon';
import { getSlackIdByToken } from '../../services/calendarTokens';
import { getAgentBySlackId } from '../../services/agents';
import { getShiftsForAgentRange, shiftWindow } from '../../services/schedule';

export const calendarRouter = Router();

/** Escape special characters for iCal text values. */
function icalEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** Format a DateTime as iCal UTC timestamp: 20240101T080000Z */
function toIcalDate(dt: DateTime): string {
  return dt.toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
}

/** A stable UID for a shift event — deterministic so re-fetches update rather than duplicate. */
function shiftUid(slackId: string, date: string, shiftId: string, dept: string): string {
  return `shift-${slackId}-${date}-${dept}-${shiftId}@horarios`;
}

calendarRouter.get('/:token.ics', (req, res) => {
  const { token } = req.params;

  const slackId = getSlackIdByToken(token);
  if (!slackId) {
    res.status(404).type('text/plain').send('Token no valido o expirado.');
    return;
  }

  const agent = getAgentBySlackId(slackId);
  if (!agent) {
    res.status(404).type('text/plain').send('Agente no encontrado.');
    return;
  }

  // Fetch shifts for the next 90 days + last 30 days (so past events stay in the calendar)
  const today = DateTime.utc();
  const startDate = today.minus({ days: 30 }).toFormat('yyyy-LL-dd');
  const endDate = today.plus({ days: 90 }).toFormat('yyyy-LL-dd');

  const shifts = getShiftsForAgentRange(agent.planner_id, startDate, endDate);

  const now = toIcalDate(today);
  const calName = icalEscape(`Horarios – ${agent.name}`);

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Horarios Support//ES',
    `X-WR-CALNAME:${calName}`,
    'X-WR-TIMEZONE:UTC',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  for (const rs of shifts) {
    const dateObj = DateTime.fromISO(rs.date, { zone: 'utc' });
    const w = shiftWindow(dateObj, rs);
    const uid = shiftUid(slackId, rs.date, rs.shift.id, rs.dept);
    const summary = icalEscape(`${rs.dept}.${rs.shift.id} – ${rs.shift.label}`);

    const noteParts: string[] = [];
    if (rs.note) noteParts.push(rs.note);
    if (rs.source === 'swap') noteParts.push('Cambio de turno');
    if (rs.source === 'manual') noteParts.push('Editado manualmente');
    const description = noteParts.length ? icalEscape(noteParts.join(' · ')) : '';

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${toIcalDate(w.start)}`);
    lines.push(`DTEND:${toIcalDate(w.end)}`);
    lines.push(`SUMMARY:${summary}`);
    if (description) lines.push(`DESCRIPTION:${description}`);
    lines.push(`CATEGORIES:Horario,${rs.dept}`);
    // Mark swapped shifts with a different color hint (not all clients support this)
    if (rs.source === 'swap') lines.push('COLOR:tomato');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  // iCalendar spec requires CRLF line endings
  const body = lines.join('\r\n') + '\r\n';

  const filename = `horario-${agent.name.replace(/\s+/g, '-').toLowerCase()}.ics`;
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Tell proxies/CDNs not to cache (so calendar apps always get fresh data)
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(body);
});
