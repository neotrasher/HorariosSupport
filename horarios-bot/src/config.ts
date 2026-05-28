import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const config = {
  slack: {
    botToken: required('SLACK_BOT_TOKEN'),
    appToken: required('SLACK_APP_TOKEN'),
    signingSecret: required('SLACK_SIGNING_SECRET')
  },
  attendanceChannelId: process.env.ATTENDANCE_CHANNEL_ID || '',
  managerSlackIds: (process.env.MANAGER_SLACK_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  adminSlackIds: (process.env.ADMIN_SLACK_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  lateThresholdMin: parseInt(process.env.LATE_THRESHOLD_MIN || '15', 10),
  reminderLeadMin: parseInt(process.env.REMINDER_LEAD_MIN || '5', 10),
  // Block Break In if within this many minutes of shift end (don't break-and-leave)
  breakInLockoutMin: parseInt(process.env.BREAK_IN_LOCKOUT_MIN || '60', 10),
  // Maximum allowed break duration; reminder fires past this and excess is logged
  breakMaxMin: parseInt(process.env.BREAK_MAX_MIN || '60', 10),
  // Grace period (minutes) before clock-in or break-out is reported as late
  gracePeriodMin: parseInt(process.env.GRACE_PERIOD_MIN || '5', 10),
  // Grace period after shift end before auto-clockout fires (agent forgot to mark out)
  autoClockoutGraceMin: parseInt(process.env.AUTO_CLOCKOUT_GRACE_MIN || '30', 10),
  // Window after shift end during which auto-clockout will fire (don't fire after this)
  autoClockoutWindowMin: parseInt(process.env.AUTO_CLOCKOUT_WINDOW_MIN || '120', 10),
  // Days before next_evaluation_date when admins receive a reminder DM
  evaluationReminderDays: parseInt(process.env.EVALUATION_REMINDER_DAYS || '15', 10),
  // Slack text prepended to birthday/anniversary posts. Use mention syntax:
  //   <!channel>          → notifies channel
  //   <!subteam^S012345>  → notifies a user group (e.g. @support)
  //   Empty               → no mention
  birthdayMention:    process.env.BIRTHDAY_MENTION    || '',
  anniversaryMention: process.env.ANNIVERSARY_MENTION || '',
  // Comma-separated GIF URLs (Giphy/Tenor direct .gif links). Pick random per post.
  birthdayGifUrls:    process.env.BIRTHDAY_GIF_URLS    || '',
  anniversaryGifUrls: process.env.ANNIVERSARY_GIF_URLS || '',
  // Days to keep automatic DB backups before pruning
  dbBackupRetentionDays: parseInt(process.env.DB_BACKUP_RETENTION_DAYS || '30', 10),
  // Punctuality score weights — applied as: penalty = unmarked*Wu + late*Wl + autoClockout*Wa
  punctualityWeightUnmarked:    parseFloat(process.env.PUNCT_WEIGHT_UNMARKED     || '1.0'),
  punctualityWeightLate:        parseFloat(process.env.PUNCT_WEIGHT_LATE         || '0.4'),
  punctualityWeightAutoClockout:parseFloat(process.env.PUNCT_WEIGHT_AUTO_CLOCKOUT|| '0.5'),
  // Earliest date (UTC YYYY-MM-DD) to count shifts toward the punctuality score.
  // Shifts before this are completely ignored — useful when the bot wasn't yet
  // live for the team. Empty string = no cutoff, count all historical shifts.
  punctualityStartDate:         process.env.PUNCTUALITY_START_DATE || '',
  web: {
    port: parseInt(process.env.WEB_PORT || '3000', 10),
    slackClientId: process.env.SLACK_WEB_CLIENT_ID || '',
    slackClientSecret: process.env.SLACK_WEB_CLIENT_SECRET || '',
    slackRedirectUri: process.env.SLACK_WEB_REDIRECT_URI || 'https://localhost:3000/auth/slack/callback',
    sessionSecret: process.env.WEB_SESSION_SECRET || 'horarios-dev-secret-change-me',
    secureCookies: (process.env.WEB_SECURE_COOKIES || 'true').toLowerCase() === 'true'
  },
  dbPath: process.env.DB_PATH || './data/bot.db',
  anchorDate: process.env.ANCHOR_DATE || '2026-04-27',
  anchorCycle: (process.env.ANCHOR_CYCLE || 'A') as 'A' | 'B' | 'C' | 'D',
  // Cycle length in weeks: 3 (A/B/C) or 4 (A/B/C/D). Editable in /settings.
  cycleLength: parseInt(process.env.CYCLE_LENGTH || '4', 10) as 3 | 4,
  // Switchover date: when set (YYYY-MM-DD), dates BEFORE it use the legacy*
  // config below; dates ON OR AFTER use the current cycleLength/anchorDate/
  // anchorCycle. Empty string = no switchover (always use current).
  cycleSwitchoverDate: process.env.CYCLE_SWITCHOVER_DATE || '',
  legacyCycleLength: parseInt(process.env.LEGACY_CYCLE_LENGTH || '4', 10) as 3 | 4,
  legacyAnchorDate: process.env.LEGACY_ANCHOR_DATE || '',
  legacyAnchorCycle: (process.env.LEGACY_ANCHOR_CYCLE || 'A') as 'A' | 'B' | 'C' | 'D',
  // IANA timezone shown alongside UTC in status/hoy headers (e.g. America/Bogota)
  displayTimezone: process.env.DISPLAY_TIMEZONE || 'UTC',
  logLevel: process.env.LOG_LEVEL || 'info',
  cronDisabled: (process.env.CRON_DISABLED || '').toLowerCase() === 'true',
  // Skip Slack bot entirely (only run web server). Useful for staging where
  // we don't want to compete with prod for Slack events.
  slackDisabled: (process.env.SLACK_DISABLED || '').toLowerCase() === 'true',
  // Coordinación de breaks (cap por cohort, reservas opcionales, dashboard).
  // Si está apagado, el bot ignora el cap y se comporta como antes — útil
  // para rollback inmediato si la regla genera fricción. Default: ON.
  breaksCoordinationEnabled: (process.env.BREAKS_COORDINATION || 'true').toLowerCase() !== 'false'
};

export const DAYS = ['L', 'M', 'C', 'J', 'V', 'S', 'D'] as const;
export const DAY_FULL: Record<string, string> = {
  L: 'Lunes', M: 'Martes', C: 'Miércoles', J: 'Jueves',
  V: 'Viernes', S: 'Sábado', D: 'Domingo'
};
export const CYCLES = ['A', 'B', 'C', 'D'] as const;

/**
 * Active cycle letters based on config.cycleLength. If 3, returns ['A','B','C'];
 * if 4, returns the full ['A','B','C','D']. Use this for any "iterate cycles"
 * loop or "is this cycle valid?" check.
 */
export function activeCycles(): readonly ('A' | 'B' | 'C' | 'D')[] {
  return CYCLES.slice(0, config.cycleLength) as readonly ('A' | 'B' | 'C' | 'D')[];
}

// Shift definitions per dept (UTC hours, end_hour 24 = midnight next day)
export type ShiftDef = { id: string; label: string; startHour: number; endHour: number };
export const SHIFTS: Record<string, Record<string, ShiftDef>> = {
  L2: {
    M: { id: 'M', label: 'Mañana',     startHour: 3,  endHour: 11 },
    T: { id: 'T', label: 'Tarde',      startHour: 11, endHour: 19 },
    E: { id: 'E', label: 'Intermedio', startHour: 15, endHour: 23 },
    N: { id: 'N', label: 'Noche',      startHour: 19, endHour: 27 } // 03 next day
  },
  L1: {
    M: { id: 'M', label: 'Mañana',     startHour: 0,  endHour: 8  },
    T: { id: 'T', label: 'Tarde',      startHour: 8,  endHour: 16 },
    E: { id: 'E', label: 'Intermedio', startHour: 12, endHour: 20 },
    N: { id: 'N', label: 'Noche',      startHour: 16, endHour: 24 }
  }
};
