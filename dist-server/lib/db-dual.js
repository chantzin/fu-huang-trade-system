// @ts-nocheck
'use strict';
/**
 * P3-2 Phase2 雙驅動相容適配器（地基 2.0，2.1 硬化）
 *
 * 仿 better-sqlite3 表面：prepare().get/all/run、transaction()、pragma()、exec()，
 * 對內路由到 primary(SQLite) / secondary(MySQL)。
 *
 * ⭐ 關鍵設計（2.1 硬化）：
 *   - **primary 模式「同步、直連 lib/db 的 sqliteDb」**，與今日 better-sqlite3 行為
 *     位元級一致（含 run() 回傳 {lastInsertRowid, changes}）。因此：
 *       (1) 完全不依賴 db-failover.configure 的注入順序；
 *       (2) route 只需把 import 從 '../lib/db' 換成 '../lib/db-dual'，handler 不用改；
 *       (3) failover.enabled=false（當前）時零回歸風險、可還原。
 *   - **secondary 模式才走非同步**（fo.query/run + 方言翻譯 normMysql）。
 *   - 此設計把「全系統 async/await 改寫」推遲到 2.4（接線＋failover 演練）一次到位，
 *     2.1 先以最低風險把 route 接上雙驅動模組。
 *
 * ⚠️ 警示：primary 回傳同步值、secondary 回傳 Promise。本模組啟用 failover（2.4）
 *   前必須把所有 call site 改為 `await`，否則切備庫時會因拿到 Promise 而非值而壞。
 */

const fo = require('./db-failover');
const { db: sqliteDb, DB_FILE, DATA_DIR, initSchema } = require('./db');

// ---------- 方言正規化（僅 MySQL 端套用） ----------
function normMysql(sql) {
  if (!sql) return sql;
  let s = String(sql);
  // datetime('now','localtime') / datetime('now') -> NOW()
  s = s.replace(/datetime\(\s*'now'(?:\s*,\s*'localtime')?\s*\)/gi, 'NOW()');
  // ON CONFLICT(col) DO NOTHING -> ON DUPLICATE KEY UPDATE col=col
  s = s.replace(
    /ON\s+CONFLICT\s*\(\s*(\w+)\s*\)\s+DO\s+NOTHING/gi,
    (_, col) => `ON DUPLICATE KEY UPDATE ${col}=${col}`
  );
  // AUTOINCREMENT -> AUTO_INCREMENT（DDL 備援用）
  s = s.replace(/\bAUTOINCREMENT\b/gi, 'AUTO_INCREMENT');
  return s;
}

// 依當前 active backend 決定是否翻譯
function norm(sql) {
  const dialect = fo.getActive() === 'secondary' ? 'mysql' : 'sqlite';
  return dialect === 'mysql' ? normMysql(sql) : sql;
}

function isSecondary() {
  return fo.getActive() === 'secondary';
}

// ---------- 準備語句（仿 better-sqlite3，接受可變參數） ----------
// primary：同步、直連 sqliteDb（與 better-sqlite3 完全一致）。
// secondary：非同步、經 fo.query/run + normMysql 翻譯。
function prepare(sql) {
  return {
    get(...args) {
      if (isSecondary()) {
        return fo.query(normMysql(sql), args).then(
          (rows) => (rows && rows.length ? rows[0] : undefined)
        );
      }
      return sqliteDb.prepare(sql).get(...args);
    },
    all(...args) {
      if (isSecondary()) {
        return fo.query(normMysql(sql), args).then((rows) => rows || []);
      }
      return sqliteDb.prepare(sql).all(...args);
    },
    run(...args) {
      if (isSecondary()) {
        return fo.run(normMysql(sql), args).then((r) => {
          const info = r && r.info ? r.info : r;
          return {
            lastInsertRowid: info && info.insertId != null ? info.insertId : 0,
            changes: info && info.affectedRows != null ? info.affectedRows : 0,
          };
        });
      }
      return sqliteDb.prepare(sql).run(...args);
    },
  };
}

// ---------- 交易 ----------
// primary：沿用 better-sqlite3 原生交易（callback 透過閉包 db 同步執行），同步回傳結果。
// secondary：委派 db-failover 連線交易（BEGIN/COMMIT/ROLLBACK），fn 須 async 並使用傳入 txHandle。
//   注意：primary 同步回傳、secondary 回傳 Promise，與 get/all/run 一致；啟用 failover 前所有
//   call site 必須 `await`（即 Phase2 2.4 全站 async/await 改寫）。
// ⚠️ 必須回傳「工廠函式」以符合 better-sqlite3 語意與 route 用法
//    （route 寫法：const tx = db.transaction(cb); tx(args)）。
//    舊版直接 `sqliteDb.transaction(fn)()` 會立即執行並回傳結果，
//    導致 `const tx = db.transaction(cb); tx(args)` 拿到的是結果而非函式而壞掉。
function transaction(fn) {
  if (isSecondary()) {
    // 工廠語意：呼叫時才以傳入 args 執行交易（failover 啟用時 fn 須 async 並用 txHandle）
    return (...args) => fo.transaction((txHandle) => fn(txHandle, ...args));
  }
  // primary（預設，enabled=false）：
  //   - 同步回呼（既有路由）走 better-sqlite3 原生交易，行為與改前「完全一致」（零回歸）。
  //   - 非同步回呼（Phase2.4 啟用 failover 前預先準備）改用手動 BEGIN/COMMIT/ROLLBACK
  //     + await fn，使同一支 fn 在 primary（await 同步值）與 secondary（await Promise）皆可用。
  const isAsync = !!(fn.constructor && fn.constructor.name === 'AsyncFunction');
  if (!isAsync) {
    const g = sqliteDb.transaction(fn);
    return (...args) => g(...args);
  }
  return async (...args) => {
    sqliteDb.exec('BEGIN');
    try {
      const r = await fn(dual, ...args);
      sqliteDb.exec('COMMIT');
      return r;
    } catch (e) {
      try { sqliteDb.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      throw e;
    }
  };
}

// ---------- pragma ----------
function pragma(name) {
  if (isSecondary()) return undefined; // MySQL 無 pragma
  return sqliteDb.pragma(name);
}

// ---------- exec（多語句） ----------
function exec(sql) {
  if (isSecondary()) {
    const stmts = String(sql).split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
    return (async () => {
      for (const st of stmts) await fo.run(normMysql(st), []);
    })();
  }
  return sqliteDb.exec(sql);
}

// 對外導出：routes 以 `const { db } = require('../lib/db-dual')` 使用，
// db 即雙驅動 API（primary 同步直連、secondary 非同步）。
const dual = { prepare, transaction, pragma, exec, norm, normMysql, raw: fo };
module.exports = {
  db: dual,
  prepare,
  transaction,
  pragma,
  exec,
  norm,
  normMysql,
  raw: fo,
  DB_FILE,
  DATA_DIR,
  initSchema,
};
