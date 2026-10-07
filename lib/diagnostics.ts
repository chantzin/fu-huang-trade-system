// @ts-nocheck
'use strict';
/**
 * 支援診斷包（SUP，H4 / 商用前高優先項）
 * ------------------------------------------------------------
 * 組合「系統資訊 + 授權狀態 + DB 健全度 + 近期 log + 備份狀態」，
 * 並封裝成最小 ZIP（store 法，不壓縮，附 CRC32）供遠端支援下載。
 * 無第三方 zip 依賴，自行實作 ZIP writer（相容 Windows 檔案總管 / unzip）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { db, DATA_DIR } = require('../lib/db-dual');
const { getState } = require('../lib/license');
const { getInstallInfo } = require('../lib/install');

const APP_ROOT = path.join(__dirname, '..', '..');

/** 解析 log 目錄（優先 config.log.dir，否則 <app>/logs） */
function getLogsDir() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config.json'), 'utf8') || '{}');
    if (cfg && cfg.log && cfg.log.dir) return path.resolve(APP_ROOT, cfg.log.dir);
  } catch (_) { /* ignore */ }
  return path.join(APP_ROOT, 'logs');
}

/** 讀取檔案尾部 N bytes 並轉 UTF-8 字串 */
function readTail(filePath, maxBytes) {
  try {
    const st = fs.statSync(filePath);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(Math.min(maxBytes, st.size));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_) { return ''; }
}

/** 彙整診斷資訊物件 */
function collectDiagnostics() {
  const ver = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'version.json'), 'utf8')); }
    catch (_) { return {}; }
  })();
  const install = getInstallInfo();
  const lic = getState();

  // DB 健全度
  let dbHealth = {};
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get();
    const page = db.prepare('PRAGMA page_count').get();
    const free = db.prepare('PRAGMA freelist_count').get();
    const keyTables = ['users', 'customers', 'products', 'orders', 'shipments', 'receivables', 'quotations', 'suppliers', 'payables'];
    const counts = {};
    for (const t of keyTables) {
      try { counts[t] = db.prepare('SELECT COUNT(*) c FROM ' + t).get().c; }
      catch (_) { counts[t] = 'ERR'; }
    }
    let dbSize = 0;
    try { dbSize = fs.statSync(db.DB_FILE || db.name || '').size; } catch (_) { dbSize = 0; }
    dbHealth = {
      integrity: integrity.integrity_check,
      pageCount: page.page_count,
      freelistCount: free.freelist_count,
      dbSizeBytes: dbSize,
      keyTableCounts: counts,
    };
  } catch (e) {
    dbHealth = { error: e.message };
  }

  // 近期 log（最新一份 app log 的尾部）
  let recentLogs = '';
  try {
    const logsDir = getLogsDir();
    const logs = fs.readdirSync(logsDir).filter((f) => /^app-.*\.log$/.test(f)).sort().reverse();
    if (logs.length) recentLogs = readTail(path.join(logsDir, logs[0]), 20000);
  } catch (_) { /* ignore */ }

  // 備份狀態
  let backup = {};
  try {
    const bdir = path.join(DATA_DIR, 'backups');
    const files = fs.readdirSync(bdir)
      .filter((f) => /^trade_backup_.*\.json$/.test(f))
      .map((f) => {
        const fp = path.join(bdir, f);
        let st = null; try { st = fs.statSync(fp); } catch (_) { st = null; }
        return { name: f, mtime: st ? st.mtimeMs : 0, size: st ? st.size : 0 };
      })
      .sort((a, b) => b.mtime - a.mtime);
    backup = {
      count: files.length,
      latest: files[0] ? { name: files[0].name, mtime: files[0].mtime, size: files[0].size } : null,
      list: files.slice(0, 10),
    };
  } catch (e) {
    backup = { error: e.message };
  }

  return {
    generatedAt: new Date().toISOString(),
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      uptimeSec: Math.round(process.uptime()),
      totalMemMB: Math.round(os.totalmem() / 1048576),
      freeMemMB: Math.round(os.freemem() / 1048576),
      appRoot: APP_ROOT,
      dbFile: (db.DB_FILE || db.name || ''),
    },
    version: ver,
    install,
    license: lic,
    dbHealth,
    backup,
    recentLogsTail: recentLogs,
  };
}

/* ============== 最小 ZIP writer（store 法，無壓縮） ============== */
let _crcTable = null;
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (_crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // method = store
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0, 12);           // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra len
    nameBuf.copy(local, 30);
    chunks.push(local, data);

    const c = Buffer.alloc(46 + nameBuf.length);
    c.writeUInt32LE(0x02014b50, 0);       // central dir header signature
    c.writeUInt16LE(20, 4);               // version made by
    c.writeUInt16LE(20, 6);               // version needed
    c.writeUInt16LE(0, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(0, 30);               // extra len
    c.writeUInt16LE(0, 32);               // comment len
    c.writeUInt16LE(0, 34);               // disk number
    c.writeUInt16LE(0, 36);               // internal attrs
    c.writeUInt32LE(0, 38);               // external attrs
    c.writeUInt32LE(offset, 42);          // local header offset
    nameBuf.copy(c, 46);
    central.push(c);
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central dir signature
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);                // comment len
  return Buffer.concat([...chunks, centralBuf, end]);
}

/** 產生診斷包 ZIP（Buffer） */
function buildDiagnosticsZip() {
  const d = collectDiagnostics();
  const files = [
    { name: 'system-info.json', data: JSON.stringify({ system: d.system, version: d.version, install: d.install, generatedAt: d.generatedAt }, null, 2) },
    { name: 'license.json', data: JSON.stringify(d.license, null, 2) },
    { name: 'db-health.json', data: JSON.stringify(d.dbHealth, null, 2) },
    { name: 'backup.json', data: JSON.stringify(d.backup, null, 2) },
    { name: 'recent-logs.txt', data: d.recentLogsTail || '(no logs)' },
  ];
  return makeZip(files);
}

module.exports = { collectDiagnostics, buildDiagnosticsZip };
