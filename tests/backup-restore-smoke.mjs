#!/usr/bin/env node
/** Isolated SQLite schema backup/restore gate; never opens the configured LIVE database. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-backup-restore-'));
process.env.APP_DB = path.join(work, 'source.sqlite');
let source;
let restored;

try {
  const mod = await import('../dist-server/lib/db.js');
  source = mod.db;
  mod.initSchema();
  const sourceTables = source.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
  if (sourceTables < 30) throw new Error(`schema table count too low: ${sourceTables}`);
  const backupPath = path.join(work, 'backup.sqlite');
  await source.backup(backupPath);

  const Database = (await import('better-sqlite3')).default;
  restored = new Database(backupPath);
  const integrity = restored.pragma('integrity_check', { simple: true });
  const foreignKeys = restored.pragma('foreign_key_check');
  const restoredTables = restored.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;
  if (integrity !== 'ok') throw new Error(`integrity_check=${integrity}`);
  if (foreignKeys.length) throw new Error(`foreign_key_check violations=${foreignKeys.length}`);
  if (restoredTables !== sourceTables) throw new Error(`table count mismatch ${sourceTables} != ${restoredTables}`);
  restored.exec('CREATE TABLE restore_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  restored.prepare('INSERT INTO restore_probe(value) VALUES (?)').run('restored-write-ok');
  const probe = restored.prepare('SELECT value FROM restore_probe WHERE id=1').get();
  if (probe?.value !== 'restored-write-ok') throw new Error('restored copy is not writable/readable');
  console.log(`✅ Isolated SQLite backup/restore passed: ${sourceTables} tables, integrity=ok, FK=0, restored read/write=ok`);
} catch (error) {
  console.error(`❌ Isolated SQLite backup/restore failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  try { restored?.close(); } catch { /* best effort */ }
  try { source?.close(); } catch { /* best effort */ }
  fs.rmSync(work, { recursive: true, force: true });
}
