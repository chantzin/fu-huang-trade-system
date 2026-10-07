#!/usr/bin/env node
/**
 * 輔凰貿易系統 — 隔離式 API 寫端 Smoke 測試（N5 端點覆蓋率補強）
 *
 * 設計目標：
 *   1. 完全隔離：自行起一個 server 子程序，使用「臨時 PORT + 臨時 APP_DB」，
 *      絕不連線生產 5200 / 絕不寫入生產 trade.sqlite。
 *   2. 自舉帳號：使用僅限此測試程序的 BOOTSTRAP_ADMIN_PASSWORD，不使用產品預設密碼。
 *   3. 覆蓋核心寫端：customers / products / suppliers / orders / receivables/generate
 *      以及 PUT 更新、訂單狀態推進、角色守衛（sales 建客戶必須 403）。
 *
 * 執行位置：必須在「已部署、含 node_modules 的實例」內執行（LIVE/test_install/app），
 *           因為需要 express / better-sqlite3 等依賴。程式源碼目錄（無 node_modules）
 *           不適合直接跑。可用 env APP_APP_DIR 指定實例根目錄。
 *
 * 用法：node tests/api-write-smoke.mjs
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import net from 'net';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 實例根目錄：優先 APP_APP_DIR，否則取「測試檔上層」（部署後 = app 根）
const BASE_DIR = process.env.APP_APP_DIR || path.resolve(__dirname, '..');
const TEST_ADMIN_PASSWORD = 'mj-ci-only-ephemeral-admin-2026';

// server 進入點：優先 dist-server/server.js，否則退回根目錄 server.js
function resolveServerEntry() {
  const candidates = [
    path.join(BASE_DIR, 'dist-server', 'server.js'),
    path.join(BASE_DIR, 'server.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------- 斷言框架 ----------------
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` → ${extra}` : '')); console.log(`  ❌ ${name}${extra ? ' → ' + extra : ''}`); }
}
function near(a, b, eps = 0.02) { return Math.abs(Number(a) - Number(b)) <= eps; }

// ---------------- HTTP 客戶端 ----------------
let TOKEN = '';
async function api(method, p, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!opts.noAuth && TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  const res = await fetch('http://127.0.0.1:' + PORT + '/api' + p, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const e = new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return data;
}
const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b);
const put = (p, b) => api('PUT', p, b);
const del = (p) => api('DELETE', p);

// ---------------- 全域 ----------------
let PORT = 0;
let DB_PATH = '';
let child = null;

async function waitForHealth(maxMs = 15000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/api/health');
      if (r.ok) { const j = await r.json(); if (j.status === 'ok') return true; }
    } catch { /* not ready */ }
    await sleep(250);
  }
  return false;
}

function cleanupTempDb() {
  for (const suf of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB_PATH + suf); } catch { /* ignore */ }
  }
}

async function main() {
  const entry = resolveServerEntry();
  if (!entry) {
    console.error(`\n💥 找不到 server 進入點（已檢查 ${BASE_DIR}/dist-server/server.js 與 server.js）。\n` +
      `   本測試必須在含 node_modules 的「已部署實例」內執行，或用 APP_APP_DIR 指定根目錄。`);
    process.exit(2);
  }
  console.log(`\n=== 輔凰貿易系統 — 隔離式 API 寫端 Smoke（N5 補強） ===`);
  console.log(`   實例根目錄：${BASE_DIR}`);
  console.log(`   server 進入點：${entry}`);

  PORT = await getFreePort();
  DB_PATH = path.join(os.tmpdir(), `mj-api-smoke-${process.pid}-${Date.now()}.sqlite`);
  console.log(`   臨時 PORT=${PORT}  臨時 APP_DB=${DB_PATH}\n`);

  child = spawn(process.execPath, [entry], {
    cwd: BASE_DIR,
    env: { ...process.env, PORT: String(PORT), APP_DB: DB_PATH, NODE_ENV: 'test', BOOTSTRAP_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childErr = '';
  child.stdout.on('data', () => {}); // 靜默，必要時可開 DEBUG
  child.stderr.on('data', (d) => { childErr += d.toString(); });

  const ready = await waitForHealth();
  if (!ready) {
    console.error('💥 server 未在時限內就緒。stderr 前 500 字：\n' + childErr.slice(0, 500));
    if (child) child.kill('SIGKILL');
    cleanupTempDb();
    process.exit(1);
  }
  console.log('   server 已就緒（/api/health = ok）\n');

  const STAMP = Date.now().toString().slice(-6);
  let cust, prod, sup, order, sales;

  try {
    /* 1. 健康 + 登入 */
    console.log('[1] 健康檢查 / 登入');
    const h = await get('/health').catch(() => ({}));
    ok('GET /api/health = ok', h.status === 'ok');

    const login = await post('/auth/login', { empId: 'admin', password: TEST_ADMIN_PASSWORD }, { noAuth: true });
    TOKEN = login.token;
    ok('ADMIN 工號登入取得 token', !!TOKEN);

    let noAuth = null;
    const saved = TOKEN; TOKEN = '';
    try { await get('/customers'); } catch (e) { noAuth = e; }
    TOKEN = saved;
    ok('未帶 token 存取 API 被拒（401）', noAuth && noAuth.status === 401);

    /* 2. 客戶 寫端 */
    console.log('\n[2] 客戶 customers（POST / PUT / 角色守衛）');
    cust = await post('/customers', {
      customer_no: `C${STAMP}`, name: `寫測客戶${STAMP}`, short_name: 'WT',
      currency: 'USD', payment_terms: '月結60天', terms_days: 60, tax_rate: 0.05,
    });
    ok('POST /api/customers 建立成功回傳 id', cust && cust.id > 0, cust && String(cust.id));

    const custUpd = await put('/customers/' + cust.id, { name: `寫測客戶${STAMP}-改` });
    ok('PUT /api/customers/:id 更新名稱', custUpd && custUpd.name === `寫測客戶${STAMP}-改`, custUpd && custUpd.name);

    /* 3. 產品 / 供應商 寫端 */
    console.log('\n[3] 產品 / 供應商');
    prod = await post('/products', { part_no: `P${STAMP}`, name: '寫測料件', unit: 'PCS', price: 10, currency: 'USD' });
    ok('POST /api/products 建立成功回傳 id', prod && prod.id > 0);

    sup = await post('/suppliers', { code: `S${STAMP}`, name: '寫測工廠', lead_time_days: 30, currency: 'RMB' });
    ok('POST /api/suppliers 建立成功回傳 id', sup && sup.id > 0);

    /* 3a. 供應商報價 → 採購、簽核守門、分批收貨 → 應付與付款（隔離 DB） */
    console.log('\n[3a] 供應商採購至應付結清端到端');
    const quote = await post('/supplier-quotes', { supplier_id:sup.id, quote_date:'2026-09-01', valid_until:'2026-12-31', status:'quoted', tax_rate:0.05, items:[{ product_id:prod.id, part_no:prod.part_no, description:'測試料件', qty:10, unit:'PCS', unit_price:100, tax_rate:0.05 }] });
    const converted = await post(`/supplier-orders/from-quote/${quote.id}`, {});
    ok('F6 有效供應商報價可轉採購並保留明細', converted.source_quote_id===quote.id && converted.items.length===1 && near(converted.items[0].qty,10));
    let duplicateConvert=null; try { await post(`/supplier-orders/from-quote/${quote.id}`,{}); } catch(e) { duplicateConvert=e; }
    ok('F6 同一報價不可重複轉單',duplicateConvert?.status===409);

    const po = await post('/supplier-orders', { supplier_id:sup.id, order_date:'2026-09-01', tax_rate:0, currency:'USD', exchange_rate:31, items:[{product_id:prod.id,part_no:prod.part_no,description:'測試料件',qty:10,unit:'PCS',unit_price:100,tax_rate:0}] });
    const unapproved = await fetch(`http://127.0.0.1:${PORT}/api/supplier-shipments`, {method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+TOKEN},body:JSON.stringify({supplier_id:sup.id,order_id:po.id,order_item_id:po.items[0].id,product_id:prod.id,qty:2,unit_cost:100})});
    ok('F1 未核准採購收貨被拒且不寫入',unapproved.status===409);
    const fixtureDb = new Database(DB_PATH);
    fixtureDb.prepare("UPDATE supplier_orders SET approval_status='approved',status='confirmed' WHERE id=?").run(po.id);
    fixtureDb.close();
    const supOther = await post('/suppliers',{code:`SX${STAMP}`,name:'寫測其他供應商'});
    let wrongSupplier=null; try { await post('/supplier-shipments',{supplier_id:supOther.id,order_id:po.id,order_item_id:po.items[0].id,product_id:prod.id,qty:1,unit_cost:100}); } catch(e) { wrongSupplier=e; }
    ok('F1 採購與進貨供應商不一致時拒絕',wrongSupplier?.status===400);
    const cancelDb = new Database(DB_PATH);
    cancelDb.prepare("UPDATE supplier_orders SET status='cancelled' WHERE id=?").run(po.id);
    cancelDb.close();
    let canceledReceipt=null; try { await post('/supplier-shipments',{supplier_id:sup.id,order_id:po.id,order_item_id:po.items[0].id,product_id:prod.id,qty:1,unit_cost:100}); } catch(e) { canceledReceipt=e; }
    ok('F1 已取消採購單拒絕收貨',canceledReceipt?.status===409);
    const restoreDb = new Database(DB_PATH);
    restoreDb.prepare("UPDATE supplier_orders SET status='confirmed' WHERE id=?").run(po.id);
    restoreDb.close();
    const receipt1 = await post('/supplier-shipments',{supplier_id:sup.id,order_id:po.id,order_item_id:po.items[0].id,product_id:prod.id,qty:2,unit_cost:100,invoice_no:`INV-${STAMP}`,invoice_date:'2026-09-10'});
    const partial = await get('/supplier-orders/'+po.id);
    ok('F2 首批 2/10 收貨狀態為 partial',partial.status==='partial');
    const receipt2 = await post('/supplier-shipments',{supplier_id:sup.id,order_id:po.id,order_item_id:po.items[0].id,product_id:prod.id,qty:8,unit_cost:100});
    const received = await get('/supplier-orders/'+po.id);
    ok('F2 累計 10/10 收貨狀態為 received',received.status==='received');
    let excessEdit=null; try { await put('/supplier-shipments/'+receipt2.id,{qty:9}); } catch(e) { excessEdit=e; }
    await put('/supplier-shipments/'+receipt2.id,{qty:7});
    const editedPartial=await get('/supplier-orders/'+po.id);
    await put('/supplier-shipments/'+receipt2.id,{qty:8});
    ok('F2 收貨更正會重算採購狀態並阻擋超收',excessEdit?.status===409 && editedPartial.status==='partial' && (await get('/supplier-orders/'+po.id)).status==='received');
    const ap = await post(`/payables/from-supplier-shipment/${receipt1.id}`,{amount:1000,currency:'USD',exchange_rate:31,invoice_date:'2026-09-10',due_date:'2026-09-30'});
    ok('F3/F7 確認發票金額及匯率後結轉應付',ap.amount===1000 && ap.currency==='USD' && near(ap.amount_base,31000));
    const apRetry = await post(`/payables/from-supplier-shipment/${receipt1.id}`,{amount:1000,currency:'USD',exchange_rate:31,invoice_date:'2026-09-10',due_date:'2026-09-30'});
    ok('F3 重送轉應付回傳既有應付，不重複建帳',apRetry.id===ap.id);
    let repeatedInvoice=null; try { await post('/payables',{supplier_id:sup.id,invoice_no:` inv-${STAMP} `,amount:500,currency:'USD',exchange_rate:31}); } catch(e) { repeatedInvoice=e; }
    ok('F4 發票號碼去空白且不分大小寫防重',repeatedInvoice?.status===409);
    const otherSupplierInvoice=await post('/payables',{supplier_id:supOther.id,invoice_no:`INV-${STAMP}`,amount:100,currency:'TWD',exchange_rate:1,invoice_date:'2026-08-05',payable_month:'2026-08'});
    ok('F4 不同供應商可使用相同發票字號',otherSupplierInvoice.supplier_id===supOther.id);
    let negative=null, overpay=null;
    try { await post(`/payables/${ap.id}/payments`,{amount:-1,payment_date:'2026-09-20',currency:'USD'}); } catch(e) { negative=e; }
    try { await post(`/payables/${ap.id}/payments`,{amount:1001,payment_date:'2026-09-20',currency:'USD'}); } catch(e) { overpay=e; }
    ok('F5 負數付款與超額付款均拒絕',negative?.status===400 && overpay?.status===409);
    const paymentKey=`pay-${STAMP}-1`;
    await post(`/payables/${ap.id}/payments`,{amount:400,payment_date:'2026-09-20',currency:'USD',exchange_rate:31,reference_no:`BANK-${STAMP}`,idempotency_key:paymentKey});
    const samePayment=await post(`/payables/${ap.id}/payments`,{amount:400,payment_date:'2026-09-20',currency:'USD',exchange_rate:31,reference_no:`BANK-${STAMP}`,idempotency_key:paymentKey});
    ok('F5 相同付款冪等鍵重送不重複入帳',samePayment.amount===400 && (await get(`/payables/${ap.id}/payments`)).length===1);
    ok('F5 付款流水逐筆保存且狀態推導為 partial',(await get('/payables')).find((x)=>x.id===ap.id)?.status==='partial');
    await post(`/payables/${ap.id}/payments`,{amount:600,payment_date:'2026-09-21',currency:'USD',exchange_rate:31});
    ok('F5 付款累計等於發票金額後狀態為 paid',(await get('/payables')).find((x)=>x.id===ap.id)?.status==='paid');
    const preview = await get('/payables/periods/2026-09/preview');
    ok('F8 月結預覽包含應付與付款彙總',preview.payable_count===1 && near(preview.amount,1000) && near(preview.paid,1000));
    await post('/payables/periods/2026-09/close',{});
    let locked=null; try { await put('/payables/'+ap.id,{note:'關帳後修改'}); } catch(e) { locked=e; }
    let lockedPayment=null; try { await post(`/payables/${ap.id}/payments`,{amount:1,payment_date:'2026-09-22',currency:'USD'}); } catch(e) { lockedPayment=e; }
    ok('F8 關帳後禁止修改應付或補登付款',locked?.status===409 && lockedPayment?.status===409);
    await del('/supplier-shipments/'+receipt2.id);
    const afterDelete=await get('/supplier-orders/'+po.id);
    ok('F2 刪除未結轉進貨後採購狀態回算為 partial',afterDelete.status==='partial');

    /* 4. 訂單 寫端（含計算引擎） */
    console.log('\n[4] 訂單 orders（POST / PUT / status）');
    order = await post('/orders', {
      order_date: '2026-08-10', customer_id: cust.id, supplier_id: sup.id,
      currency: 'USD', exchange_rate: 31.5, payment_terms: '月結60天', terms_days: 60,
      items: [
        { product_id: prod.id, part_no: prod.part_no, qty: 1000, unit_price: 10, tax_rate: 0.05, cost_unit: 100 },
      ],
    });
    ok('POST /api/orders 建立成功回傳 id', order && order.id > 0);
    ok('訂單自動產生 order_no', !!order.order_no, order && order.order_no);
    ok('訂單明細 1 筆', order && Array.isArray(order.items) && order.items.length === 1);
    ok('訂單合計 total_base 為數值>0', order && typeof order.totals?.total_base === 'number' && order.totals.total_base > 0, order && String(order.totals?.total_base));

    const ordUpd = await put('/orders/' + order.id, {
      items: [{ product_id: prod.id, part_no: prod.part_no, qty: 500, unit_price: 10, tax_rate: 0.05, cost_unit: 100 }],
    });
    ok('PUT /api/orders/:id 重算（數量 500 → amount 5000）', ordUpd && near(ordUpd.items[0].amount, 5000), ordUpd && String(ordUpd.items?.[0]?.amount));

    const st = await post('/orders/' + order.id + '/status', { status: 'confirmed' });
    ok('POST /api/orders/:id/status → confirmed', st && st.status === 'confirmed');

    /* 5. 應收 寫端（requireAccounting，ADMIN 通過） */
    console.log('\n[5] 應收帳款 receivables/generate');
    // 先推進到可產生應收的狀態（shipped/billed）
    await post('/orders/' + order.id + '/status', { status: 'shipped' });
    const ar = await post('/receivables/generate', { order_id: order.id });
    ok('POST /api/receivables/generate 建立成功回傳 id', ar && ar.id > 0);
    ok('應收 amount_base 為數值>0', ar && typeof ar.amount_base === 'number' && ar.amount_base > 0, ar && String(ar.amount_base));
    ok('應收初始 status = pending', ar && ar.status === 'pending', ar && ar.status);

    /* 6. 角色守衛：sales 不可建客戶（預期 403） */
    console.log('\n[6] 角色守衛（sales 建客戶應 403）');
    const salesUser = await post('/users', { emp_id: `W${STAMP}`, name: '寫測業務', role: 'sales', password: 'sales123' });
    ok('ADMIN 建立 sales 帳號', salesUser && salesUser.emp_id === `W${STAMP}`);
    const salesLogin = await post('/auth/login', { empId: `W${STAMP}`, password: 'sales123' }, { noAuth: true });
    const salesToken = salesLogin.token;
    ok('sales 可用工號登入', !!salesToken);
    let forbid = null;
    const adminToken = TOKEN; TOKEN = salesToken;
    try { await post('/customers', { name: '業務偷建' }); } catch (e) { forbid = e; }
    TOKEN = adminToken;
    ok('sales 建客戶被拒（403 requireMasterWrite）', forbid && forbid.status === 403);

    /* 7. 清理 */
    console.log('\n[7] 清理測試資料');
    await del('/receivables/' + ar.id).catch(() => {});
    await del('/orders/' + order.id).catch(() => {});
    await del('/users/' + salesUser.id).catch(() => {});
    await del('/products/' + prod.id).catch(() => {});
    await del('/suppliers/' + sup.id).catch(() => {});
    await del('/customers/' + cust.id).catch(() => {});
    ok('清理完成（無例外）', true);

  } catch (e) {
    console.error('\n💥 測試中斷：', e.message);
    fail++;
    failures.push('例外：' + e.message);
  } finally {
    if (child) { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
    await sleep(300);
    if (child && !child.killed) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    cleanupTempDb();
  }

  console.log(`\n=== 隔離式 API 寫端 Smoke 結果：${pass} 通過 / ${fail} 失敗 ===`);
  if (fail) {
    console.log('\n失敗項目：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
}

main();
