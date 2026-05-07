/**
 * Backup admin: list existing backups, trigger one manually, download a file.
 * Admin only.
 */
import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { config } from '../../config';
import { listBackups, runDbBackup } from '../../jobs/dbBackup';
import { requireAdmin } from './auth';
import { logAudit } from '../../services/audit';

export const backupsRouter = Router();

backupsRouter.use(requireAdmin);

backupsRouter.get('/', (req, res) => {
  const user = (req.session as any).user;
  const flash = (req.session as any).backupsFlash || null;
  delete (req.session as any).backupsFlash;
  res.render('backups', {
    user,
    backups: listBackups(),
    retentionDays: config.dbBackupRetentionDays,
    flash
  });
});

backupsRouter.post('/run', async (req, res) => {
  const user = (req.session as any).user;
  const result = await runDbBackup(config.dbBackupRetentionDays);
  // The auto-backup logs as actor=sistema; if triggered manually, log a separate event
  if (result.ok) {
    logAudit({
      actorSlackId: user.slack_id, actorName: user.name,
      action: 'db.backup.manual',
      targetKind: 'database', targetId: path.basename(result.path || ''),
      summary: `Backup manual ejecutado: ${path.basename(result.path || '')}`,
      payload: { sizeBytes: result.sizeBytes }
    });
  }
  (req.session as any).backupsFlash = result.ok
    ? { type: 'ok', text: `Backup creado: ${path.basename(result.path || '')} (${((result.sizeBytes || 0) / 1024).toFixed(0)} KB)` }
    : { type: 'error', text: `Error: ${result.error}` };
  res.redirect('/backups');
});

backupsRouter.get('/download/:name', (req, res) => {
  const name = req.params.name;
  // Strict whitelist: only files matching our naming pattern
  if (!/^horarios-\d{4}-\d{2}-\d{2}\.db$/.test(name)) {
    res.status(400).send('Nombre invalido.');
    return;
  }
  const dbDir = path.dirname(config.dbPath);
  const filePath = path.join(dbDir, 'backups', name);
  // Confirm file is inside the backups dir (defense in depth against path traversal)
  const expectedDir = path.resolve(path.join(dbDir, 'backups'));
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(expectedDir + path.sep)) {
    res.status(400).send('Ruta invalida.');
    return;
  }
  if (!fs.existsSync(resolved)) {
    res.status(404).send('Backup no encontrado.');
    return;
  }
  const user = (req.session as any).user;
  logAudit({
    actorSlackId: user.slack_id, actorName: user.name,
    action: 'db.backup.download',
    targetKind: 'database', targetId: name,
    summary: `Descargo backup ${name}`
  });
  res.download(resolved, name);
});
