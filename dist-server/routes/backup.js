'use strict';
/**
 * 系統備份模組：手動/自動備份、過期自動清理、異地備份、系統還原
 * 功能參照「行政管理中心（HR 系統）」系統管理 → 系統備份及還原，改以本系統
 * better-sqlite3 同步風格與 RBAC（admin）實作。
 * - 備份內容：動態列舉全部資料表（含 CREATE TABLE schema 快照），AES-256-GCM 加密
 * - 備份目錄：<app>\data\backups（data 目錄不隨 deploy 覆蓋，備份可跨版本保留）
 * - 金鑰：<app>\data\.backup.key（不進安裝包/同步，遺失則舊備份無法解密）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const Database = require('better-sqlite3');
const { db, DB_FILE, DATA_DIR } = require('../lib/db-dual');
const { requireAuth, requireAdmin } = require('../lib/auth');
const audit = require('../lib/audit');
const { str, num } = require('../lib/util');
// P0 雲端異地備份：複用 cloud-backup 的目標同步邏輯（解耦 OneDrive 寫死）
const cloudBackup = require('./cloud-backup');

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEY_PATH = path.join(DATA_DIR, '.backup.key');
const BACKUP_NAMES_RE = /^trade_backup_.*\.json$/;
const LARGE_TABLE_PAGE = 5000;

fs.mkdirSync(BACKUP_DIR, { recursive: true });

/* ── AES-256-GCM 加密（金鑰存 data\.backup.key） ───────────── */
let _backupKey = null;
function getBackupKey() {
  if (_backupKey) return _backupKey;
  try { _backupKey = fs.readFileSync(BACKUP_KEY_PATH); }
  catch (_) {
    _backupKey = crypto.randomBytes(32);
    fs.writeFileSync(BACKUP_KEY_PATH, _backupKey, { mode: 0o600 });
  }
  return _backupKey;
}
function encryptBackup(plainJson) {
  const key = getBackupKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plainJson, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'ENC::' + Buffer.concat([iv, tag, enc]).toString('base64');
}
function decryptBackup(blob) {
  const raw = Buffer.from(String(blob).replace(/^ENC::/, ''), 'base64');
  const iv = raw.slice(0, 12);
  const tag = raw.slice(12, 28);
  const enc = raw.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getBackupKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
function parseBackupContent(bufOrStr) {
  const s = Buffer.isBuffer(bufOrStr) ? bufOrStr.toString('utf8') : String(bufOrStr);
  if (s.startsWith('ENC::')) return JSON.parse(decryptBackup(s));
  return JSON.parse(s);
}

function nowLocal(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate()) + ' ' + p(x.getHours()) + ':' + p(x.getMinutes()) + ':' + p(x.getSeconds());
}

/* ── 備份內容建置（動態列舉全部表 + schema DDL + 大表分頁） ── */
function buildBackupPayload(type) {
  const tables = {};
  const schema = {};
  const list = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((r) => r.name).filter((n) => /^[A-Za-z0-9_]+$/.test(n));
  for (const t of list) {
    const cols = db.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
    const total = db.prepare('SELECT COUNT(*) AS c FROM ' + t).get().c;
    const rows = [];
    if (total <= LARGE_TABLE_PAGE) {
      rows.push(...db.prepare('SELECT * FROM ' + t).all());
    } else {
      for (let off = 0; off < total; off += LARGE_TABLE_PAGE) {
        rows.push(...db.prepare('SELECT * FROM ' + t + ' LIMIT ? OFFSET ?').all(LARGE_TABLE_PAGE, off));
      }
    }
    const srow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (srow && srow.sql) schema[t] = srow.sql;
    tables[t] = { columns: cols, rows: rows.map((r) => { const o = {}; cols.forEach((c) => { o[c] = r[c]; }); return o; }) };
  }
  return { version: 1, type, createdAt: new Date().toISOString(), tables, schema };
}

function writeBackupFile(payload) {
  const d = new Date();
  const name = 'trade_backup_' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0') + '_' + String(d.getHours()).padStart(2, '0') +
    String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0') + '.json';
  const full = path.join(BACKUP_DIR, name);
  fs.writeFileSync(full, encryptBackup(JSON.stringify(payload)));
  return { name, size: fs.statSync(full).size };
}

/* ── 還原（獨立連線交易，外鍵順序插入，含 DDL 建表韌性） ───── */
// 參數化：可指定目標 DB 檔（預設 DB_FILE）。還原演練傳入暫存檔，避免影響 LIVE。
function restorePayloadToDb(payload, dbFile) {
  const target = dbFile || DB_FILE;
  const tableNames = Object.keys(payload.tables || {}).filter((t) => /^[A-Za-z0-9_]+$/.test(t));
  const rdb = new Database(target);
  try {
    // 1) 先確保所有表存在（從備份 schema DDL 建表）。否則對「空庫」執行
    //    PRAGMA foreign_key_list 會立即拋 "no such table"，導致「全新機器還原 / 還原演練」
    //    失敗（LIVE 既有表時不會觸發，故生產還原不受影響）。
    for (const t of tableNames) {
      const ex = rdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (!ex) {
        const ddl = payload.schema && payload.schema[t];
        if (ddl) rdb.exec(ddl);
        // 仍不存在（無 DDL）時交由下方交易內的建表邏輯處理，不中斷流程
      }
    }
    // 2) 依外鍵依賴建立父表先插入的順序（此時表已存在，PRAGMA 不再報錯）
    const parentMap = {};
    for (const t of tableNames) {
      parentMap[t] = rdb.prepare('PRAGMA foreign_key_list(' + t + ')').all()
        .map((r) => r.table).filter((p) => p !== t && payload.tables[p]);
    }
    const order = [];
    const done = new Set(), doing = new Set();
    const visit = (t2) => {
      if (done.has(t2) || doing.has(t2)) return;
      doing.add(t2);
      (parentMap[t2] || []).forEach(visit);
      doing.delete(t2); done.add(t2); order.push(t2);
    };
    tableNames.forEach(visit);
    const insertOrder = order;

    const tx = rdb.transaction(() => {
      rdb.pragma('foreign_keys = OFF');
      for (const t of tableNames) {
        const ex = rdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
        if (!ex) {
          const ddl = payload.schema && payload.schema[t];
          if (ddl) { rdb.exec(ddl); } else { continue; }
        }
        rdb.prepare('DELETE FROM ' + t).run();
        rdb.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(t);
      }
      for (const t of insertOrder) {
        const entry = payload.tables[t];
        if (!entry || !entry.columns || !entry.columns.length || !entry.rows || !entry.rows.length) continue;
        const ex = rdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
        if (!ex) continue;
        const cols = entry.columns;
        const ph = cols.map(() => '?').join(',');
        const stmt = rdb.prepare('INSERT INTO ' + t + ' (' + cols.join(',') + ') VALUES (' + ph + ')');
        for (const row of entry.rows) {
          stmt.run(cols.map((c) => (row[c] === undefined ? null : row[c])));
        }
      }
      rdb.pragma('foreign_keys = ON');
    });
    tx();
    rdb.close();
    return { tables: tableNames.length, files: 0, warnings: [] };
  } catch (e) {
    try { rdb.close(); } catch (_) {}
    throw e;
  }
}

// 向後相容：預設還原至 LIVE DB_FILE
function restoreFromPayload(payload) {
  return restorePayloadToDb(payload, DB_FILE);
}

/* ── 設定讀取/寫入 ─────────────────────────────── */
function getConfig(table, defs) {
  const row = db.prepare('SELECT * FROM ' + table + ' WHERE id=1').get();
  if (row) return row;
  const cols = Object.keys(defs);
  db.prepare('INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')')
    .run(...cols.map((k) => defs[k]));
  return db.prepare('SELECT * FROM ' + table + ' WHERE id=1').get();
}

/* ── 自動備份排程 ─────────────────────────────── */
function runAutoBackup() {
  const cfg = getConfig('backup_config', { id: 1, enabled: 0, interval_days: 1 });
  if (!cfg.enabled) return;
  const intervalMs = Math.max(1, cfg.interval_days) * 86400000;
  const last = cfg.last_run ? new Date(cfg.last_run).getTime() : 0;
  if (Date.now() - last < intervalMs) return;
  const nowLocalStr = nowLocal();
  const { name } = writeBackupFile(buildBackupPayload('auto'));
  db.prepare('UPDATE backup_config SET last_run=?, next_run=? WHERE id=1')
    .run(nowLocalStr, nowLocal(new Date(Date.now() + intervalMs)));
  audit.log({ user: { id: 0, emp_id: 'system' } }, 'backup', '系統備份', '', '自動備份完成：' + name);
  // P0：異地同步改為遍歷 cloud_targets 啟用目標（解耦 OneDrive 寫死）
  try { cloudBackup.syncAllEnabledTargets(BACKUP_DIR, BACKUP_NAMES_RE); } catch (_) {}
}

function runCleanup() {
  const cfg = getConfig('backup_cleanup_config', { id: 1, enabled: 0, retention_days: 30, retention_count: 0 });
  if (!cfg.enabled) return;
  const last = cfg.last_run ? new Date(cfg.last_run).getTime() : 0;
  if (Date.now() - last < 86400000) return;
  const deleted = cleanupExpiredBackups();
  db.prepare('UPDATE backup_cleanup_config SET last_run=?, next_run=? WHERE id=1')
    .run(nowLocal(), nowLocal(new Date(Date.now() + 86400000)));
  if (deleted.length) audit.log({ user: { id: 0, emp_id: 'system' } }, 'backup', '系統備份', '', '自動清理刪除 ' + deleted.length + ' 個過期備份');
}

function cleanupExpiredBackups() {
  const cfg = getConfig('backup_cleanup_config', { id: 1, enabled: 0, retention_days: 30, retention_count: 0 });
  const list = fs.readdirSync(BACKUP_DIR).filter((f) => BACKUP_NAMES_RE.test(f)).map((f) => {
    const fp = path.join(BACKUP_DIR, f);
    let mtime = 0;
    try { mtime = fs.statSync(fp).mtimeMs; } catch (_) {}
    return { name: f, mtime };
  }).sort((a, b) => b.mtime - a.mtime);
  const days = Math.max(0, cfg.retention_days || 0);
  const count = Math.max(0, cfg.retention_count || 0);
  const toDelete = new Set();
  if (count > 0) list.forEach((b, idx) => { if (idx >= count) toDelete.add(b.name); });
  if (days > 0) {
    const cutoff = Date.now() - days * 86400000;
    list.forEach((b) => { if (b.mtime > 0 && b.mtime < cutoff) toDelete.add(b.name); });
  }
  const deleted = [];
  for (const fn of toDelete) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, fn)); deleted.push(fn); } catch (_) {}
  }
  return deleted;
}

/* ── 異地備份 ─────────────────────────────── */
const OFFSITE_NAMES_RE = BACKUP_NAMES_RE;
function validateOffsitePath(p, create) {
  const out = { ok: false };
  if (!p || !String(p).trim()) { out.message = '路徑不可為空'; return out; }
  const dir = String(p).trim().replace(/[\\/]+$/, '');
  const lower = dir.toLowerCase();
  const banned = ['system32', 'windows\\', 'program files', 'programdata', '\\$recycle.bin', 'c:\\$'];
  if (banned.some((b) => lower.includes(b))) { out.message = '路徑指向系統關鍵目錄，已拒絕'; return out; }
  const bkLower = BACKUP_DIR.toLowerCase();
  if (lower === bkLower || lower.startsWith(bkLower + '\\')) { out.message = '異地路徑不可等於系統備份目錄'; return out; }
  try {
    if (!fs.existsSync(dir)) {
      if (!create) { out.message = '目錄不存在（儲存後會在同步時自動建立）'; out.notExist = true; return out; }
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.statSync(dir).isDirectory()) { out.message = '路徑不是目錄'; return out; }
    const probe = path.join(dir, '.trade_offsite_probe_' + Date.now() + '.tmp');
    fs.writeFileSync(probe, 'ok');
    try { fs.unlinkSync(probe); } catch (_) {}
    out.ok = true; out.dir = dir; out.message = '路徑可寫入';
  } catch (e) {
    out.message = '路徑驗證失敗：' + e.message;
  }
  return out;
}

function syncOffsiteBackup() {
  const cfg = getConfig('offsite_backup_config', { id: 1, enabled: 0, path: '', auto_sync: 0, keep_count: 0 });
  const v = validateOffsitePath(cfg.path, true);
  if (!v.ok) return { ok: false, reason: v.message };
  const offDir = v.dir;
  const local = fs.readdirSync(BACKUP_DIR).filter((f) => OFFSITE_NAMES_RE.test(f)).sort();
  let copied = 0, skipped = 0;
  const remoteSet = new Set(fs.readdirSync(offDir).filter((f) => OFFSITE_NAMES_RE.test(f)));
  for (const f of local) {
    const src = path.join(BACKUP_DIR, f);
    const dst = path.join(offDir, f);
    if (remoteSet.has(f) && fs.existsSync(dst) && fs.statSync(src).size === fs.statSync(dst).size) { skipped++; continue; }
    fs.copyFileSync(src, dst);
    copied++;
  }
  let deleted = [];
  if (cfg.keep_count > 0) {
    const all = fs.readdirSync(offDir).filter((f) => OFFSITE_NAMES_RE.test(f)).sort();
    const excess = all.length - cfg.keep_count;
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(path.join(offDir, all[i])); deleted.push(all[i]); } catch (_) {}
    }
  }
  return { ok: true, copied, skipped, deleted, dir: offDir };
}

function runOffsiteSyncSilent() {
  try {
    const cfg = getConfig('offsite_backup_config', { id: 1, enabled: 0, path: '', auto_sync: 0, keep_count: 0 });
    if (!cfg.enabled || !cfg.auto_sync || !cfg.path) return;
    const r = syncOffsiteBackup();
    db.prepare('UPDATE offsite_backup_config SET last_run=?, last_status=?, last_error=? WHERE id=1')
      .run(nowLocal(), r.ok ? 'ok' : 'error', r.ok ? '' : (r.reason || ''));
  } catch (_) {}
}

function listOffsiteBackups() {
  const cfg = getConfig('offsite_backup_config', { id: 1, enabled: 0, path: '', auto_sync: 0, keep_count: 0 });
  if (!cfg || !cfg.path) return [];
  const v = validateOffsitePath(cfg.path, false);
  if (!v.ok) return [];
  return fs.readdirSync(v.dir).filter((f) => OFFSITE_NAMES_RE.test(f)).map((f) => {
    const fp = path.join(v.dir, f);
    const st = fs.statSync(fp);
    return { name: f, size: st.size, mtime: st.mtimeMs, path: fp };
  }).sort((a, b) => b.mtime - a.mtime);
}

function deleteOffsiteBackup(name) {
  const base = path.basename(name || '');
  if (!OFFSITE_NAMES_RE.test(base)) throw new Error('不允許的檔名');
  const cfg = getConfig('offsite_backup_config', { id: 1, enabled: 0, path: '', auto_sync: 0, keep_count: 0 });
  if (!cfg || !cfg.path) throw new Error('尚未設定異地路徑');
  const v = validateOffsitePath(cfg.path, false);
  if (!v.ok) throw new Error(v.message);
  const fp = path.join(v.dir, base);
  if (!fs.existsSync(fp)) throw new Error('檔案不存在');
  fs.unlinkSync(fp);
  return base;
}

/* ── Express Router ─────────────────────────────── */
const express = require('express');
const router = express.Router();
router.use(requireAuth);
router.use(requireAdmin);

// 手動備份
router.post('/', (req, res) => {
  try {
    const type = req.body && req.body.type === 'auto' ? 'auto' : 'manual';
    const { name, size } = writeBackupFile(buildBackupPayload(type));
    audit.log(req, 'backup', '系統備份', name, '系統備份（' + (type === 'auto' ? '自動' : '手動') + '）：' + name);
    res.json({ ok: true, name, size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 備份清單
router.get('/', (req, res) => {
  try {
    const list = fs.readdirSync(BACKUP_DIR).filter((f) => BACKUP_NAMES_RE.test(f)).map((f) => {
      const fp = path.join(BACKUP_DIR, f);
      let meta = {};
      try { meta = parseBackupContent(fs.readFileSync(fp)); } catch (_) {}
      const st = fs.statSync(fp);
      return { name: f, size: st.size, mtime: st.mtimeMs, path: fp, type: meta.type || 'manual', createdAt: meta.createdAt || null };
    }).sort((a, b) => b.mtime - a.mtime);
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 刪除備份
router.delete('/:filename', (req, res) => {
  const fn = req.params.filename;
  if (!BACKUP_NAMES_RE.test(fn)) return res.status(400).json({ error: '檔名不合法' });
  const fp = path.join(BACKUP_DIR, fn);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: '備份檔不存在' });
  fs.unlinkSync(fp);
  audit.log(req, 'backup', '系統備份', fn, '刪除備份檔：' + fn);
  res.json({ ok: true });
});

// 批量刪除
router.post('/bulk-delete', (req, res) => {
  const names = (req.body && Array.isArray(req.body.names)) ? req.body.names : [];
  const deleted = [], failed = [];
  const seen = new Set();
  for (const fn of names) {
    if (typeof fn !== 'string' || !BACKUP_NAMES_RE.test(fn)) { failed.push({ name: fn, error: '檔名不合法' }); continue; }
    if (seen.has(fn)) { failed.push({ name: fn, error: '重複檔名' }); continue; }
    seen.add(fn);
    const fp = path.join(BACKUP_DIR, fn);
    if (!fs.existsSync(fp)) { failed.push({ name: fn, error: '備份檔不存在' }); continue; }
    try { fs.unlinkSync(fp); deleted.push(fn); } catch (e) { failed.push({ name: fn, error: e.message }); }
  }
  if (deleted.length) audit.log(req, 'backup', '系統備份', deleted.join(','), '批量刪除備份檔 ' + deleted.length + ' 個');
  res.json({ ok: true, deleted, failed });
});

// 立即清理過期備份
router.post('/cleanup', (req, res) => {
  try {
    const deleted = cleanupExpiredBackups();
    if (deleted.length) audit.log(req, 'backup', '系統備份', deleted.join(','), '立即清理刪除 ' + deleted.length + ' 個過期備份');
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 自動備份設定
router.get('/config', (req, res) => {
  try {
    const cfg = getConfig('backup_config', { id: 1, enabled: 0, interval_days: 1 });
    res.json({ enabled: !!cfg.enabled, intervalDays: cfg.interval_days || 1, lastRun: cfg.last_run || null, nextRun: cfg.next_run || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post('/config', (req, res) => {
  try {
    const enabled = req.body && req.body.enabled ? 1 : 0;
    const intervalDays = Math.max(1, num((req.body && req.body.intervalDays) || 1, 1));
    const nowLocalStr = nowLocal();
    db.prepare('UPDATE backup_config SET enabled=?, interval_days=?, last_run=?, next_run=? WHERE id=1')
      .run(enabled, intervalDays, nowLocalStr, nowLocal(new Date(Date.now() + intervalDays * 86400000)));
    audit.log(req, 'backup', '系統備份設定', '', '自動備份' + (enabled ? '啟用' : '停用') + '，週期 ' + intervalDays + ' 天');
    res.json({ ok: true, enabled: !!enabled, intervalDays });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 自動清理設定
router.get('/cleanup-config', (req, res) => {
  try {
    const cfg = getConfig('backup_cleanup_config', { id: 1, enabled: 0, retention_days: 30, retention_count: 0 });
    res.json({ enabled: !!cfg.enabled, retentionDays: cfg.retention_days || 0, retentionCount: cfg.retention_count || 0, lastRun: cfg.last_run || null, nextRun: cfg.next_run || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post('/cleanup-config', (req, res) => {
  try {
    const enabled = req.body && req.body.enabled ? 1 : 0;
    const retentionDays = Math.max(0, num((req.body && req.body.retentionDays) || 0, 0));
    const retentionCount = Math.max(0, num((req.body && req.body.retentionCount) || 0, 0));
    db.prepare('UPDATE backup_cleanup_config SET enabled=?, retention_days=?, retention_count=? WHERE id=1')
      .run(enabled, retentionDays, retentionCount);
    audit.log(req, 'backup', '系統備份清理設定', '', '自動清理' + (enabled ? '啟用' : '停用') + '，保留 ' + retentionDays + ' 天 / ' + retentionCount + ' 份');
    res.json({ ok: true, enabled: !!enabled, retentionDays, retentionCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 異地備份設定
router.get('/offsite-config', (req, res) => {
  try {
    const cfg = getConfig('offsite_backup_config', { id: 1, enabled: 0, path: '', auto_sync: 0, keep_count: 0 });
    res.json({ enabled: !!cfg.enabled, path: cfg.path || '', autoSync: !!cfg.auto_sync, keepCount: cfg.keep_count || 0, lastRun: cfg.last_run || null, lastStatus: cfg.last_status || '', lastError: cfg.last_error || '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post('/offsite-config', (req, res) => {
  try {
    const enabled = req.body && req.body.enabled ? 1 : 0;
    const pathStr = String((req.body && req.body.path) || '').trim();
    const autoSync = req.body && req.body.autoSync ? 1 : 0;
    const keepCount = Math.max(0, num((req.body && req.body.keepCount) || 0, 0));
    if (pathStr) {
      const v = validateOffsitePath(pathStr, true);
      if (!v.ok) return res.status(400).json({ error: v.message });
    } else if (enabled) {
      return res.status(400).json({ error: '啟用異地備份前請先填寫異地路徑' });
    }
    db.prepare('UPDATE offsite_backup_config SET enabled=?, path=?, auto_sync=?, keep_count=? WHERE id=1')
      .run(enabled, pathStr, autoSync, keepCount);
    audit.log(req, 'backup', '異地備份設定', '', '異地備份' + (enabled ? '啟用' : '停用') + '，路徑=' + (pathStr || '(未設定)') + '，自動同步=' + (autoSync ? '開' : '關') + '，保留=' + keepCount + ' 份');
    res.json({ ok: true, enabled: !!enabled, path: pathStr, autoSync: !!autoSync, keepCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 測試異地路徑
router.post('/offsite-test', (req, res) => {
  const pathStr = String((req.body && req.body.path) || '').trim();
  if (!pathStr) return res.status(400).json({ error: '請輸入異地路徑' });
  const v = validateOffsitePath(pathStr, true);
  res.json({ ok: v.ok, message: v.message, path: v.dir || pathStr });
});

// 立即同步到異地
router.post('/offsite-sync', (req, res) => {
  try {
    const result = syncOffsiteBackup();
    if (!result.ok) {
      db.prepare('UPDATE offsite_backup_config SET last_status=?, last_error=? WHERE id=1').run('error', result.reason || '同步失敗');
      return res.status(400).json({ error: result.reason || '同步失敗' });
    }
    db.prepare('UPDATE offsite_backup_config SET last_run=?, last_status=?, last_error=? WHERE id=1')
      .run(nowLocal(), 'ok', '');
    audit.log(req, 'backup', '異地備份', '', '異地備份同步完成：新增 ' + result.copied + '、略過 ' + result.skipped + '、清理 ' + result.deleted.length + ' 份（' + result.dir + '）');
    res.json({ ok: true, copied: result.copied, skipped: result.skipped, deleted: result.deleted, dir: result.dir });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 異地備份清單
router.get('/offsite-list', (req, res) => {
  try { res.json(listOffsiteBackups()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 刪除異地備份
router.delete('/offsite/:filename', (req, res) => {
  try {
    const deleted = deleteOffsiteBackup(req.params.filename);
    audit.log(req, 'backup', '異地備份', deleted, '刪除異地備份檔：' + deleted);
    res.json({ ok: true, deleted });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 還原（本機備份檔或上傳）
const restoreUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });
router.post('/restore', restoreUpload.single('file'), (req, res) => {
  if (!(req.body && (req.body.confirm === 'true' || req.body.confirm === true))) {
    return res.status(400).json({ error: '請先確認還原操作' });
  }
  let payload = null;
  let srcName = '';
  try {
    if (req.file) {
      srcName = req.file.originalname;
      payload = parseBackupContent(req.file.buffer);
    } else if (req.body && req.body.filename) {
      const fn = req.body.filename;
      if (!BACKUP_NAMES_RE.test(fn)) return res.status(400).json({ error: '檔名不合法' });
      const fp = path.join(BACKUP_DIR, fn);
      if (!fs.existsSync(fp)) return res.status(404).json({ error: '備份檔不存在' });
      srcName = fn;
      payload = parseBackupContent(fs.readFileSync(fp));
    } else {
      return res.status(400).json({ error: '請選擇備份檔或上傳檔案' });
    }
    if (!payload || !payload.tables) return res.status(400).json({ error: '備份檔格式錯誤' });
    const result = restoreFromPayload(payload);
    audit.log(req, 'restore', '系統還原', srcName, '系統還原完成：' + srcName + '（' + result.tables + ' 張表）');
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: '還原失敗：' + e.message });
  }
});

// 啟動排程（自動備份 + 自動清理，每 60 秒檢查一次）
let autoTimer = null;
let cleanupTimer = null;
function startSchedulers() {
  if (!autoTimer) autoTimer = setInterval(() => { try { runAutoBackup(); } catch (_) {} }, 60000);
  if (!cleanupTimer) cleanupTimer = setInterval(() => { try { runCleanup(); } catch (_) {} }, 60000);
}
startSchedulers();

// 同時對外暴露輔助函式（供還原演練等模組複用；router 仍可作為中介層使用）
module.exports = Object.assign(router, {
  buildBackupPayload,
  restorePayloadToDb,
  restoreFromPayload,
  parseBackupContent,
  BACKUP_DIR,
  BACKUP_NAMES_RE,
});
