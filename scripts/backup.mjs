// Online backup of the SQLite database: a consistent copy even while the app is writing.
// Usage: DB_PATH=data/putevka.db BACKUP_DIR=data/backups node scripts/backup.mjs
//        node scripts/backup.mjs --every 24h   (keeps running and makes a copy once a day, for docker-compose)
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEEP = 14;
const NAME = /^putevka-\d{4}-\d{2}-\d{2}_\d{6}\.db$/;

const stamp = (d) => d.toISOString().replace(/\.\d+Z$/, '').replace('T', '_').replace(/:/g, '');

/** Copies dbFile into dir and removes the oldest copies beyond `keep`. Returns the new file and the removed ones. */
export async function backupDb({ dbFile, dir, keep = KEEP, now = new Date() }) {
  if (!fs.existsSync(dbFile)) throw new Error(`База не найдена: ${dbFile}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `putevka-${stamp(now)}.db`);
  const tmp = file + '.part';
  const db = new Database(dbFile, { fileMustExist: true });
  try { await db.backup(tmp); } finally { db.close(); }
  // check the copy before it replaces anything: a broken backup must not push out a good one
  // the copy inherits WAL mode; switch it to a plain single file so nothing is left beside it
  const copy = new Database(tmp);
  try {
    copy.pragma('journal_mode = DELETE');
    const r = copy.pragma('integrity_check', { simple: true });
    if (r !== 'ok') throw new Error(`Копия повреждена: ${r}`);
  } finally { copy.close(); }
  fs.renameSync(tmp, file);
  const all = fs.readdirSync(dir).filter((f) => NAME.test(f)).sort();
  const removed = all.slice(0, Math.max(0, all.length - keep));
  for (const f of removed) fs.rmSync(path.join(dir, f));
  return { file, removed };
}

const DURATION = { h: 3600e3, m: 60e3 };
function every(arg) {
  const m = /^(\d+)([hm])$/.exec(arg || '');
  return m ? Number(m[1]) * DURATION[m[2]] : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dbFile = process.env.DB_PATH || 'data/putevka.db';
  const dir = process.env.BACKUP_DIR || path.join(path.dirname(dbFile), 'backups');
  const keep = Number(process.env.BACKUP_KEEP) || KEEP;
  const run = async () => {
    try {
      const r = await backupDb({ dbFile, dir, keep });
      console.log(`${new Date().toISOString()} копия: ${r.file}${r.removed.length ? `, удалено старых: ${r.removed.length}` : ''}`);
      return true;
    } catch (e) {
      console.error(`${new Date().toISOString()} резервная копия не сделана: ${e.message}`);
      return false;
    }
  };
  const i = process.argv.indexOf('--every');
  const period = i > 0 ? every(process.argv[i + 1]) : null;
  if (i > 0 && !period) { console.error('Период: --every 24h или --every 30m'); process.exit(2); }
  const ok = await run();
  if (period) setInterval(run, period);
  else process.exitCode = ok ? 0 : 1;
}
