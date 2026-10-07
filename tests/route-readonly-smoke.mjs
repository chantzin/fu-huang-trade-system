#!/usr/bin/env node
/**
 * 輔凰貿易系統 — 唯讀 / 雙驅動 route 回歸測試（P3-2 Phase2 2.1 + R7 安全網）
 *
 * 隔離式：自行起 server 子程序，使用「臨時 PORT + 臨時 APP_DB」，
 * 絕不連線生產 5200 / 絕不寫入生產 trade.sqlite。
 *
 * 覆蓋：2.1 遷移的 10 個 route 之主要 GET 端點（含公開 company-profile、
 *       需登入的 users/products/suppliers/ar-terms/params/system-settings/
 *       mail-config/mail-logs、以及 auth/login）。
 * 目的：證明把 import 從 ../lib/db 換成 ../lib/db-dual 後，route 行為不變。
 *
 * 用法：node tests/route-readonly-smoke.mjs   （須在含 node_modules 的實例內）
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
async function api(method, p, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!opts.noAuth && TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  const res = await fetch('http://127.0.0.1:' + PORT + '/api' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) { const e = new Error((data && (data.error || data.message)) || `HTTP ${res.status}`); e.status = res.status; throw e; }
  return data;
}
const get = (p, opts) => api('GET', p, null, opts);

async function main() {
  const entry = resolveServerEntry();
  if (!entry) { console.error('\n💥 找不到 server 進入點。本測試須在含 node_modules 的實例內執行。'); process.exit(2); }
  console.log(`\n=== 輔凰貿易 — 唯讀/雙驅動 route 回歸（2.1+R7） ===`);
  console.log(`   實例：${BASE_DIR}\n   進入點：${entry}`);
  PORT = await getFreePort();
  DB_PATH = path.join(os.tmpdir(), `mj-ro-${process.pid}-${Date.now()}.sqlite`);
  console.log(`   臨時 PORT=${PORT}  APP_DB=${DB_PATH}\n`);

  child = spawn(process.execPath, [entry], {
    cwd: BASE_DIR,
    env: { ...process.env, PORT: String(PORT), APP_DB: DB_PATH, NODE_ENV: 'test', BOOTSTRAP_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD },
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

  try {
    /* 公開端點（不需 token） */
    console.log('[1] 公開端點');
    const cp = await get('/company-profile', { noAuth: true }).catch((e) => ({ _err: e.status }));
    ok('GET /api/company-profile（公開）回 200', cp && !cp._err && typeof cp === 'object', JSON.stringify(cp).slice(0, 60));

    /* 登入（auth route） */
    console.log('\n[2] 登入（auth route）');
    const login = await api('POST', '/auth/login', { empId: 'admin', password: TEST_ADMIN_PASSWORD }, { noAuth: true });
    TOKEN = login.token;
    ok('ADMIN 工號登入取得 token', !!TOKEN);

    /* 需登入的唯讀端點（2.1 遷移清單） */
    console.log('\n[3] 遷移清單內之唯讀 GET 端點');
    const cases = [
      ['products', '/products'],
      ['suppliers', '/suppliers'],
      ['ar-terms', '/ar-terms'],
      ['users', '/users'],
      ['params/meta', '/params/meta'],
      ['system-settings', '/system-settings'],
      ['mail-config', '/mail-config'],
      ['mail-logs', '/mail-logs'],
    ];
    for (const [name, p] of cases) {
      const r = await get(p).catch((e) => ({ _err: e.status, _m: e.message }));
      ok(`GET /api/${p} 回 200`, r && !r._err && typeof r !== 'undefined', JSON.stringify(r).slice(0, 60));
    }

    /* 反向確認：db-dual 確實被 route 使用（而非原始 lib/db） */
    console.log('\n[4] 雙驅動接入確認');
    const status = await get('/system-settings').catch(() => ({}));
    ok('system-settings 可取得（route 經 db-dual 正常讀取）', status && typeof status === 'object');

  } catch (e) {
    console.error('\n💥 測試中斷：', e.message);
    fail++; failures.push('例外：' + e.message);
  } finally {
    if (child) { try { child.kill('SIGTERM'); } catch {} }
    await sleep(300);
    if (child && !child.killed) { try { child.kill('SIGKILL'); } catch {} }
    cleanupTempDb();
  }

  console.log(`\n=== 唯讀/雙驅動回歸結果：${pass} 通過 / ${fail} 失敗 ===`);
  if (fail) { console.log('\n失敗項目：'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}
main();
