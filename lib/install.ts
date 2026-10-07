// @ts-nocheck
'use strict';
/**
 * 安裝識別與環境標籤（INS，H3 / 商用前高優先項）
 * ------------------------------------------------------------
 * 目的：多客戶部署時能「區分哪一套裝置／哪一家客戶／授權綁誰」。
 * 做法：
 *   - 首次啟動自動產生一組穩定的 installId（裝置序號），持久化於 <app>/data/install.json。
 *   - 提供 getInstallInfo() 彙整 installId / installAt / environment / appName / version / edition。
 *   - installId 透過 company-profile 公開端點暴露（登入頁/sidebar 可顯示），
 *     並透過 /api/system/install-info（admin）提供完整資訊供授權頁顯示。
 * 注意：installId 僅為隨機識別碼，非密鑰，公開無安全疑慮。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 應用根：編譯後本檔位於 <app>/dist-server/lib/install.js，往上兩層為 app 根
const APP_ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(APP_ROOT, 'data');
const INSTALL_PATH = path.join(DATA_DIR, 'install.json');

/** 讀取 version.json（根目錄），失敗回空物件 */
function readVersion() {
  try {
    const vp = path.join(APP_ROOT, 'version.json');
    if (fs.existsSync(vp)) return JSON.parse(fs.readFileSync(vp, 'utf8'));
  } catch (_) { /* ignore */ }
  return { version: '', edition: '', channel: '' };
}

/** 產生人類可讀且唯一的 installId：MJ-<base36 時間戳>-<隨機> */
function genInstallId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `MJ-${ts}-${rnd}`;
}

let _info = null;
function load() {
  if (_info) return _info;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* ignore */ }
  let info = null;
  if (fs.existsSync(INSTALL_PATH)) {
    try { info = JSON.parse(fs.readFileSync(INSTALL_PATH, 'utf8')); } catch (_) { info = null; }
  }
  if (!info || !info.installId) {
    info = {
      installId: genInstallId(),
      installAt: new Date().toISOString(),
      environment: process.env.APP_ENV || 'production',
    };
    try { fs.writeFileSync(INSTALL_PATH, JSON.stringify(info, null, 2), 'utf8'); }
    catch (_) { /* 唯讀環境忽略（使用記憶體值） */ }
  }
  _info = info;
  return info;
}

/** 取得完整安裝識別資訊（含來自 config.json 的 appName 與 version.json 的版本） */
function getInstallInfo() {
  const info = load();
  let appName = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config.json'), 'utf8') || '{}');
    appName = cfg.app_name || '';
  } catch (_) { /* ignore */ }
  const ver = readVersion();
  return {
    installId: info.installId,
    installAt: info.installAt,
    environment: info.environment,
    appName,
    version: ver.version || '',
    edition: ver.edition || '',
    channel: ver.channel || '',
  };
}

module.exports = { getInstallInfo, INSTALL_PATH };
