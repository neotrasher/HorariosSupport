import { randomUUID } from 'crypto';
import { db } from '../db';

export interface CalendarToken {
  slack_id: string;
  token: string;
  created_at: string;
  last_used_at: string | null;
}

/** Get the existing token for an agent, or null if none. */
export function getTokenForAgent(slackId: string): CalendarToken | null {
  return db.prepare('SELECT * FROM agent_calendar_tokens WHERE slack_id = ?')
    .get(slackId) as CalendarToken | null;
}

/** Get the agent's slack_id from a token string. Also updates last_used_at. */
export function getSlackIdByToken(token: string): string | null {
  const row = db.prepare('SELECT slack_id FROM agent_calendar_tokens WHERE token = ?')
    .get(token) as { slack_id: string } | undefined;
  if (!row) return null;
  db.prepare("UPDATE agent_calendar_tokens SET last_used_at = datetime('now') WHERE token = ?")
    .run(token);
  return row.slack_id;
}

/** Generate (or regenerate) a calendar token for an agent. Returns the new token. */
export function generateToken(slackId: string): string {
  const token = randomUUID();
  db.prepare(`
    INSERT INTO agent_calendar_tokens (slack_id, token)
    VALUES (?, ?)
    ON CONFLICT(slack_id) DO UPDATE SET token = excluded.token, created_at = datetime('now'), last_used_at = NULL
  `).run(slackId, token);
  return token;
}

/** Revoke (delete) the token for an agent. */
export function revokeToken(slackId: string): void {
  db.prepare('DELETE FROM agent_calendar_tokens WHERE slack_id = ?').run(slackId);
}
