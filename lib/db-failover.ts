// @ts-nocheck
// @ts-nocheck
'use strict';
/**
 * P3-2 雙軌容錯：db 層 failover 選擇器（止血版 Phase 1，預設關閉）
 *
 * 主庫 = LIVE SQLite（better-sqlite3，同步）
 * 備庫 = MySQL / MariaDB（mysql2/promise，非同步）
 *
 * 行為：
 *   - cfg.db.failover.enabled = true 時，建立 MySQL 連線池並啟動健康探測迴圈。
 *   - 定時探測主庫；主庫不可用 → 自動切備庫（若備庫可用）；主庫恢復 → 自動回切。
 *   - 提供 getStatus() 供運維查詢目前 active backend。
 *
 * ⚠️ 重要限制（Phase 1 止血版）：
 *   現有 routes/lib 仍以「同步」better-sqlite3 呼叫為主（db.prepare().get()），
 *   本選擇器「不會」自動接管既有查詢——切換僅改變 active 狀態與 query/run 路由 API 的目標。
 *   要讓既有讀寫真正走備庫，需將 DB 存取改為非同步並經由本模組（Phase 2 雙驅動遷移）。
 *   mysql2 為選用依賴：僅在 enabled 時 require；未安裝或連不上不影響主庫運作。
 */

const path = require('path');
const { execFileSync } = require('child_process');

// Resolve database secrets without storing a production password in config.json.
// `passwordDpapiFile` points to a LocalMachine DPAPI envelope. File ACLs must
// restrict access to the service account, SYSTEM, and Administrators. This
// lets the S4U watchdog read the secret without requiring an interactive
// user's DPAPI profile. Plaintext exists only in this process and its child.
function resolveMysqlPassword(options) {
  if (process.env.APP_MYSQL_PASSWORD) return process.env.APP_MYSQL_PASSWORD;
  if (options && options.passwordDpapiFile) {
    if (process.platform !== 'win32') throw new Error('DPAPI MySQL credentials require Windows');
    const script = [
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Security',
      '$record=Get-Content -LiteralPath $env:APP_MYSQL_SECRET_FILE -Raw | ConvertFrom-Json',
      "if($record.format -ne 'dpapi-machine-v1'){throw 'Unsupported DPAPI credential format'}",
      '$cipher=[Convert]::FromBase64String($record.ciphertext)',
      '$plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)',
      'try{[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))}finally{[Array]::Clear($plain,0,$plain.Length);[Array]::Clear($cipher,0,$cipher.Length)}',
    ].join(';');
    return execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, APP_MYSQL_SECRET_FILE: path.resolve(options.passwordDpapiFile) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return (options && options.password) || '';
}

let cfg = null;          // db.failover 設定物件
let primaryDb = null;    // better-sqlite3 實例（由 lib/db 注入）
let mysqlPool = null;    // mysql2/promise 連線池
let active = 'primary'; // 'primary' | 'secondary'
let lastError = null;
let lastSwitchAt = null;
let lastPrimaryOk = null;
let lastSecondaryOk = null;
let timer = null;

function isEnabled() {
  return !!(cfg && cfg.enabled);
}

function getActive() {
  return active;
}

function getStatus() {
  return {
    enabled: isEnabled(),
    automaticFailover: isEnabled() && cfg.automaticFailover !== false,
    active,
    hasPool: !!mysqlPool,
    lastPrimaryOk,
    lastError,
    lastSwitchAt,
    lastSecondaryOk,
    config: isEnabled()
      ? {
          host: cfg.host,
          port: cfg.port,
          user: cfg.user,
          database: cfg.database,
          healthIntervalMs: cfg.healthIntervalMs,
        }
      : null,
  };
}

// 注入設定與主庫 SQLite 實例；啟用時建立備庫連線池與健康迴圈。
function configure(config, sqliteDb) {
  cfg = (config && config.db && config.db.failover) || null;
  primaryDb = sqliteDb || null;
  active = 'primary';
  lastError = null;
  lastSwitchAt = null;
  lastPrimaryOk = null;
  lastSecondaryOk = null;
  mysqlPool = null;

  if (isEnabled()) {
    try {
      const mysql = require('mysql2/promise');
      mysqlPool = mysql.createPool({
        host: cfg.host || '127.0.0.1',
        port: cfg.port || 3306,
        user: cfg.user || 'root',
        password: resolveMysqlPassword(cfg),
        database: cfg.database || 'trade',
        waitForConnections: true,
        connectionLimit: (cfg.connectionLimit || 5),
        connectTimeout: (cfg.connectTimeoutMs || 4000),
        enableKeepAlive: true,
      });
      startHealthLoop();
      healthSecondary().catch(() => {});
    } catch (e) {
      lastError = 'MySQL 連線池建立失敗：' + e.message;
      mysqlPool = null;
      active = 'primary';
    }
  }
  return getStatus();
}

async function healthPrimary() {
  if (!primaryDb) return false;
  try {
    primaryDb.prepare('SELECT 1').get();
    lastPrimaryOk = true;
    return true;
  } catch (e) {
    lastPrimaryOk = false;
    lastError = 'primary health fail: ' + e.message;
    return false;
  }
}

async function healthSecondary() {
  if (!mysqlPool) return false;
  try {
    const [rows] = await mysqlPool.query('SELECT 1 AS ok');
    lastSecondaryOk = !!(rows && rows[0] && rows[0].ok === 1);
    if (lastSecondaryOk && lastError && lastError.startsWith('secondary health fail:')) lastError = null;
    return lastSecondaryOk;
  } catch (e) {
    lastSecondaryOk = false;
    lastError = 'secondary health fail: ' + e.message;
    return false;
  }
}

// 狀態機：主庫 OK 且目前在備庫 → 回切；主庫 FAIL 且目前在主庫且有可用備庫 → 切備庫
async function maybeFailover() {
  const ok = await healthPrimary();
  // A snapshot ETL is not a synchronous replica. Keep SQLite authoritative
  // until the operator explicitly enables switching after replication is live.
  if (cfg && cfg.automaticFailover === false) {
    active = 'primary';
    return active;
  }
  if (ok && active === 'secondary') {
    active = 'primary';
    lastSwitchAt = new Date().toISOString();
    lastError = null;
  } else if (!ok && active === 'primary') {
    const sOk = await healthSecondary();
    if (sOk) {
      active = 'secondary';
      lastSwitchAt = new Date().toISOString();
    }
  }
  return active;
}

function startHealthLoop() {
  if (timer || !isEnabled()) return;
  const iv = (cfg && cfg.healthIntervalMs) || 15000;
  timer = setInterval(() => {
    maybeFailover().catch(() => {});
    healthSecondary().catch(() => {});
  }, iv);
  if (timer.unref) timer.unref();
}

function stopHealthLoop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// 路由 API（供 Phase 2 既有呼叫改寫後使用）。注意 SQL 方言差異需由呼叫方處理。
async function query(sql, params) {
  if (active === 'secondary' && mysqlPool) {
    const [rows] = await mysqlPool.query(sql, params || []);
    return rows;
  }
  return primaryDb.prepare(sql).all(...(params || []));
}

async function run(sql, params) {
  if (active === 'secondary' && mysqlPool) {
    const [r] = await mysqlPool.query(sql, params || []);
    return { ok: true, info: r };
  }
  return primaryDb.prepare(sql).run(...(params || []));
}

// ---------- SQL 方言正規化（MySQL 端） ----------
function normMysql(sql) {
  if (!sql) return sql;
  let s = String(sql);
  s = s.replace(/datetime\(\s*'now'(?:\s*,\s*'localtime')?\s*\)/gi, 'NOW()');
  s = s.replace(
    /ON\s+CONFLICT\s*\(\s*(\w+)\s*\)\s+DO\s+NOTHING/gi,
    (_, col) => `ON DUPLICATE KEY UPDATE ${col}=${col}`
  );
  s = s.replace(/\bAUTOINCREMENT\b/gi, 'AUTO_INCREMENT');
  return s;
}

// 交易句柄：綁定單一連線，prepare().get/all/run 經 conn.query（已翻譯方言）
function makeTxHandle(conn) {
  function prepare(sql) {
    const msql = normMysql(sql);
    return {
      async get(...args) {
        const [rows] = await conn.query(msql, args);
        return rows && rows.length ? rows[0] : undefined;
      },
      async all(...args) {
        const [rows] = await conn.query(msql, args);
        return rows || [];
      },
      async run(...args) {
        const [r] = await conn.query(msql, args);
        return {
          lastInsertRowid: r && r.insertId != null ? r.insertId : 0,
          changes: r && r.affectedRows != null ? r.affectedRows : 0,
        };
      },
    };
  }
  return { prepare, raw: conn };
}

/**
 * 備庫（MySQL）交易：取得專用連線 → BEGIN → fn(txHandle) → COMMIT，
 * fn 拋錯則 ROLLBACK。fn 必須為 async 且透過傳入的 txHandle 存取 DB。
 * 僅在 failover 啟用（secondary 有意義）時使用；未啟用拋錯由呼叫方（db-dual）降級處理。
 */
async function transaction(fn) {
  if (!mysqlPool) {
    throw new Error('db-failover.transaction: 備庫連線池不存在（failover 未啟用）');
  }
  const conn = await mysqlPool.getConnection();
  try {
    await conn.query('BEGIN');
    const r = await fn(makeTxHandle(conn));
    await conn.query('COMMIT');
    return r;
  } catch (e) {
    try { await conn.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    conn.release();
  }
}

export {
  configure,
  isEnabled,
  getActive,
  getStatus,
  healthPrimary,
  healthSecondary,
  maybeFailover,
  startHealthLoop,
  stopHealthLoop,
  query,
  run,
  transaction,
};
