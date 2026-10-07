#!/usr/bin/env node
/**
 * 輔凰貿易系統 — API 端點存活回歸（R7 安全網 + 覆蓋率補強）
 *
 * 隔離式：臨時 PORT + 臨時 APP_DB，不碰生產。
 * 策略：以 ADMIN 登入後，對一份「代表性 GET 端點清單」逐個發請求，
 *       斷言「不得回 500」（500 = 改寫導致的崩潰／回歸）。
 *       同時統計回 200 的數量，作為 API 健檢覆蓋率的代理指標。
 *
 * 用途：P3-3 翻 (a)（lib .ts 單一來源）前建立安全網；
 *       任何 lib/routes 重構只要讓端點拋 500，本測試立即報錯。
 *
 * 用法：node tests/api-regression.mjs
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import net from 'net';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_DIR = process.env.APP_APP_DIR || path.resolve(__dirname, '..');
const TEST_ADMIN_PASSWORD = 'mj-ci-only-ephemeral-admin-2026';

function resolveServerEntry() {
  for (const c of [path.join(BASE_DIR, 'dist-server', 'server.js'), path.join(BASE_DIR, 'server.js')]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` → ${extra}` : '')); console.log(`  ❌ ${name}${extra ? ' → ' + extra : ''}`); }
}

let PORT = 0, DB_PATH = '', child = null;
async function waitForHealth(maxMs = 15000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/api/health'); if (r.ok) { const j = await r.json(); if (j.status === 'ok') return true; } }
    catch { /* not ready */ }
    await sleep(250);
  }
  return false;
}
function cleanupTempDb() { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + s); } catch {} } }

let TOKEN = '';
async function probe(p, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!opts.noAuth && TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  const res = await fetch('http://127.0.0.1:' + PORT + '/api' + p, { method: opts.method || 'GET', headers });
  return res.status;
}

async function main() {
  const entry = resolveServerEntry();
  if (!entry) { console.error('\n💥 找不到 server 進入點。須在含 node_modules 的實例內執行。'); process.exit(2); }
  console.log(`\n=== 輔凰貿易 — API 存活回歸（R7） ===\n   實例：${BASE_DIR}\n   進入點：${entry}`);
  PORT = await getFreePort();
  DB_PATH = path.join(os.tmpdir(), `mj-reg-${process.pid}-${Date.now()}.sqlite`);
  console.log(`   臨時 PORT=${PORT}  APP_DB=${DB_PATH}\n`);

  child = spawn(process.execPath, [entry], {
    cwd: BASE_DIR,
    env: { ...process.env, PORT: String(PORT), APP_DB: DB_PATH, NODE_ENV: 'test', APP_MANUALS_DIR: path.join(BASE_DIR, 'docs'), BOOTSTRAP_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childErr = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => { childErr += d.toString(); });
  const ready = await waitForHealth();
  if (!ready) {
    console.error('💥 server 未就緒。stderr：\n' + childErr.slice(0, 600));
    if (child) child.kill('SIGKILL');
    cleanupTempDb();
    process.exit(1);
  }
  console.log('   server 已就緒\n');

  // 登入（admin 通過所有角色守衛）
  const login = await (async () => {
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ empId: 'admin', password: TEST_ADMIN_PASSWORD }),
    });
    return r.json();
  })();
  TOKEN = login.token;
  ok('ADMIN 登入取得 token', !!TOKEN);
  if (!TOKEN) { console.error('無 token，終止'); process.exit(1); }

  // 代表性 GET 端點清單（含 R7 原 65/101 缺口中較易觸發崩潰的清單/設置類）
  const endpoints = [
    // 基礎主檔
    ['/company-profile', true],
    ['/users', false],
    ['/customers', false],
    ['/products', false],
    ['/suppliers', false],
    ['/ar-terms', false],
    ['/orders', false],
    ['/receivables', false],
    ['/payables', false],
    ['/customer-statements', false], // customer-statements
    ['/approvals', false],
    ['/forms', false],
    // 供應商協作
    ['/supplier-quotes', false],
    ['/supplier-orders', false],
    ['/supplier-shipments', false],
    // 參數 / 設定
    ['/params/meta', false],
    ['/params/rates', false],
    ['/params/audit-logs', false],
    ['/params/fx', false],
    ['/system-settings', false],
    ['/mail-config', false],
    ['/mail-logs', false],
    // 報表
    ['/reports/dashboard', false],
    ['/reports/by-customer', false],
    ['/reports/by-sales', false],
    ['/reports/by-product', false],
    ['/reports/by-month', false],
    ['/reports/delivery', false],
    // 手冊 / 郵件 / 匯入
    ['/manuals/operation', false],
    ['/manuals/build', false],
    ['/email/preview', false],
    ['/import/template/customers', false],
    ['/import/template/products', false],
  ];

  let okCount = 0, crashCount = 0, otherCount = 0;
  console.log(`[1] 端點存活掃描（${endpoints.length} 個 GET）`);
  for (const [p, isPublic] of endpoints) {
    let status = -1;
    try { status = await probe(p, { noAuth: isPublic }); }
    catch (e) { status = -1; }
    const crashed = status === 500 || status === -1;
    const live = status >= 200 && status < 400;
    if (crashed) { crashCount++; ok(`GET ${p} 未崩潰(非500)`, false, 'status=' + status); }
    else if (live) { okCount++; }
    else { otherCount++; } // 401/403/404 視為可接受（資源/權限）
    console.log(`    ${crashed ? '❌' : '✅'} ${p} → ${status}`);
  }
  ok('無端點回 500（無回歸崩潰）', crashCount === 0, `crash=${crashCount}`);
  console.log(`\n   統計：200~399 存活 ${okCount} / 其他(401/403/404) ${otherCount} / 崩潰 ${crashCount}`);

  if (child) { try { child.kill('SIGTERM'); } catch {} }
  await sleep(300);
  if (child && !child.killed) { try { child.kill('SIGKILL'); } catch {} }
  cleanupTempDb();

  console.log(`\n=== API 存活回歸結果：${pass} 通過 / ${fail} 失敗 ===`);
  if (fail) { console.log('\n失敗項目：'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}
main();
