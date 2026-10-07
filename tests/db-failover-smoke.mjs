// @ts-nocheck
/**
 * P3-2 雙軌容錯 —— failover 選擇器隔離式證明測試（smoke）
 *
 * 完全隔離，不碰生產：
 *   - 主庫 = 臨時 SQLite（os.tmpdir 下的空庫）
 *   - 備庫 = 本機 MariaDB；憑證與資料庫由環境變數提供，僅執行 SELECT 1，唯讀不寫
 *
 * 驗證項目：
 *   1. enabled 時建立連線池與健康探測；active='primary'
 *   2. 主庫健康 OK、備庫健康 OK
 *   3. 強制主庫 down（close）後 maybeFailover() → active='secondary'，備庫仍 OK
 *   4. query('SELECT 1 AS ok') 在 secondary 模式下確實路由到 MySQL 並回傳 ok=1
 *   5. 主庫恢復（重開 handle）後 maybeFailover() → 自動回切 active='primary'
 *   6. disabled 時 configure 不建池、status.enabled=false
 *
 * 用法（須在有 node_modules + mysql2 的實例內執行）：
 *   node tests/db-failover-smoke.mjs
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import dbFailover from '../lib/db-failover.js';

const TMP = path.join(os.tmpdir(), `mj-failover-test-${Date.now()}.sqlite`);
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  ✅ ${name} ${extra}`); pass++; }
  else { console.log(`  ❌ ${name} ${extra}`); fail++; }
}

async function main() {
  // ---- 1. enabled：建立主/備 ----
  const primary = new Database(TMP);
  const cfg = {
    db: {
      failover: {
        enabled: true,
        host: process.env.APP_MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.APP_MYSQL_PORT || 3306),
        user: process.env.APP_MYSQL_USER,
        password: process.env.APP_MYSQL_PASSWORD,
        passwordDpapiFile: process.env.APP_MYSQL_SECRET_FILE,
        database: process.env.APP_MYSQL_DB,
        healthIntervalMs: 15000,
        connectTimeoutMs: 4000,
      },
    },
  };
  if (!cfg.db.failover.user || (!cfg.db.failover.password && !cfg.db.failover.passwordDpapiFile) || !cfg.db.failover.database) {
    throw new Error('請設定 MySQL 帳號、密碼或 APP_MYSQL_SECRET_FILE，以及資料庫名稱');
  }
  const st0 = dbFailover.configure(cfg, primary);
  check('enabled 時 configure 回傳 enabled=true', st0.enabled === true, `active=${st0.active}`);
  check('初始 active=primary', dbFailover.getActive() === 'primary');
  check('healthPrimary()=true（主庫可用）', (await dbFailover.healthPrimary()) === true);
  check('healthSecondary()=true（MariaDB 可連）', (await dbFailover.healthSecondary()) === true);

  // ---- 3-4. 強制主庫 down → 自動切備庫 + query 路由 ----
  primary.close();                       // 模擬 SQLite 損壞/無法開啟
  const switched = await dbFailover.maybeFailover();
  check('主庫 down 後 maybeFailover 切到 secondary', switched === 'secondary', `active=${dbFailover.getActive()}`);
  check('切換後 healthSecondary 仍 OK', (await dbFailover.healthSecondary()) === true);
  const rows = await dbFailover.query('SELECT 1 AS ok');
  check('secondary 模式下 query 路由到 MySQL 並回傳 ok=1',
    Array.isArray(rows) && rows[0] && rows[0].ok === 1,
    `rows=${JSON.stringify(rows && rows[0])}`);

  const heldPrimary = dbFailover.configure({
    db: { failover: { ...cfg.db.failover, automaticFailover: false } },
  }, primary);
  check('automaticFailover=false 時監控保持啟用', heldPrimary.enabled === true && heldPrimary.automaticFailover === false);
  check('備庫資料尚未設為連續複寫時不自動切換', await dbFailover.maybeFailover() === 'primary');

  // ---- 5. 主庫恢復 → 自動回切 ----
  const primary2 = new Database(TMP);    // 重新開啟（模擬修復）
  dbFailover.configure(cfg, primary2);  // 重新注入修復後的主庫
  const back = await dbFailover.maybeFailover();
  check('主庫恢復後自動回切 active=primary', back === 'primary', `active=${dbFailover.getActive()}`);

  // ---- 6. disabled：不建池 ----
  dbFailover.stopHealthLoop();
  const stOff = dbFailover.configure({ db: { failover: { enabled: false } } }, null);
  check('disabled 時 status.enabled=false', stOff.enabled === false);
  check('disabled 時不建連線池 hasPool=false', stOff.hasPool === false);

  // 清理
  try { fs.unlinkSync(TMP); } catch { /* ignore */ }
  primary2.close();

  console.log(`\n[db-failover-smoke] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('測試異常：', e); process.exit(2); });
