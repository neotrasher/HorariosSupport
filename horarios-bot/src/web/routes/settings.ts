import { Router } from 'express';
import { requireAdmin } from './auth';
import { SETTING_DEFS, validateAndApply, setSetting, applyDbSettings } from '../../services/settings';
import { logAudit } from '../../services/audit';

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
