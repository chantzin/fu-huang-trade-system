'use strict';
/**
 * 雲端／異地備份目標管理 API（P0 解耦 OneDrive 寫死，參考 Joplin 設定模式）
 *
 * 掛載於 server.ts：app.use('/api/cloud-backup', require('./routes/cloud-backup'))
 * 權限：admin。
 *
 * 本模組同時對外匯出供 routes/backup.js 複用的輔助函式：
 *   - getEnabledLocalTargets()：啟用的本機資料夾目標清單
 *   - syncFilesToTarget(target, sourceDir, filePattern)：把來源目錄中匹配的檔案同步到目標
 *   - syncAllEnabledTargets(sourceDir, filePattern)：遍歷所有啟用目標同步（排程自動備份呼叫）
 *
 * P0 實作 localfolder（fs 複製，零外部依賴）；googledrive / onedrive / webdav / s3
 * 的 OAuth / API 直連留待 P1/P2/P3（/oauth/* 先回傳 unconfigured）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, DATA_DIR } = require('../lib/db-dual');
const { requireAuth, requireAdmin } = require('../lib/auth');
const audit = require('../lib/audit');
const cs = require('../lib/cloud-storage');

const { TYPES, genId, isSafeLocalPath, uploadToTarget, listTarget, pruneTarget, testTarget } = cs;

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEY_PATH = path.join(DATA_DIR, '.backup.key');
const BACKUP_NAMES_RE = /^trade_backup_.*\.json$/;

fs.mkdirSync(BACKUP_DIR, { recursive: true });

function nowLocal(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate()) + ' ' + p(x.getHours()) + ':' + p(x.getMinutes()) + ':' + p(x.getSeconds());
}

/* ── OAuth token 加密（與 routes/backup.js 同一把金鑰 data/.backup.key） ── */
let _key = null;
function getKey() {
  if (_key) return _key;
  try { _key = fs.readFileSync(BACKUP_KEY_PATH); }
  catch (_) {
    _key = crypto.randomBytes(32);
    fs.writeFileSync(BACKUP_KEY_PATH, _key, { mode: 0o600 });
  }
  return _key;
}
function encryptAuth(jsonStr) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(jsonStr, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'ENC::' + Buffer.concat([iv, tag, enc]).toString('base64');
}
function decryptAuth(blob) {
  if (!blob) return null;
  const raw = Buffer.from(String(blob).replace(/^ENC::/, ''), 'base64');
  const iv = raw.slice(0, 12), tag = raw.slice(12, 28), enc = raw.slice(28);
  const decipher = crypto.createDecipheriv(getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/* ── DB helpers ── */
function listTargets() {
  return db.prepare('SELECT * FROM cloud_targets ORDER BY created_at, id').all();
}
function getTarget(id) {
  return db.prepare('SELECT * FROM cloud_targets WHERE id=?').get(id);
}

/* ── 對外複用：取啟用的本機資料夾目標 ── */
function getEnabledLocalTargets() {
  return db.prepare("SELECT * FROM cloud_targets WHERE enabled=1 AND type='localfolder'").all();
}

/* ── 對外複用：把 sourceDir 中匹配 filePattern 的最新檔同步到單一目標 ── */
async function syncFilesToTarget(target, sourceDir, filePattern) {
  if (!fs.existsSync(sourceDir)) return { ok: false, reason: '來源目錄不存在：' + sourceDir };
  const re = new RegExp(filePattern);
  const files = fs.readdirSync(sourceDir)
    .filter((f) => re.test(f) && !fs.statSync(path.join(sourceDir, f)).isDirectory())
    .map((f) => ({ f, t: fs.statSync(path.join(sourceDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  let copied = 0, skipped = 0, failed = [];
  for (const x of files) {
    const src = path.join(sourceDir, x.f);
    const r = await uploadToTarget(target, src, x.f);
    if (r.ok) copied++;
    else failed.push(x.f + ':' + (r.error || 'unknown'));
  }
  const pr = await pruneTarget(target, target.keep_count || 0, { filePattern });
  return { ok: failed.length === 0, copied, skipped, deleted: pr.deleted || [], failed };
}

/* ── 對外複用：遍歷所有啟用目標同步（排程自動備份呼叫） ── */
async function syncAllEnabledTargets(sourceDir, filePattern) {
  const targets = getEnabledLocalTargets();
  const results = [];
  for (const t of targets) {
    const r = await syncFilesToTarget(t, sourceDir, filePattern);
    r.id = t.id; r.name = t.name; r.type = t.type;
    results.push(r);
    db.prepare('UPDATE cloud_targets SET last_run=?, last_status=?, last_error=? WHERE id=?')
      .run(nowLocal(), r.ok ? 'ok' : 'error', r.ok ? '' : (r.failed || []).join('; ').slice(0, 500), t.id);
  }
  return results;
}

/* ── Router ── */
const router = express.Router();
router.use(requireAuth);
router.use(requireAdmin);

// 列出所有目標（auth_json 不回傳明文）
router.get('/targets', (req, res) => {
  try {
    const rows = listTargets().map((r) => ({ ...r, auth_json: r.auth_json ? '***encrypted***' : null }));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 新增目標
router.post('/targets', (req, res) => {
  try {
    const b = req.body || {};
    const type = String(b.type || '').trim();
    if (!TYPES.includes(type)) return res.status(400).json({ error: '不支援的目標類型：' + type });
    const name = String(b.name || '').trim() || (type === 'localfolder' ? '本機資料夾' : type);
    const remote_path = String(b.remote_path || '').trim();
    const keep_count = Math.max(0, Number(b.keep_count || 0) || 0);
    const options_json = b.options_json ? JSON.stringify(b.options_json) : null;
    if (type === 'localfolder') {
      if (!remote_path) return res.status(400).json({ error: '本機資料夾類型需填寫路徑' });
      const safe = isSafeLocalPath(remote_path);
      if (!safe.ok) return res.status(400).json({ error: safe.reason });
      if (path.resolve(safe.abs).toLowerCase() === BACKUP_DIR.toLowerCase())
        return res.status(400).json({ error: '遠端路徑不可等於系統備份目錄' });
    }
    const id = genId();
    db.prepare('INSERT INTO cloud_targets (id,type,name,enabled,remote_path,keep_count,options_json,auth_json) VALUES (?,?,?,0,?,?,?,NULL)')
      .run(id, type, name, remote_path, keep_count, options_json);
    audit.log(req, 'backup', '雲端目標', id, '新增雲端/異地備份目標：' + name + '（' + type + '）');
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 更新目標（不含 auth）
router.put('/targets/:id', (req, res) => {
  try {
    const target = getTarget(req.params.id);
    if (!target) return res.status(404).json({ error: '目標不存在' });
    const b = req.body || {};
    const name = b.name != null ? String(b.name).trim() : target.name;
    const remote_path = b.remote_path != null ? String(b.remote_path).trim() : target.remote_path;
    const enabled = b.enabled != null ? (b.enabled ? 1 : 0) : target.enabled;
    const keep_count = b.keep_count != null ? Math.max(0, Number(b.keep_count) || 0) : target.keep_count;
    const options_json = b.options_json != null ? (b.options_json ? JSON.stringify(b.options_json) : null) : target.options_json;
    if (target.type === 'localfolder' && remote_path) {
      const safe = isSafeLocalPath(remote_path);
      if (!safe.ok) return res.status(400).json({ error: safe.reason });
      if (path.resolve(safe.abs).toLowerCase() === BACKUP_DIR.toLowerCase())
        return res.status(400).json({ error: '遠端路徑不可等於系統備份目錄' });
    }
    db.prepare("UPDATE cloud_targets SET name=?, enabled=?, remote_path=?, keep_count=?, options_json=?, updated_at=datetime('now','localtime') WHERE id=?")
      .run(name, enabled, remote_path, keep_count, options_json, target.id);
    audit.log(req, 'backup', '雲端目標', target.id, '更新雲端/異地備份目標：' + name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 刪除目標
router.delete('/targets/:id', (req, res) => {
  try {
    const target = getTarget(req.params.id);
    if (!target) return res.status(404).json({ error: '目標不存在' });
    db.prepare('DELETE FROM cloud_targets WHERE id=?').run(target.id);
    audit.log(req, 'backup', '雲端目標', target.id, '刪除雲端/異地備份目標：' + target.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 連線測試（防鎖死）
router.post('/targets/:id/test', async (req, res) => {
  try {
    const target = getTarget(req.params.id);
    if (!target) return res.status(404).json({ error: '目標不存在' });
    const r = await testTarget(target);
    db.prepare('UPDATE cloud_targets SET last_status=?, last_error=? WHERE id=?')
      .run(r.ok ? 'ok' : (r.status || 'error'), r.ok ? '' : (r.error || ''), target.id);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 立即同步（來源＝加密 JSON 備份目錄）
router.post('/targets/:id/sync', async (req, res) => {
  try {
    const target = getTarget(req.params.id);
    if (!target) return res.status(404).json({ error: '目標不存在' });
    const result = await syncFilesToTarget(target, BACKUP_DIR, '^trade_backup_.*\\.json$');
    db.prepare('UPDATE cloud_targets SET last_run=?, last_status=?, last_error=? WHERE id=?')
      .run(nowLocal(), result.ok ? 'ok' : 'error', result.ok ? '' : (result.failed || []).join('; ').slice(0, 500), target.id);
    if (!result.ok) return res.status(400).json({ ok: false, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 列出目標內備份檔
router.get('/targets/:id/list', async (req, res) => {
  try {
    const target = getTarget(req.params.id);
    if (!target) return res.status(404).json({ error: '目標不存在' });
    const r = await listTarget(target);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 刪除目標內備份檔
router.delete('/targets/:id/file/:name', async (req, res) => {
  try {
    const target = getTarget(req.params.id);
    if (!target) return res.status(404).json({ error: '目標不存在' });
    const base = path.basename(req.params.name || '');
    if (!base) return res.status(400).json({ error: '檔名不合法' });
    const safe = isSafeLocalPath(target.remote_path);
    if (!safe.ok) return res.status(400).json({ error: safe.reason });
    const fp = path.join(safe.abs, base);
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return res.status(404).json({ error: '檔案不存在' });
    fs.unlinkSync(fp);
    audit.log(req, 'backup', '雲端目標', target.id, '刪除目標內備份檔：' + base);
    res.json({ ok: true, deleted: base });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── OAuth（Google / OneDrive）P1/P2 預留：現階段回傳 unconfigured ──
router.get('/oauth/start', (req, res) => {
  const target = getTarget(req.query.targetId);
  if (!target) return res.status(404).json({ error: '目標不存在' });
  if (target.type !== 'googledrive' && target.type !== 'onedrive')
    return res.status(400).json({ error: '該目標類型不需 OAuth' });
  res.status(501).json({ ok: false, status: 'unconfigured', error: 'OAuth 尚未實作，需提供 Google / Azure client 憑證（P1/P2）' });
});
router.post('/oauth/callback', (req, res) => {
  res.status(501).json({ error: 'OAuth 尚未實作（P1/P2）' });
});
router.post('/oauth/manual', (req, res) => {
  res.status(501).json({ error: 'OAuth 尚未實作（P1/P2）' });
});

// 同時對外暴露輔助函式（供 routes/backup.js 與排程複用）
module.exports = Object.assign(router, {
  getEnabledLocalTargets,
  syncFilesToTarget,
  syncAllEnabledTargets,
  BACKUP_DIR,
  encryptAuth,
  decryptAuth,
});
