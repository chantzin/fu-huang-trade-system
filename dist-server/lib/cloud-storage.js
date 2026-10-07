'use strict';
/**
 * 雲端／異地備份儲存體抽象層（P0 解耦 OneDrive 寫死，參考 Joplin 設定模式）
 *
 * 共用介面，供兩套既有 offsite 機制使用：
 *   - scripts/backup-db.mjs（整庫熱備份 .sqlite 的 3-2-1 第三副本）
 *   - routes/backup.js（加密 JSON 備份）
 *
 * 設計要點：
 *   - 每個「目標」是一筆 cloud_targets 資料列（type / remote_path / options_json / auth_json）。
 *   - 本模組只對傳入的 target 物件操作檔案系統或（未來）雲端 API，不碰資料庫。
 *   - P0 實作 localfolder（fs 複製，零外部依賴）；googledrive / onedrive / webdav / s3
 *     先回傳 unconfigured，待 P1/P2/P3 帶憑證後接 API。
 *   - 本模組為 CJS（module.exports），可被 CJS route 用 require，亦可被 ESM 腳本用
 *     import 具名匯出（Node cjs-module-lexer 可靜態解析）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = ['localfolder', 'googledrive', 'onedrive', 'webdav', 's3'];

function genId() {
  return crypto.randomUUID ? crypto.randomUUID() : 'ct_' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
}

/* ── 本機路徑安全檢查（防寫入系統目錄） ── */
const FORBIDDEN_PREFIX = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
  '/System', '/usr', '/etc', '/bin', '/sbin', '/var',
];
function isSafeLocalPath(p) {
  if (!p || typeof p !== 'string' || !String(p).trim()) {
    return { ok: false, reason: '路徑為空' };
  }
  const abs = path.resolve(String(p).trim());
  const lower = abs.toLowerCase();
  // 禁止根目錄或系統關鍵目錄
  if (lower === path.parse(abs).root.toLowerCase()) {
    return { ok: false, reason: '禁止指向磁碟根目錄' };
  }
  for (const f of FORBIDDEN_PREFIX) {
    if (lower === f.toLowerCase() || lower.startsWith(f.toLowerCase() + path.sep)) {
      return { ok: false, reason: '禁止寫入系統目錄 ' + f };
    }
  }
  return { ok: true, abs };
}

/* ── 上傳一個本地檔案到指定目標 ── */
async function uploadToTarget(target, localFilePath, remoteName) {
  const type = target && target.type;
  const name = remoteName || path.basename(String(localFilePath));
  if (!fs.existsSync(localFilePath)) {
    return { ok: false, status: 'error', error: '來源檔不存在：' + localFilePath };
  }
  if (type === 'localfolder') {
    const safe = isSafeLocalPath(target.remote_path);
    if (!safe.ok) return { ok: false, status: 'error', error: safe.reason };
    try {
      fs.mkdirSync(safe.abs, { recursive: true });
      const dst = path.join(safe.abs, name);
      fs.copyFileSync(localFilePath, dst);
      const size = fs.statSync(dst).size;
      return { ok: true, status: 'ok', remoteName: name, size };
    } catch (e) {
      return { ok: false, status: 'error', error: e.message };
    }
  }
  return { ok: false, status: 'unconfigured', error: `目標類型 ${type || '(空)'} 尚未實作（需 P1/P2/P3 憑證）` };
}

/* ── 列出目標內備份檔（供 UI 清單） ── */
async function listTarget(target) {
  const type = target && target.type;
  if (type === 'localfolder') {
    const safe = isSafeLocalPath(target.remote_path);
    if (!safe.ok) return { ok: false, status: 'error', error: safe.reason, files: [] };
    if (!fs.existsSync(safe.abs) || !fs.statSync(safe.abs).isDirectory()) {
      return { ok: true, status: 'ok', files: [] };
    }
    try {
      const files = fs.readdirSync(safe.abs).map((f) => {
        const fp = path.join(safe.abs, f);
        let st = null;
        try { st = fs.statSync(fp); } catch (_) { /* ignore */ }
        return { name: f, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0, isDir: st ? st.isDirectory() : false };
      }).filter((x) => !x.isDir).sort((a, b) => b.mtime - a.mtime);
      return { ok: true, status: 'ok', files };
    } catch (e) {
      return { ok: false, status: 'error', error: e.message, files: [] };
    }
  }
  return { ok: false, status: 'unconfigured', error: `目標類型 ${type || '(空)'} 尚未實作`, files: [] };
}

/* ── 刪除過期（保留份數） ──
 * opts.filePattern：正規表達式字串，僅修剪匹配檔名；未提供且 keepCount>0 時不修剪（安全預設）。
 */
async function pruneTarget(target, keepCount, opts) {
  const type = target && target.type;
  if (type !== 'localfolder') {
    return { ok: true, status: 'unconfigured', deleted: [] };
  }
  if (!keepCount || Number(keepCount) <= 0) return { ok: true, status: 'ok', deleted: [] };
  const safe = isSafeLocalPath(target.remote_path);
  if (!safe.ok) return { ok: false, status: 'error', error: safe.reason, deleted: [] };
  if (!fs.existsSync(safe.abs) || !fs.statSync(safe.abs).isDirectory()) return { ok: true, status: 'ok', deleted: [] };
  let re = null;
  if (opts && opts.filePattern) {
    try { re = new RegExp(opts.filePattern); } catch (_) { re = null; }
  }
  try {
    const all = fs.readdirSync(safe.abs)
      .filter((f) => !fs.statSync(path.join(safe.abs, f)).isDirectory())
      .filter((f) => (re ? re.test(f) : true))
      .map((f) => ({ f, t: fs.statSync(path.join(safe.abs, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    const deleted = [];
    for (const x of all.slice(Number(keepCount))) {
      try { fs.unlinkSync(path.join(safe.abs, x.f)); deleted.push(x.f); } catch (_) { /* ignore */ }
    }
    return { ok: true, status: 'ok', deleted };
  } catch (e) {
    return { ok: false, status: 'error', error: e.message, deleted: [] };
  }
}

/* ── 連線測試（防鎖死，參考 Joplin「設定前先驗證」） ── */
async function testTarget(target) {
  const type = target && target.type;
  if (type === 'localfolder') {
    const safe = isSafeLocalPath(target.remote_path);
    if (!safe.ok) return { ok: false, status: 'error', error: safe.reason };
    try {
      fs.mkdirSync(safe.abs, { recursive: true });
      const probe = path.join(safe.abs, '.cloud_probe_' + Date.now() + '.tmp');
      fs.writeFileSync(probe, 'ok');
      try { fs.unlinkSync(probe); } catch (_) { /* ignore */ }
      return { ok: true, status: 'ok', message: '路徑可寫入：' + safe.abs };
    } catch (e) {
      return { ok: false, status: 'error', error: '路徑不可寫入：' + e.message };
    }
  }
  if (type === 'googledrive' || type === 'onedrive' || type === 'webdav' || type === 's3') {
    return { ok: false, status: 'unconfigured', error: `類型 ${type} 需 P1/P2/P3 憑證（尚未實作）` };
  }
  return { ok: false, status: 'error', error: '未知的目標類型：' + String(type) };
}

module.exports = {
  TYPES,
  genId,
  isSafeLocalPath,
  uploadToTarget,
  listTarget,
  pruneTarget,
  testTarget,
};
