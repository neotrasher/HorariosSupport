/**
 * Daily SQLite backup with 30-day retention.
 *
 * - Uses better-sqlite3's online backup API (atomic, safe while DB is in use).
 * - Writes to <dbDir>/backups/horarios-YYYY-MM-DD.db
 * - Keeps last `retentionDays` files, deletes older ones.
 */
import path from 'path';
import fs from 'fs';
import { DateTime } from 'luxon';
import { db } from '../db';
import { config } from '../config';
import { logAudit } from '../services/audit';

const BACKUP_PREFIX = 'horarios-';
const BACKUP_SUFFIX = '.db';

function getBackupDir(): string {
  const dbDir = path.dirname(config.dbPath);
  return path.join(dbDir, 'backups');
}

export interface BackupResult {
  ok: boolean;
  path?: string;
  sizeBytes?: number;
  error?: string;
  pruned?: string[];
}

/** Run a single backup now. Safe to call manually. */
export async function runDbBackup(retentionDays: number = 30): Promise<BackupResult> {
  const dir = getBackupDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const dateStr = DateTime.utc().toFormat('yyyy-LL-dd');
  const dest = path.join(dir, `${BACKUP_PREFIX}${dateStr}${BACKUP_SUFFIX}`);

  try {
    // better-sqlite3 .backup() returns a Promise; resolves with metadata
    await (db as any).backup(dest);
    const stat = fs.statSync(dest);

    // Prune old backups beyond retention window
    const cutoff = DateTime.utc().minus({ days: retentionDays });
    const pruned: string[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(BACKUP_PREFIX) || !f.endsWith(BACKUP_SUFFIX)) continue;
      const m = f.match(/^horarios-(\d{4}-\d{2}-\d{2})\.db$/);
      if (!m) continue;
      const fileDate = DateTime.fromISO(m[1], { zone: 'utc' });
      if (!fileDate.isValid) continue;
      if (fileDate < cutoff) {
        try {
          fs.unlinkSync(path.join(dir, f));
          pruned.push(f);
        } catch (e) {
          console.error(`[backup] failed to prune ${f}:`, e);
        }
      }
    }

    console.log(`[backup] ✓ ${dest} (${(stat.size / 1024).toFixed(0)} KB)${pruned.length ? ` · pruned ${pruned.length}` : ''}`);

    // Audit (system actor since it's automated)
    logAudit({
      actorSlackId: null,
      actorName: 'sistema',
      action: 'db.backup',
      targetKind: 'database',
      targetId: dateStr,
      summary: `Backup automático: ${path.basename(dest)} (${(stat.size / 1024).toFixed(0)} KB)${pruned.length ? `, pruned ${pruned.length} antiguo(s)` : ''}`,
      payload: { path: dest, sizeBytes: stat.size, retentionDays, pruned }
    });

    return { ok: true, path: dest, sizeBytes: stat.size, pruned };
  } catch (e: any) {
    console.error('[backup] failed:', e);
    return { ok: false, error: e?.message || String(e) };
  }
}

/** List all existing backup files (newest first). */
export function listBackups(): { name: string; date: string; sizeBytes: number; mtime: string }[] {
  const dir = getBackupDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
    .map(f => {
      const m = f.match(/^horarios-(\d{4}-\d{2}-\d{2})\.db$/);
      const stat = fs.statSync(path.join(dir, f));
      return {
        name: f,
        date: m ? m[1] : '',
        sizeBytes: stat.size,
        mtime: stat.mtime.toISOString()
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}
