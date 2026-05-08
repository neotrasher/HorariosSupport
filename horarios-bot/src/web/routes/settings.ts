import { Router } from 'express';
import { requireAdmin } from './auth';
import { SETTING_DEFS, validateAndApply, setSetting, applyDbSettings } from '../../services/settings';
import { logAudit } from '../../services/audit';
import { config } from '../../config';

export const settingsRouter = Router();

settingsRouter.get('/', requireAdmin, (req, res) => {
  const user = (req.session as any).user;
  const groups: Record<string, typeof SETTING_DEFS> = {};
  for (const d of SETTING_DEFS) {
    if (!groups[d.group]) groups[d.group] = [];
    groups[d.group].push(d);
  }
  const flash = (req.session as any).settingsFlash || null;
  delete (req.session as any).settingsFlash;
  res.render('settings', {
    user, groups,
    rows: SETTING_DEFS.map(d => ({ ...d, value: d.current() })),
    flash
  });
});

/**
 * One-click "iniciar nuevo ciclo" action: snapshots current cycle config as
 * legacy, then sets switchover date + new cycle config. Atomic from the user's
 * perspective: dates before switchoverDate keep showing their original cycle
 * label; dates on/after use the new pattern.
 */
settingsRouter.post('/cycle-switchover', requireAdmin, (req, res) => {
  const user = (req.session as any).user;
  const switchoverDate = (req.body.switchover_date as string || '').trim();
  const newLengthRaw = (req.body.new_cycle_length as string || '').trim();
  const newAnchorCycle = (req.body.new_anchor_cycle as string || 'A').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(switchoverDate)) {
    (req.session as any).settingsFlash = { type: 'error', text: 'Fecha de switchover invalida (YYYY-MM-DD).' };
    return res.redirect('/settings#cycle-switchover');
  }
  const newLength = parseInt(newLengthRaw, 10);
  if (newLength !== 3 && newLength !== 4) {
    (req.session as any).settingsFlash = { type: 'error', text: 'Duracion debe ser 3 o 4 semanas.' };
    return res.redirect('/settings#cycle-switchover');
  }
  const allowedAnchor = ['A', 'B', 'C', 'D'].slice(0, newLength);
  if (!allowedAnchor.includes(newAnchorCycle)) {
    (req.session as any).settingsFlash = { type: 'error', text: `Ancla del nuevo ciclo debe ser ${allowedAnchor.join('/')}.` };
    return res.redirect('/settings#cycle-switchover');
  }

  // Snapshot current as legacy
  const prevLength = config.cycleLength;
  const prevAnchorDate = config.anchorDate;
  const prevAnchorCycle = config.anchorCycle;

  setSetting('legacyCycleLength', String(prevLength), user.slack_id);
  setSetting('legacyAnchorDate',  prevAnchorDate, user.slack_id);
  setSetting('legacyAnchorCycle', prevAnchorCycle, user.slack_id);
  // New current
  setSetting('cycleSwitchoverDate', switchoverDate, user.slack_id);
  setSetting('cycleLength',  String(newLength), user.slack_id);
  setSetting('anchorDate',   switchoverDate, user.slack_id);
  setSetting('anchorCycle',  newAnchorCycle, user.slack_id);
  applyDbSettings();

  logAudit({
    actorSlackId: user.slack_id, actorName: user.name,
    action: 'settings.update',
    targetKind: 'setting', targetId: 'cycleSwitchover',
    summary: `Iniciar nuevo ciclo desde ${switchoverDate}: ${prevLength} sem (${prevAnchorCycle} desde ${prevAnchorDate}) → ${newLength} sem (${newAnchorCycle} desde ${switchoverDate})`,
    payload: {
      from: { cycleLength: prevLength, anchorDate: prevAnchorDate, anchorCycle: prevAnchorCycle },
      to:   { cycleLength: newLength,  anchorDate: switchoverDate, anchorCycle: newAnchorCycle, switchoverDate }
    }
  });

  (req.session as any).settingsFlash = { type: 'ok',
    text: `Nuevo ciclo activado desde ${switchoverDate}. Hasta ${switchoverDate} se sigue mostrando el ciclo anterior (${prevLength} sem).` };
  res.redirect('/settings#cycle-switchover');
});

settingsRouter.post('/', requireAdmin, (req, res) => {
  const user = (req.session as any).user;
  const errors: { key: string; error: string }[] = [];
  const changes: { key: string; from: any; to: any }[] = [];
  for (const def of SETTING_DEFS) {
    const raw = (req.body[def.key] ?? '').toString().trim();
    if (raw === '') continue;
    // Compare against current to skip no-ops
    const previous = def.current();
    const currentStr = String(previous);
    if (raw === currentStr) continue;
    const v = validateAndApply(def.key, raw);
    if (!v.ok) { errors.push({ key: def.key, error: v.error }); continue; }
    setSetting(def.key, String(v.value), user.slack_id);
    changes.push({ key: def.key, from: previous, to: v.value });
  }
  // Re-apply DB → config so changes take effect immediately for cron jobs etc.
  applyDbSettings();
  if (changes.length) {
    logAudit({
      actorSlackId: user.slack_id, actorName: user.name,
      action: 'settings.update',
      targetKind: 'setting', targetId: changes.map(c => c.key).join(','),
      summary: `Actualizo ${changes.length} setting(s): ${changes.map(c => `${c.key}: ${c.from} → ${c.to}`).join(' · ')}`,
      payload: { changes }
    });
  }
  const savedCount = changes.length;

  (req.session as any).settingsFlash = errors.length
    ? { type: 'error', text: `Errores en: ${errors.map(e => `${e.key} (${e.error})`).join(', ')}` }
    : { type: 'ok', text: `Guardado · ${savedCount} cambio${savedCount === 1 ? '' : 's'}` };
  res.redirect('/settings');
});
