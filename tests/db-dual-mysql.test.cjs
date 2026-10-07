'use strict';
/**
 * P3-2 Phase2 2.3 整合測試：db-dual 備庫（MySQL/MariaDB）路由
 *
 * 不碰 LIVE SQLite：lib/db 以 APP_DB=:memory: 開記憶體庫。
 * 對本機 MariaDB（trade）建臨時表 _app_dual_test，驗證：
 *   - failover 強制切 secondary 後，db-dual 的 get/all/run 實際路由到 MySQL；
 *   - 備庫交易（BEGIN/COMMIT）可提交、錯誤可回滾；
 *   - 回傳結構（lastInsertRowid / changes）與 better-sqlite3 相容（供 await 呼叫無縫切換）。
 *
 * 與 tests/db-dual.test.cjs（primary 透傳）互補，二者皆 failover 關閉時零影響。
 */
process.env.APP_DB = ':memory:';

const assert = require('assert');
const mysql = require('mysql2/promise');
const dual = require('../lib/db-dual');
const fo = require('../lib/db-failover');

const MYSQL = {
  host: process.env.APP_MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.APP_MYSQL_PORT || 3306),
  user: process.env.APP_MYSQL_USER,
  password: process.env.APP_MYSQL_PASSWORD,
  database: process.env.APP_MYSQL_DB,
};

if (!MYSQL.user || !MYSQL.password || !MYSQL.database || MYSQL.database === 'trade') {
  console.error('[blocked] Set APP_MYSQL_USER, APP_MYSQL_PASSWORD and an isolated APP_MYSQL_DB (not trade).');
  process.exit(2);
}

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name); }
}

(async () => {
  // 獨立連線建臨時表（不經 failover pool，避免清理順序問題）
  const admin = await mysql.createConnection(MYSQL);
  await admin.query('DROP TABLE IF EXISTS _app_dual_test');
  await admin.query(
    `CREATE TABLE _app_dual_test (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(64),
      v DOUBLE DEFAULT 0,
      created_at DATETIME DEFAULT NOW()
    )`
  );
  console.log('  · 已建 MariaDB 臨時表 _app_dual_test');

  // 強制 failover active=secondary：注入「主庫故障」的假 primaryDb 並啟用
  const fakeBadPrimary = { prepare: () => { throw new Error('simulated primary down'); } };
  fo.configure({ db: { failover: { enabled: true, host: MYSQL.host, port: MYSQL.port, user: MYSQL.user, password: MYSQL.password, database: MYSQL.database, connectTimeoutMs: 4000 } } }, fakeBadPrimary);
  await fo.maybeFailover(); // 主庫失敗 + 備庫可用 → 切 secondary
  ok('failover 切到 secondary', fo.getActive() === 'secondary');

  // run（secondary 經 fo.run + normMysql）
  const r = await dual.prepare(`INSERT INTO _app_dual_test (name, v) VALUES (?,?)`).run('alpha', 3.5);
  ok('secondary run lastInsertRowid=1', typeof r.lastInsertRowid === 'number' && r.lastInsertRowid === 1);
  ok('secondary run changes=1', r.changes === 1);

  // all
  const all = await dual.prepare(`SELECT * FROM _app_dual_test ORDER BY id`).all();
  ok('secondary all 長度 1', Array.isArray(all) && all.length === 1);
  ok('secondary all 值正確', all[0].name === 'alpha' && all[0].v === 3.5);

  // get
  const one = await dual.prepare(`SELECT * FROM _app_dual_test WHERE id=?`).get(1);
  ok('secondary get 單列', one && one.name === 'alpha');
  const none = await dual.prepare(`SELECT * FROM _app_dual_test WHERE id=?`).get(999);
  ok('secondary get 空結果 undefined', none === undefined);

  // 交易：提交
  const commit = dual.transaction(async (tx) => {
    await tx.prepare(`INSERT INTO _app_dual_test (name) VALUES (?)`).run('beta');
    return 'committed';
  });
  const txRes = await commit();
  ok('secondary transaction 回傳 fn 結果', txRes === 'committed');
  const cnt = await dual.prepare(`SELECT COUNT(*) AS c FROM _app_dual_test`).get();
  ok('transaction 已提交（2 列）', cnt.c === 2);

  // 交易：回滾
  let rolled = false;
  try {
    const rollback = dual.transaction(async (tx) => {
      await tx.prepare(`INSERT INTO _app_dual_test (name) VALUES (?)`).run('gamma');
      throw new Error('force rollback');
    });
    await rollback();
  } catch (e) { rolled = (e.message === 'force rollback'); }
  ok('secondary transaction 拋錯觸發回滾', rolled);
  const cnt2 = await dual.prepare(`SELECT COUNT(*) AS c FROM _app_dual_test`).get();
  ok('回滾後仍 2 列（gamma 未寫入）', cnt2.c === 2);

  // 清場
  await admin.query('DROP TABLE IF EXISTS _app_dual_test');
  await admin.end();
  fo.stopHealthLoop();

  console.log(`\n結果：通過 ${pass} / 失敗 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('測試例外：', e);
  try { fo.stopHealthLoop(); } catch (_) {}
  process.exit(2);
});
