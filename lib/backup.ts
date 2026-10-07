// @ts-nocheck
'use strict';
/**
 * 自動備份排程（將 config.backup 接上每日排程）
 *
 * 實作狀態：
 *   config.backup.autoDaily / hour 已由 startSched 實際讀取並掛載每日排程；
 *   config.backup.dir 由 scripts/backup-db.mjs 實際讀取決定備份落點。
 *   兩者皆已實作並啟用（B1 修復後經實測驗證）。
 *
 * 實作：
 *   - startSched(cfg, appDir, log)：每日 cfg.backup.hour 觸發一次整庫備份。
 *   - 實作上 spawn 既有的 scripts/backup-db.mjs（複用其 wal_checkpoint + online
 *     backup + 保留策略），不重複實作邏輯，避免與手動備份漂移。
 *   - 備份落點（dir）由 app 根 config.json 的 config.backup.dir 決定；
 *     dist-server/config.json 的 backup.dir 僅供參考，落點以 app/config.json 為準。
 *
 * 注意（B4）：「排程開關」(autoDaily/hour) 讀 dist-server/config.json，
 *            「備份落點」(dir) 讀 app/config.json，二者來源不同，維運時勿混淆。
 *
 * 用法（server.js）：
 *   const backup = require('./lib/backup');
 *   backup.startSched(cfg, __dirname, console.log);
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * 定位備份腳本 scripts/backup-db.mjs。
 *
 * 【B1 根因】原實作 path.join(__dirname,'..','scripts',...) 在「部署佈局」下會解析成
 *   dist-server/lib/backup.js → dist-server/scripts/backup-db.mjs（不存在），
 *   導致排程每日 code=1 靜默失敗、備份停擺。
 * 真實腳本位於應用根：<app>/scripts/backup-db.mjs（Source 與部署皆同）。
 *
 * 候選佈局：
 *   Source：   lib/backup.js → ../scripts/backup-db.mjs
 *   部署：     dist-server/lib/backup.js → ../../scripts/backup-db.mjs（dist-server/scripts 不存在）
 *   最後手段： process.cwd()/scripts/backup-db.mjs
 * 並向上遞迴尋找任一祖先下的 scripts/backup-db.mjs。
 */
function backupScriptPath() {
  const candidates = [
    path.join(__dirname, '..', 'scripts', 'backup-db.mjs'),
    path.join(__dirname, '..', '..', 'scripts', 'backup-db.mjs'),
    path.join(process.cwd(), 'scripts', 'backup-db.mjs'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const up = path.join(dir, 'scripts', 'backup-db.mjs');
    if (fs.existsSync(up)) return up;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates[0]; // 全失敗回傳首選（保留原錯誤行為以便日誌顯示）
}

/**
 * 解析「應用根目錄」——含 config.json(db.path) + data/ + scripts/ 的真實根（<app>/）。
 *
 * 【B1 第二部分】server 的 __dirname 在部署下是 <app>/dist-server，
 *   但真正存活的 DB 在 <app>/data/trade.sqlite、config.json(db.path) 在 <app>/config.json，
 *   而 <app>/dist-server/data/trade.sqlite 是編譯殘留的舊（空）庫。
 * 若直接把 dist-server 當 APP_DIR 傳給 backup-db.mjs，會備到舊庫而失敗/產空備份。
 * 故從 appDir 與其父層中挑出「含 db.path 且 scripts/ 存在」的那一層作為應用根。
 */
function resolveAppRoot(appDir) {
  const base = appDir || path.join(__dirname, '..');
  const candidates = [base, path.join(base, '..')];
  for (const c of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(c, 'config.json'), 'utf8'));
      if (j && j.db && j.db.path && fs.existsSync(path.join(c, 'scripts', 'backup-db.mjs'))) return c;
    } catch { /* try next */ }
    if (fs.existsSync(path.join(c, 'scripts', 'backup-db.mjs')) && fs.existsSync(path.join(c, 'data'))) return c;
  }
  return base;
}

/**
 * 立刻觸發一次備份（spawn 既有腳本）。
 * @param {string} appDir 應用根目錄（server.js 的 __dirname），用於定位 data/ 與 config.json
 * @param {function} log 紀錄函式（預設 console.log）
 */
function triggerBackup(appDir, log) {
  const script = backupScriptPath();
  const target = resolveAppRoot(appDir); // 解析到真正含 live DB + config.json 的應用根
  const child = spawn(process.execPath, [script, target], {
    stdio: 'ignore',
    env: process.env,
    windowsHide: true,
  });
  child.on('error', (e) => { if (log) log('[backup] 排程備份啟動失敗：' + e.message); });
  child.on('close', (code) => { if (log) log('[backup] 排程備份結束（code=' + code + '）'); });
  if (log) log(`[backup] 排程備份已觸發 → ${script}（目標 ${target}）`);
  return child;
}

let schedInstalled = false;
/**
 * 掛載每日自動備份排程。
 * @param {object} cfg 應用設定（含 cfg.backup）
 * @param {string} appDir 應用根目錄
 * @param {function} log 紀錄函式
 */
function startSched(cfg, appDir, log) {
  if (schedInstalled) return;
  schedInstalled = true;
  const bc = (cfg && cfg.backup) || {};
  if (!bc.autoDaily) {
    if (log) log('[backup] autoDaily 關閉，不啟動自動備份排程');
    return;
  }
  const hour = Number(bc.hour != null ? bc.hour : 3);
  let lastDay = '';
  const tick = () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const day = `${y}-${m}-${d}`;
    if (now.getHours() === hour && lastDay !== day) {
      lastDay = day;
      triggerBackup(appDir, log);
    }
  };
  // 每分鐘檢查一次，命中設定小時且當天未跑過才觸發
  setInterval(tick, 60 * 1000);
  if (log) log(`[backup] 自動備份排程已掛載（每日 ${hour}:00；落點由 <app>/config.json 的 backup.dir 決定，與 dist-server/config.json 無關）`);
}

export { startSched, triggerBackup };
