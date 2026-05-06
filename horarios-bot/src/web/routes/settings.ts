import { Router } from 'express';
import { requireAdmin } from './auth';
import { SETTING_DEFS, validateAndApply, setSetting, applyDbSettings } from '../../services/settings';

export const settingsRouter = Router();

settingsRouter.get('/', requireAdmin, (req, res) => {
  const user = (req.session as any).user;
  const groups: Record<string, typeof SETTING_DEFS> = { attendance: [], cycle: [], slack: [], misc: [] };
  for (const d of SETTING_DEFS) groups[d.group].push(d);
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
  let savedCount = 0;
  for (const def of SETTING_DEFS) {
    const raw = (req.body[def.key] ?? '').toString().trim();
    if (raw === '') continue;
    // Compare against current to skip no-ops
    const currentStr = String(def.current());
    if (raw === currentStr) continue;
    const v = validateAndApply(def.key, raw);
    if (!v.ok) { errors.push({ key: def.key, error: v.error }); continue; }
    setSetting(def.key, String(v.value), user.slack_id);
    savedCount++;
  }
  // Re-apply DB → config so changes take effect immediately for cron jobs etc.
  applyDbSettings();

  (req.session as any).settingsFlash = errors.length
    ? { type: 'error', text: `Errores en: ${errors.map(e => `${e.key} (${e.error})`).join(', ')}` }
    : { type: 'ok', text: `Guardado · ${savedCount} cambio${savedCount === 1 ? '' : 's'}` };
  res.redirect('/settings');
});
