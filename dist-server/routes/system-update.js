'use strict';
/**
 * 系統更新（更新包）API
 * ------------------------------------------------------------
 * 設計目標：讓「運作中的系統」在有功能或 bug 修正時，可透過「更新包（.mjupd）」
 * 就地套用，而不必走完整四副本部署。日後系統的新增變更都走「更新包模式」更新。
 *
 * 端點：
 *   GET  /api/system-update/status   目前版本 / 建置時間 / 上次更新 / 歷程筆數
 *   GET  /api/system-update/history  已套用更新包清單
 *   POST /api/system-update/apply    上傳 .mjupd（multipart 欄位 pkg）→ 驗證/備份/套用/重啟
 *
 * 套用流程（apply）：
 *   1) 收檔 → 解壓（PowerShell Expand-Archive）
 *   2) 讀 manifest.json → 版本比對（新版本 >= 目前；降版需 ?force=1）
 *   3) 升版前整站備份（排除 node_modules）→ <app>/_upd_backup/pre_<ts>
 *   4) 套用 dist/ 與 dist-server/（robocopy /E /PURGE）
 *   5) 還原 config.json（包內不含 → 從備份還原，保全密鑰/DB 路徑）
 *   6) 依序執行 migrations/*.sql（如有）
 *   7) 寫入新版 version.json、紀錄 system_updates
 *   8) 回應 200 → 1.5s 後寫 _restart.flag + 對自身送 SIGTERM，看門狗 500ms 重生
 *
 * 🔒 權限：管理者或主管（requireManager）
 * ⚠️ 僅支援 Windows 部署環境（解壓/複製依賴 PowerShell + robocopy，與安裝包機制一致）。
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const multer = require('multer');

const { db } = require('../lib/db');
const { requireAuth, requireManager } = require('../lib/auth');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();
router.use(requireAuth);
router.use(requireManager);

// 應用根目錄：編譯後本檔位於 <app>/dist-server/routes，故往上兩層為 <app>
const APP_ROOT = path.join(__dirname, '..', '..');
const VERSION_FILE = path.join(APP_ROOT, 'version.json');
const HISTORY_TABLE = 'system_updates';

/* ---------- 工具 ---------- */
function pad(n) { return String(n).padStart(2, '0'); }
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function trySh(cmd) {
  try { return { ok: true, out: execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) }; }
  catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || ''), code: e.status }; }
}
// 以 robocopy 複製（Windows 對含二進位/中文路徑穩定；/E 遞迴、/PURGE 清目標多餘檔）
function robocopy(src, dst, excludeDirs = []) {
  fs.mkdirSync(dst, { recursive: true });
  const xd = excludeDirs.map((d) => `/XD "${d}"`).join(' ');
  const r = trySh(`robocopy "${src}" "${dst}" /E /PURGE /R:2 /W:1 /NFL /NDL /NJH /NJS /NP ${xd}`);
  const code = r.code === undefined ? 0 : r.code;
  if (code > 7) throw new Error(`robocopy 失敗（code ${code}）：${src} → ${dst}\n${r.out}`);
  return code;
}
function shQuote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function readVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    return { version: v.version || '0.0.0', buildDate: v.buildDate || null, edition: v.edition || '', channel: v.channel || '' };
  } catch {
    return { version: '0.0.0', buildDate: null, edition: '', channel: '' };
  }
}
// 語意化版本比較：a > b 回 1，相等 0，a < b 回 -1
function cmpVer(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_version TEXT,
    to_version TEXT,
    package_name TEXT,
    description TEXT,
    backup_path TEXT,
    applied_at INTEGER,
    operator TEXT
  )`);
}
function latestHistory() {
  try {
    ensureTable();
    return db.prepare(`SELECT * FROM ${HISTORY_TABLE} ORDER BY applied_at DESC LIMIT 1`).get() || null;
  } catch { return null; }
}
function listHistory() {
  try {
    ensureTable();
    return db.prepare(`SELECT * FROM ${HISTORY_TABLE} ORDER BY applied_at DESC LIMIT 50`).all();
  } catch { return []; }
}

/* ---------- 端點 ---------- */
router.get('/status', wrap(async (req, res) => {
  const v = readVersion();
  const last = latestHistory();
  res.json({
    version: v.version,
    buildDate: v.buildDate,
    edition: v.edition,
    channel: v.channel,
    lastUpdate: last ? {
      toVersion: last.to_version,
      fromVersion: last.from_version,
      description: last.description,
      appliedAt: last.applied_at,
      operator: last.operator,
      backupPath: last.backup_path,
    } : null,
    historyCount: listHistory().length,
    time: new Date().toISOString(),
  });
}));

router.get('/history', wrap(async (req, res) => {
  res.json(listHistory());
}));

/* ---------- 套用更新包 ---------- */
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 512 * 1024 * 1024 }, // 512MB 上限
});

router.post('/apply', upload.single('pkg'), wrap(async (req, res) => {
  const force = req.query.force === '1';
  const operator = (req.user && (req.user.emp_id || req.user.username)) || 'unknown';

  if (!req.file) return res.status(400).json({ error: '未收到更新包檔案（欄位名稱應為 pkg）' });
  const orig = req.file.originalname || '';
  if (!/\.(mjupd|zip)$/i.test(orig)) {
    try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    return res.status(400).json({ error: '更新包須為 .mjupd 或 .zip 檔' });
  }

  const pkgPath = req.file.path;
  // PowerShell 的 Expand-Archive 只接受 .zip 副檔名作為來源，故先複製成 .zip 再解壓
  const pkgZip = pkgPath + '.zip';
  try { fs.copyFileSync(pkgPath, pkgZip); } catch { /* 若複製失敗改用原檔 */ }
  const tmp = path.join(os.tmpdir(), 'mjupd_' + Date.now());
  const cleanup = () => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.unlinkSync(pkgPath); } catch { /* ignore */ }
    try { fs.unlinkSync(pkgZip); } catch { /* ignore */ }
  };

  try {
    // 1) 解壓
    const ex = trySh(`powershell -NoProfile -Command "Expand-Archive -Path ${shQuote(pkgZip)} -DestinationPath ${shQuote(tmp)} -Force"`);
    if (!ex.ok) { cleanup(); return res.status(400).json({ error: '更新包解壓失敗，請確認是否為有效的 .mjupd/.zip：\n' + ex.out.slice(0, 300) }); }

    // 2) manifest
    const mfPath = path.join(tmp, 'manifest.json');
    if (!fs.existsSync(mfPath)) { cleanup(); return res.status(400).json({ error: '更新包缺少 manifest.json' }); }
    let mf;
    try { mf = JSON.parse(fs.readFileSync(mfPath, 'utf8')); }
    catch { cleanup(); return res.status(400).json({ error: 'manifest.json 不是合法 JSON' }); }
    if (!mf.version || !mf.name) { cleanup(); return res.status(400).json({ error: 'manifest.json 缺少必要欄位（version / name）' }); }

    const cur = readVersion();
    const cmp = cmpVer(mf.version, cur.version);
    if (cmp < 0 && !force) { cleanup(); return res.status(409).json({ error: `更新包版本 ${mf.version} 低於目前 ${cur.version}；若確定要降版請加 ?force=1（不建議）` }); }
    if (cmp === 0 && !force) { cleanup(); return res.status(409).json({ error: `更新包版本 ${mf.version} 與目前相同；若確定要重新套用請加 ?force=1` }); }

    const srcDist = path.join(tmp, 'dist');
    const srcDS = path.join(tmp, 'dist-server');
    if (!fs.existsSync(srcDist) && !fs.existsSync(srcDS)) { cleanup(); return res.status(400).json({ error: '更新包不含 dist/ 或 dist-server/，無可套用內容' }); }

    // 3) 升版前整站備份（排除 node_modules / _upd_backup / logs，避免遞迴與數十 GB 拷貝）
    const bk = path.join(APP_ROOT, '_upd_backup', 'pre_' + stamp());
    try { robocopy(APP_ROOT, bk, ['node_modules', '_upd_backup', 'logs']); }
    catch (e) { cleanup(); return res.status(500).json({ error: '升版前備份失敗：' + e.message }); }

    // 4) 套用（/PURGE 會清掉包內沒有的舊檔，但 config.json 隨後由備份還原）
    //    ⚠️ 排除 data/uploads/logs/node_modules/_upd_backup：避免 /PURGE 誤刪使用者的
    //       資料庫、上傳檔、日誌，或覆寫其 node_modules。
    try {
      if (fs.existsSync(srcDist)) robocopy(srcDist, path.join(APP_ROOT, 'dist'));
      if (fs.existsSync(srcDS)) robocopy(srcDS, path.join(APP_ROOT, 'dist-server'),
        ['node_modules', 'data', 'uploads', 'logs', '_upd_backup']);
    } catch (e) {
      // 套用失敗 → 從備份回滾
      try { robocopy(bk, APP_ROOT, ['node_modules', '_upd_backup', 'logs']); } catch { /* ignore */ }
      cleanup();
      return res.status(500).json({ error: '套用更新包失敗，已自動回滾：' + e.message });
    }

    // 5) 還原 config.json（包內不含，確保密鑰/DB 路徑/port 不變）
    for (const rel of ['config.json', path.join('dist-server', 'config.json')]) {
      const from = path.join(bk, rel);
      const to = path.join(APP_ROOT, rel);
      if (fs.existsSync(from)) { try { fs.copyFileSync(from, to); } catch { /* ignore */ } }
    }

    // 6) migrations（依檔名字母順序執行 *.sql）
    const migDir = path.join(tmp, 'migrations');
    if (fs.existsSync(migDir)) {
      const sqls = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
      for (const f of sqls) {
        try { db.exec(fs.readFileSync(path.join(migDir, f), 'utf8')); }
        catch (e) {
          // migration 失敗 → 回滾檔案（DB 不回滾，需人工確認），仍重啟以使用回滾後程式碼
          try { robocopy(bk, APP_ROOT, ['node_modules', '_upd_backup', 'logs']); } catch { /* ignore */ }
          cleanup();
          return res.status(500).json({ error: `資料庫遷移失敗（${f}）：${e.message}。已回滾程式碼，請人工檢查資料庫。` });
        }
      }
    }

    // 7) 寫入新版 version.json + 紀錄
    const newVer = {
      version: mf.version,
      buildDate: new Date().toISOString(),
      edition: mf.name || cur.edition,
      channel: mf.channel || cur.channel || 'stable',
      updatedFrom: cur.version,
    };
    fs.writeFileSync(VERSION_FILE, JSON.stringify(newVer, null, 2), 'utf8');

    ensureTable();
    db.prepare(`INSERT INTO ${HISTORY_TABLE} (from_version, to_version, package_name, description, backup_path, applied_at, operator)
      VALUES (?,?,?,?,?,?,?)`).run(
      cur.version, mf.version, mf.name || '更新包', mf.description || '', bk, Date.now(), operator,
    );

    cleanup();

    // 8) 先回應，再觸發重啟（看門狗偵測 _restart.flag + child 退出 → 500ms 重生）
    res.json({
      ok: true,
      from: cur.version,
      to: mf.version,
      description: mf.description || '',
      backup: bk,
      restarting: true,
      msg: '更新包已套用，系統將於數秒內自動重啟以載入新版本。',
    });
    setTimeout(() => {
      try { fs.writeFileSync(path.join(APP_ROOT, '_restart.flag'), new Date().toISOString()); } catch { /* ignore */ }
      try { process.kill(process.pid, 'SIGTERM'); } catch { /* ignore */ }
    }, 1500);
  } catch (e) {
    cleanup();
    return res.status(500).json({ error: '套用更新包時發生未預期錯誤：' + (e.message || e) });
  }
}));

module.exports = router;
