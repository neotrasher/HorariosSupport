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
  type: 'int' | 'string' | 'float';
  group: 'attendance' | 'cycle' | 'slack' | 'misc' | 'rrhh' | 'puntualidad';
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
    key: 'cycleLength', label: 'Duración del ciclo (semanas)', type: 'int', group: 'cycle',
    apply: v => { (config as any).cycleLength = v; },
    current: () => config.cycleLength,
    hint: '3 = ciclo A/B/C · 4 = ciclo A/B/C/D. Aplica desde la fecha de switchover (si está set). Para iniciar limpio, usá el botón "Iniciar nuevo ciclo".',
    min: 3, max: 4
  },
  {
    key: 'cycleSwitchoverDate', label: 'Fecha de switchover de ciclo (YYYY-MM-DD)', type: 'string', group: 'cycle',
    apply: v => { (config as any).cycleSwitchoverDate = v; },
    current: () => config.cycleSwitchoverDate,
    hint: 'Antes de esta fecha se usan los valores legacy*; desde acá en adelante, los valores actuales. Vacío = sin switchover.'
  },
  {
    key: 'legacyCycleLength', label: 'Legacy: Duración del ciclo (semanas)', type: 'int', group: 'cycle',
    apply: v => { (config as any).legacyCycleLength = v; },
    current: () => config.legacyCycleLength,
    hint: 'Snapshot del cycleLength anterior. Solo aplica a fechas < switchover.',
    min: 3, max: 4
  },
  {
    key: 'legacyAnchorDate', label: 'Legacy: Fecha ancla', type: 'string', group: 'cycle',
    apply: v => { (config as any).legacyAnchorDate = v; },
    current: () => config.legacyAnchorDate,
    hint: 'Snapshot del anchorDate anterior. Solo aplica a fechas < switchover.'
  },
  {
    key: 'legacyAnchorCycle', label: 'Legacy: Ciclo ancla', type: 'string', group: 'cycle',
    apply: v => { (config as any).legacyAnchorCycle = v; },
    current: () => config.legacyAnchorCycle,
    hint: 'Snapshot del anchorCycle anterior. Solo aplica a fechas < switchover.'
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
    key: 'birthdayMention', label: 'Mención en cumpleaños', type: 'string', group: 'rrhh',
    apply: v => { (config as any).birthdayMention = v; },
    current: () => config.birthdayMention,
    hint: 'Texto Slack que se antepone. Ej: <!subteam^S012345> para @support, <!channel>, <!here>. Vacío = sin mención.'
  },
  {
    key: 'anniversaryMention', label: 'Mención en aniversario laboral', type: 'string', group: 'rrhh',
    apply: v => { (config as any).anniversaryMention = v; },
    current: () => config.anniversaryMention,
    hint: 'Igual que cumpleaños. Si está vacío, usa el de cumpleaños.'
  },
  {
    key: 'birthdayGifUrls', label: 'GIFs de cumpleaños (URLs)', type: 'string', group: 'rrhh',
    apply: v => { (config as any).birthdayGifUrls = v; },
    current: () => config.birthdayGifUrls,
    hint: 'URLs separadas por coma. Tip: en giphy.com → click GIF → "Copy GIF link". Se elige una al azar.'
  },
  {
    key: 'anniversaryGifUrls', label: 'GIFs de aniversario (URLs)', type: 'string', group: 'rrhh',
    apply: v => { (config as any).anniversaryGifUrls = v; },
    current: () => config.anniversaryGifUrls,
    hint: 'URLs separadas por coma. Vacío = sin GIF.'
  },
  {
    key: 'punctualityWeightUnmarked', label: 'Peso: sin marcar', type: 'float', group: 'puntualidad',
    apply: v => { (config as any).punctualityWeightUnmarked = v; },
    current: () => config.punctualityWeightUnmarked,
    hint: 'Penalización por turno sin clock-in (0.0 = ignora, 1.0 = máx).',
    min: 0, max: 2
  },
  {
    key: 'punctualityWeightLate', label: 'Peso: tarde', type: 'float', group: 'puntualidad',
    apply: v => { (config as any).punctualityWeightLate = v; },
    current: () => config.punctualityWeightLate,
    hint: 'Penalización por llegar tarde (más allá del umbral de tardanza).',
    min: 0, max: 2
  },
  {
    key: 'punctualityWeightAutoClockout', label: 'Peso: auto-clockout', type: 'float', group: 'puntualidad',
    apply: v => { (config as any).punctualityWeightAutoClockout = v; },
    current: () => config.punctualityWeightAutoClockout,
    hint: 'Penalización cuando el agente olvidó hacer clock-out y el sistema lo cerró.',
    min: 0, max: 2
  },
  {
    key: 'punctualityStartDate', label: 'Fecha inicio del score (YYYY-MM-DD)', type: 'string', group: 'puntualidad',
    apply: v => { (config as any).punctualityStartDate = v; },
    current: () => config.punctualityStartDate,
    hint: 'Turnos antes de esta fecha se ignoran (útil cuando el bot aún no estaba activo). Vacío = contar todos.'
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
    let parsed: any = r.value;
    if (def.type === 'int') parsed = parseInt(r.value, 10);
    else if (def.type === 'float') parsed = parseFloat(r.value);
    if ((def.type === 'int' || def.type === 'float') && Number.isNaN(parsed)) continue;
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
  if (def.type === 'float') {
    const n = parseFloat(raw);
    if (Number.isNaN(n)) return { ok: false, error: 'expected number' };
    if (def.min !== undefined && n < def.min) return { ok: false, error: `min ${def.min}` };
    if (def.max !== undefined && n > def.max) return { ok: false, error: `max ${def.max}` };
    return { ok: true, value: n };
  }
  if (def.key === 'anchorCycle') {
    const allowed = ['A', 'B', 'C', 'D'].slice(0, config.cycleLength);
    if (!allowed.includes(raw)) return { ok: false, error: `must be one of ${allowed.join('/')}` };
  }
  if (def.key === 'anchorDate') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { ok: false, error: 'YYYY-MM-DD' };
  }
  if (def.key === 'punctualityStartDate') {
    if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { ok: false, error: 'YYYY-MM-DD o vacío' };
  }
  return { ok: true, value: raw };
}
