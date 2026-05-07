/**
 * Settings service: persisted key-value config that overrides env defaults.
 * On startup `applyDbSettings()` is called to mutate `config` in place. The
 * /settings web UI calls `setSetting()` and then `applyDbSettings()` again so
 * cron jobs and route handlers see updated values without a process restart.
 */
import { db } from '../db';
import { config } from '../config';

type RawSetting = { key: string; value: string | null };

export type SettingDef = {
  key: string;
  label: string;
  type: 'int' | 'string';
  group: 'attendance' | 'cycle' | 'slack' | 'misc' | 'rrhh';
  apply: (value: any) => void; // mutate config
  current: () => any;
  hint?: string;
  min?: number;
  max?: number;
};

// Editable fields. Adding a new one here surfaces it automatically in the UI.
export const SETTING_DEFS: SettingDef[] = [
  {
    key: 'lateThresholdMin', label: 'Umbral de tardanza (min)', type: 'int', group: 'attendance',
    apply: v => { (config as any).lateThresholdMin = v; },
    current: () => config.lateThresholdMin,
    hint: 'Minutos despues del inicio del turno antes de marcar como tarde.',
    min: 0, max: 120
  },
  {
    key: 'gracePeriodMin', label: 'Periodo de gracia (min)', type: 'int', group: 'attendance',
    apply: v => { (config as any).gracePeriodMin = v; },
    current: () => config.gracePeriodMin,
    hint: 'Tolerancia antes de notificar tardanza/exceso de break.',
    min: 0, max: 60
  },
  {
    key: 'reminderLeadMin', label: 'Recordatorio antes del turno (min)', type: 'int', group: 'attendance',
    apply: v => { (config as any).reminderLeadMin = v; },
    current: () => config.reminderLeadMin,
    min: 0, max: 60
  },
  {
    key: 'breakInLockoutMin', label: 'Bloqueo Break In cerca del fin (min)', type: 'int', group: 'attendance',
    apply: v => { (config as any).breakInLockoutMin = v; },
    current: () => config.breakInLockoutMin,
    hint: 'Si quedan menos minutos al fin de turno, no se puede hacer Break In.',
    min: 0, max: 240
  },
  {
    key: 'breakMaxMin', label: 'Duracion maxima de break (min) [legacy]', type: 'int', group: 'attendance',
    apply: v => { (config as any).breakMaxMin = v; },
    current: () => config.breakMaxMin,
    hint: 'Solo aplica a punches antiguos sin duracion elegida.',
    min: 15, max: 180
  },
  {
    key: 'autoClockoutGraceMin', label: 'Auto-clockout gracia (min)', type: 'int', group: 'attendance',
    apply: v => { (config as any).autoClockoutGraceMin = v; },
    current: () => config.autoClockoutGraceMin,
    hint: 'Espera tras el fin de turno antes del auto-clockout.',
    min: 0, max: 240
  },
  {
    key: 'autoClockoutWindowMin', label: 'Auto-clockout ventana (min)', type: 'int', group: 'attendance',
    apply: v => { (config as any).autoClockoutWindowMin = v; },
    current: () => config.autoClockoutWindowMin,
    hint: 'Tras el fin de turno, ventana en que aun puede dispararse el auto-clockout.',
    min: 30, max: 480
  },
  {
    key: 'anchorDate', label: 'Fecha ancla del ciclo (YYYY-MM-DD)', type: 'string', group: 'cycle',
    apply: v => { (config as any).anchorDate = v; },
    current: () => config.anchorDate,
    hint: 'Lunes de referencia para calcular el ciclo (A/B/C/D).'
  },
  {
    key: 'anchorCycle', label: 'Ciclo ancla (A/B/C/D)', type: 'string', group: 'cycle',
    apply: v => { (config as any).anchorCycle = v; },
    current: () => config.anchorCycle
  },
  {
    key: 'attendanceChannelId', label: 'Canal de asistencia (Slack ID)', type: 'string', group: 'slack',
    apply: v => { (config as any).attendanceChannelId = v; },
    current: () => config.attendanceChannelId,
    hint: 'Canal donde el bot publica el resumen diario.'
  },
  {
    key: 'evaluationReminderDays', label: 'Recordatorio de evaluación (días antes)', type: 'int', group: 'rrhh',
    apply: v => { (config as any).evaluationReminderDays = v; },
    current: () => config.evaluationReminderDays,
    hint: 'Cuántos días antes de next_evaluation_date se envía DM a los admins.',
    min: 1, max: 90
  },
  {
    key: 'dbBackupRetentionDays', label: 'Retención de backups (días)', type: 'int', group: 'misc',
    apply: v => { (config as any).dbBackupRetentionDays = v; },
    current: () => config.dbBackupRetentionDays,
    hint: 'Backups automáticos de la DB cada día a las 03:00 UTC. Los más antiguos se borran.',
    min: 7, max: 365
  },
  {
    key: 'displayTimezone', label: 'Timezone para mostrar', type: 'string', group: 'misc',
    apply: v => { (config as any).displayTimezone = v; },
    current: () => config.displayTimezone,
    hint: 'IANA tz, ej: America/Bogota'
  }
];

const DEFS_BY_KEY = new Map(SETTING_DEFS.map(d => [d.key, d]));

export function getSetting(key: string): string | null {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as RawSetting | undefined;
  return r?.value ?? null;
}

export function setSetting(key: string, value: string, updatedBy: string | null = null) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at, updated_by)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(key, value, updatedBy);
}

export function listSettings(): { key: string; value: string | null; updated_at: string | null; updated_by: string | null }[] {
  return db.prepare('SELECT key, value, updated_at, updated_by FROM settings').all() as any[];
}

/** Loads all rows, mutates config in place via the def's apply(). Call on startup and after save. */
export function applyDbSettings() {
  const rows = listSettings();
  for (const r of rows) {
    if (r.value === null) continue;
    const def = DEFS_BY_KEY.get(r.key);
    if (!def) continue;
    const parsed = def.type === 'int' ? parseInt(r.value, 10) : r.value;
    if (def.type === 'int' && Number.isNaN(parsed)) continue;
    def.apply(parsed);
  }
}

export function validateAndApply(key: string, raw: string): { ok: true; value: any } | { ok: false; error: string } {
  const def = DEFS_BY_KEY.get(key);
  if (!def) return { ok: false, error: 'unknown setting' };
  if (def.type === 'int') {
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return { ok: false, error: 'expected integer' };
    if (def.min !== undefined && n < def.min) return { ok: false, error: `min ${def.min}` };
    if (def.max !== undefined && n > def.max) return { ok: false, error: `max ${def.max}` };
    return { ok: true, value: n };
  }
  if (def.key === 'anchorCycle') {
    if (!['A', 'B', 'C', 'D'].includes(raw)) return { ok: false, error: 'must be A/B/C/D' };
  }
  if (def.key === 'anchorDate') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { ok: false, error: 'YYYY-MM-DD' };
  }
  return { ok: true, value: raw };
}
