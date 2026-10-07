#!/usr/bin/env node
/**
 * 輔凰貿易訂單暨應收帳款系統 — Smoke 測試
 * 用法：node tests/smoke.mjs [baseUrl]
 * 覆蓋：健康檢查 / 工號登入 / 基本資料 / 訂單計算引擎 / 出貨 / 應收推導與收款 /
 *       報表 / Excel 匯出匯入骨架 / 使用者與權限 / 參數與匯率 / 操作日誌
 */
import { fileURLToPath } from 'url';
import path from 'path';

const BASE = process.argv[2] || 'http://127.0.0.1:5200';
const ADMIN_PASSWORD = process.env.APP_TEST_ADMIN_PASSWORD || process.env.APP_ADMIN_PASSWORD;
const STAMP = Date.now().toString().slice(-6);

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` → ${extra}` : '')); console.log(`  ❌ ${name}${extra ? ' → ' + extra : ''}`); }
}

function near(a, b, eps = 0.02) { return Math.abs(Number(a) - Number(b)) <= eps; }

let TOKEN = '';
async function api(method, p, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-MJ-Probe': '1' };
  if (!opts.noAuth && TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  const res = await fetch(BASE + '/api' + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('spreadsheet') || ct.includes('octet-stream')) return { _bin: res };
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

/** 直接抓取原始 response（給 PDF / 二進位用，不丟例外） */
async function getRaw(p) {
  const res = await fetch(BASE + '/api' + p, {
    method: 'GET',
    headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN, 'X-MJ-Probe': '1' } : { 'X-MJ-Probe': '1' },
  });
  return res;
}

async function main() {
  if (!ADMIN_PASSWORD) throw new Error('請透過 APP_TEST_ADMIN_PASSWORD 提供隔離測試管理員密碼');
  console.log(`\n=== 輔凰貿易系統 Smoke 測試（${BASE}） ===\n`);

  /* ---------- 1. 健康檢查 ---------- */
  console.log('[1] 健康檢查');
  const h = await get('/health').catch(() => ({}));
  ok('GET /api/health 回應 ok', h.status === 'ok', JSON.stringify(h).slice(0, 80));

  /* ---------- 2. 工號登入 ---------- */
  console.log('\n[2] 工號登入（🔒 硬規則）');
  const login = await post('/auth/login', { empId: 'admin', password: ADMIN_PASSWORD }, { noAuth: true });
  TOKEN = login.token;
  ok('以工號登入取得 token', !!TOKEN);
  ok('回傳 user.emp_id 為工號', login.user && !!login.user.emp_id);
  ok('auth.provider = local', login.provider === 'local');

  let badLogin = null;
  try { await post('/auth/login', { empId: 'admin', password: 'wrong-password' }, { noAuth: true }); }
  catch (e) { badLogin = e; }
  ok('錯誤密碼被拒（401）', badLogin && badLogin.status === 401);

  let noAuthFail = null;
  const saved = TOKEN; TOKEN = '';
  try { await get('/customers'); } catch (e) { noAuthFail = e; }
  TOKEN = saved;
  ok('未帶 token 存取 API 被拒（401）', noAuthFail && noAuthFail.status === 401);

  /* ---------- 3. 基本資料 ---------- */
  console.log('\n[3] 基本資料（客戶 / 產品 / 供應商）');
  const cust = await post('/customers', {
    customer_no: `C${STAMP}`, name: `測試客戶${STAMP}`, short_name: '測試',
    tax_id: '12345678', currency: 'USD', payment_terms: '月結60天', terms_days: 60, tax_rate: 0.05,
  });
  ok('建立客戶', cust && cust.id > 0);
  const custList = await get('/customers?keyword=' + STAMP);
  ok('客戶關鍵字搜尋可查到', Array.isArray(custList) && custList.some((c) => c.id === cust.id));

  const prod = await post('/products', {
    part_no: `P${STAMP}`, name: '測試料件', spec: 'S-100', unit: 'PCS',
    cost_unit: 100, price: 10, currency: 'USD', stock_qty: 7,
  });
  ok('建立產品（料號）', prod && prod.id > 0);

  const sup = await post('/suppliers', { code: `S${STAMP}`, name: '東莞測試廠', lead_time_days: 30, currency: 'RMB' });
  ok('建立供應商', sup && sup.id > 0);

  /* ---------- 4. 訂單與計算引擎 ---------- */
  console.log('\n[4] 訂單管理與計算引擎');
  const rate = 31.5; // USD→TWD
  const order = await post('/orders', {
    order_date: '2026-08-10',
    customer_id: cust.id,
    supplier_id: sup.id,
    currency: 'USD',
    exchange_rate: rate,
    payment_terms: '月結60天',
    terms_days: 60,
    factory_eta: '2026-09-15',
    customer_eta: '2026-09-20',
    items: [
      // 數量 1000 × 單價 10 USD，稅 5% → 10,500 USD → 330,750 TWD
      // 成本 = 100×1000 + 500 = 100,500；運費 = 3,000 + 1,500 = 4,500
      // 利潤 = 330,750 − 100,500 − 4,500 = 225,750
      { product_id: prod.id, part_no: prod.part_no, qty: 1000, unit_price: 10, tax_rate: 0.05, cost_unit: 100, other_fee: 500, freight_cn: 3000, freight_tw: 1500 },
      { product_id: prod.id, part_no: prod.part_no, qty: 200, unit_price: 10, tax_rate: 0.05, cost_unit: 100, other_fee: 0 },
    ],
  });
  ok('建立訂單（含 2 筆明細）', order && order.items && order.items.length === 2);
  ok('自動產生訂單編號', !!order.order_no, order.order_no);
  ok('自動帶出訂單月份 2026-08', order.month === '2026-08', order.month);

  const it0 = order.items[0];
  ok('應收貨款 = 數量×單價 = 10000', near(it0.amount, 10000), String(it0.amount));
  ok('稅額 = 應收×5% = 500', near(it0.tax_amount, 500), String(it0.tax_amount));
  ok('應收總額(原幣) = 10500', near(it0.total, 10500), String(it0.total));
  ok('應收總額(本位幣) = 10500×31.5 = 330750', near(it0.total_base, 330750), String(it0.total_base));
  ok('成本總額 = 100×1000+500 = 100500', near(it0.cost_total, 100500), String(it0.cost_total));
  ok('利潤 = 330750−100500−4500 = 225750', near(it0.profit, 225750), String(it0.profit));
  ok('毛利% = 225750/330750 ≈ 0.6825', near(it0.margin, 225750 / 330750, 0.001), String(it0.margin));
  ok('運費% 已計算', near(it0.freight_pct, (4500 / 330750) * 100, 0.01), String(it0.freight_pct));
  ok('訂單合計 total_base = 330750 + 66150', near(order.totals.total_base, 330750 + 66150), String(order.totals.total_base));

  const it1 = order.items[1];
  ok('第二筆明細匯率一致（31.5）', near(it1.total / it1.total_base, 1 / rate, 0.0001), `${it1.total}/${it1.total_base}`);

  // 修改數量後應自動重算
  const upd = await put('/orders/' + order.id, {
    items: [{ product_id: prod.id, part_no: prod.part_no, qty: 500, unit_price: 10, tax_rate: 0.05, cost_unit: 100 }],
  });
  ok('修改訂單後明細重算（數量 500 → 應收 5000）', near(upd.items[0].amount, 5000), String(upd.items[0].amount));
  await put('/orders/' + order.id, {
    items: [
      { product_id: prod.id, part_no: prod.part_no, qty: 1000, unit_price: 10, tax_rate: 0.05, cost_unit: 100, other_fee: 500, freight_cn: 3000, freight_tw: 1500 },
      { product_id: prod.id, part_no: prod.part_no, qty: 200, unit_price: 10, tax_rate: 0.05, cost_unit: 100 },
    ],
  });

  const preview = await post('/orders/' + order.id + '/preview-ar', { base_date: '2026-09-20' });
  ok('應收推導：結帳月份 = 2026-09', preview.billing_month === '2026-09', preview.billing_month);
  // month_end 規則：2026-09-30 + 60 天 = 2026-11-29
  ok('應收推導：兌現日 = 2026-11-29（月底+60天）', preview.due_date === '2026-11-29', preview.due_date);
  ok('應收推導：應收月份 = 2026-11', preview.receivable_month === '2026-11', preview.receivable_month);

  const st = await post('/orders/' + order.id + '/status', { status: 'confirmed' });
  ok('訂單狀態推進為 confirmed', st.status === 'confirmed');

  /* ---------- 5. 出貨 ---------- */
  console.log('\n[5] 出貨與單據');
  const ship = await post('/shipments', {
    order_id: order.id, ship_date: '2026-09-20', qty: 1200,
    declaration_no: `DECL${STAMP}`, invoice_no: `INV${STAMP}`, invoice_date: '2026-09-20',
  });
  ok('建立出貨紀錄', ship && ship.id > 0);
  ok('自動產生出貨單號', !!ship.shipment_no, ship.shipment_no);
  const afterShip = await get('/orders/' + order.id);
  ok('出貨後訂單狀態推進為 shipped', afterShip.status === 'shipped', afterShip.status);
  ok('訂單回寫出貨日 2026-09-20', afterShip.ship_date === '2026-09-20', String(afterShip.ship_date));

  /* ---------- 6. 應收帳款 ---------- */
  console.log('\n[6] 應收帳款（月結推導 / 收款 / 帳齡）');
  const ar = await post('/receivables/generate', { order_id: order.id });
  ok('產生應收帳款', ar && ar.id > 0);
  ok('應收金額 = 訂單本位幣合計', near(ar.amount_base, 330750 + 66150), String(ar.amount_base));
  ok('結帳月份 = 2026-09', ar.billing_month === '2026-09', ar.billing_month);
  ok('兌現日 = 2026-11-29', ar.due_date === '2026-11-29', String(ar.due_date));
  ok('未收款前 status = pending', ar.status === 'pending', ar.status);
  const afterBilled = await get('/orders/' + order.id);
  ok('產生應收後訂單狀態 = billed', afterBilled.status === 'billed', afterBilled.status);

  const partial = await post('/receivables/' + ar.id + '/receive', { amount: 100000, received_date: '2026-11-20' });
  ok('部分收款後 status = partial', partial.status === 'partial', partial.status);
  ok('部分收款後已收金額 = 100000', near(partial.received_amount, 100000));

  const full = await post('/receivables/' + ar.id + '/receive', { amount: 396900, received_date: '2026-11-29' });
  ok('收足後 status = received', full.status === 'received', full.status);
  ok('收足後 confirmed = 1', full.confirmed === 1);
  const afterPaid = await get('/orders/' + order.id);
  ok('收足後訂單狀態 = paid', afterPaid.status === 'paid', afterPaid.status);

  const aging = await get('/receivables/aging');
  ok('帳齡分析回傳 buckets', aging && aging.buckets && typeof aging.buckets === 'object');
  const stmt = await get('/receivables/statement?customer_id=' + cust.id);
  ok('客戶對帳單可產生', stmt && stmt.summary && typeof stmt.summary.outstanding === 'number');

  /* ---------- 7. 報表 ---------- */
  console.log('\n[7] 報表與經營分析');
  const dash = await get('/reports/dashboard');
  ok('儀表板 KPI 可取得', dash && dash.kpi && typeof dash.kpi.revenue === 'number');
  ok('儀表板含趨勢資料', Array.isArray(dash.trend));
  for (const [name, p] of [
    ['客戶別', '/reports/by-customer'], ['業務別', '/reports/by-sales'],
    ['產品別', '/reports/by-product'], ['月份別', '/reports/by-month'], ['交期追蹤', '/reports/delivery'],
  ]) {
    const r = await get(p);
    ok(`${name}報表可取得`, Array.isArray(r) && r.length > 0);
  }

  /* ---------- 8. Excel 匯出／匯入骨架 ---------- */
  console.log('\n[8] Excel 匯出／匯入骨架');
  for (const t of ['orders', 'receivable', 'delivery']) {
    const res = await get('/reports/export?type=' + t);
    const buf = Buffer.from(await res._bin.arrayBuffer());
    ok(`匯出 ${t} 為 xlsx（${buf.length} bytes）`, buf.length > 1000 && buf.slice(0, 2).toString() === 'PK');
  }
  for (const t of ['customers', 'products', 'orders']) {
    const res = await get('/import/template/' + t);
    const buf = Buffer.from(await res._bin.arrayBuffer());
    ok(`下載 ${t} 匯入範本`, buf.length > 1000 && buf.slice(0, 2).toString() === 'PK');
  }

  /* ---------- 9. 使用者與權限 ---------- */
  console.log('\n[9] 使用者與權限（🔒 工號必填）');
  let dup = null;
  try { await post('/users', { emp_id: 'admin', name: '重複工號', role: 'sales' }); } catch (e) { dup = e; }
  ok('重複工號建立被拒（400）', dup && dup.status === 400);

  let noEmp = null;
  try { await post('/users', { name: '沒工號', role: 'sales' }); } catch (e) { noEmp = e; }
  ok('缺工號建立被拒（400）', noEmp && noEmp.status === 400);

  const sales = await post('/users', { emp_id: `S${STAMP}`, name: '測試業務', role: 'sales', password: 'sales123' });
  ok('建立業務帳號', sales && sales.emp_id === `S${STAMP}`);
  ok('使用者清單含工號', (await get('/users')).every((u) => 'emp_id' in u));

  const salesLogin = await post('/auth/login', { empId: `S${STAMP}`, password: 'sales123' }, { noAuth: true });
  ok('新業務可用工號登入', !!salesLogin.token);

  // 業務視野隔離
  const salesToken = TOKEN;
  TOKEN = salesLogin.token;
  const myOrders = await get('/orders');
  ok('業務只看得到自己的單（看不到管理員那張）', Array.isArray(myOrders) && !myOrders.some((o) => o.id === order.id));
  let forbid = null;
  try { await post('/customers', { name: '業務偷建客戶' }); } catch (e) { forbid = e; }
  ok('業務無法新增客戶（403）', forbid && forbid.status === 403);
  TOKEN = salesToken;

  /* ---------- 10. 參數與匯率 ---------- */
  console.log('\n[10] 參數與匯率（多幣別）');
  const meta = await get('/params/meta');
  ok('meta 含幣別清單', Array.isArray(meta.currencies) && meta.currencies.includes('USD'));
  ok('meta 本位幣 = TWD', meta.base === 'TWD', meta.base);
  const fx = await post('/params/rates', { currency: 'USD', rate: 32.1, effective_date: '2026-09-01' });
  ok('新增匯率歷程', fx && fx.rate === 32.1);
  const rates = await get('/params/rates?currency=USD');
  ok('可查詢匯率歷程', Array.isArray(rates) && rates.length > 0);
  await del('/params/rates/' + fx.id);
  ok('可刪除匯率歷程', true);
  await put('/params', { values: { tax_rate: '0.05' } });
  ok('可批次更新參數', true);

  /* ---------- 11. 操作日誌 ---------- */
  console.log('\n[11] 操作日誌');
  const logs = await get('/params/audit-logs?limit=50');
  ok('操作日誌可查詢', Array.isArray(logs) && logs.length > 0);
  ok('日誌含工號欄位', logs.some((l) => l.emp_id));

  /* ---------- 12. PDF 單據 ---------- */
  console.log('\n[12] PDF 單據（pdfkit + 中文內嵌）');
  const pdfChecks = [
    { name: '訂單確認單 PDF', url: `/pdf/orders/${order.id}` },
    { name: '出貨單 PDF（無出貨 → 404）', url: `/pdf/shipments/999999`, expect: 404 },
    { name: '對帳單 PDF', url: `/pdf/customers/${cust.id}/statement?month=2026-09` },
    { name: '應收彙總表 PDF', url: `/pdf/receivables/summary?month=2026-09` },
  ];
  for (const c of pdfChecks) {
    try {
      const res = await getRaw(c.url);
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get('content-type') || '';
      const magic = buf.slice(0, 4).toString();
      const isPdf = magic === '%PDF';
      const okCode = res.status === (c.expect || 200);
      const sizeOk = !c.expect && buf.length > 5000;
      const finalOk = c.expect
        ? (!isPdf && okCode)               // 404 預期：不是 PDF、code 對
        : (isPdf && okCode && sizeOk);     // 200 預期：是 PDF、code 對、size > 5000
      ok(`${c.name} → ${isPdf ? 'PDF' : 'JSON'} ${buf.length}B code=${res.status}`, finalOk);
    } catch (e) { ok(`${c.name} 例外`, false); }
  }

  /* ---------- 13. Email 寄送（ethereal 測試） ---------- */
  console.log('\n[13] Email 寄送');
  const mailPreview = await get('/email/preview');
  ok('preview 取得 ethereal 帳號', mailPreview && mailPreview.mode === 'ethereal' && mailPreview.user);
  const mailRes = await post('/email/send-order', { orderId: order.id, to: 'buyer@test.local', subject: 'smoke 訂單' });
  ok('send-order 寄送成功', mailRes && mailRes.ok && mailRes.previewUrl);
  const batchRes = await post('/email/send-batch', { items: [{ type: 'order', id: order.id }], to: 'buyer@test.local' });
  ok('send-batch 寄送成功', batchRes && batchRes.ok && batchRes.count === 1);

  /* ---------- 14. PDF 批次合併 ---------- */
  console.log('\n[14] PDF 批次合併列印');
  // 直接 fetch 拿 binary buffer（api() 只支援 JSON）
  const batchHttpRes = await fetch(BASE + '/api/pdf/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN, 'X-MJ-Probe': '1' },
    body: JSON.stringify({ type: 'orders', ids: [order.id] }),
  });
  const batchBuf = Buffer.from(await batchHttpRes.arrayBuffer());
  const isBatchPdf = batchHttpRes.status === 200 && batchBuf.slice(0, 5).toString('ascii') === '%PDF-' && batchBuf.length > 5000;
  ok(`batch PDF → ${batchBuf.length}B code=${batchHttpRes.status}`, isBatchPdf);

  /* ---------- 15. 台灣銀行匯率（每日擷取） ---------- */
  console.log('\n[15] 台灣銀行匯率');
  const fxStatus0 = await get('/params/fx/status');
  ok('fx 設定含保留天數', fxStatus0 && fxStatus0.config && fxStatus0.config.retentionDays === 60);
  ok('fx 設定幣別含 USD/CNY', fxStatus0 && Array.isArray(fxStatus0.config.currencies) && fxStatus0.config.currencies.includes('USD') && fxStatus0.config.currencies.includes('CNY'));
  const fxRefresh = await post('/params/fx/refresh', { force: true });
  ok(`fx 抓取成功（${fxRefresh && fxRefresh.count} 筆）`, fxRefresh && fxRefresh.ok && fxRefresh.count >= 1);
  const fxList = await get('/params/fx');
  const fxUsd = (fxList || []).find((r) => r.currency === 'USD');
  const fxCny = (fxList || []).find((r) => r.currency === 'CNY');
  ok('fx 列表含 USD', !!fxUsd);
  ok('fx 列表含 CNY', !!fxCny);
  ok('USD 即期買入>0', !!fxUsd && fxUsd.spot_buy > 0);
  ok('CNY 即期賣出>0', !!fxCny && fxCny.spot_sell > 0);
  const fxStatus1 = await get('/params/fx/status');
  ok('fx 統計含今天', fxStatus1 && fxStatus1.lastDate && fxStatus1.totalDays >= 1);

  /* ---------- 16. 批次結帳（會計月結） ---------- */
  console.log('\n[16] 批次結帳（會計月結）');
  // 先刪掉 [6] 產生的應收，留乾淨給 batch-generate 測
  const arList0 = await get('/receivables');
  const origAr = (arList0 || []).find((r) => r.order_id === order.id);
  if (origAr) {
    await del('/receivables/' + origAr.id).catch(() => {});
  }
  // dryRun 預覽
  const dry = await post('/receivables/batch-generate', {
    fromMonth: '2026-01',
    toMonth: '2026-12',
    statuses: ['shipped', 'billed'],
    dryRun: true,
  });
  ok('批次結帳 dryRun 回傳 ok', dry && dry.ok === true);
  ok(`批次結帳 dryRun 掃描 ≥1 筆`, dry && dry.scanned >= 1, dry && dry.scanned);
  ok(`批次結帳 dryRun 預計生成 ≥1 筆`, dry && dry.generated >= 1, dry && dry.generated);
  ok('批次結帳 dryRun 含 by_month 統計', dry && dry.by_month && Object.keys(dry.by_month).length >= 1);

  // 真正執行
  const real = await post('/receivables/batch-generate', {
    fromMonth: '2026-01',
    toMonth: '2026-12',
    statuses: ['shipped', 'billed'],
    dryRun: false,
  });
  ok('批次結帳執行 ok', real && real.ok === true);
  ok('批次結帳 generated ≥1', real && real.generated >= 1, real && real.generated);
  ok('批次結帳 errors = 0', real && real.errors === 0, real && real.errors);
  ok('批次結帳總金額 > 0', real && real.total_amount_base > 0, real && real.total_amount_base);
  ok('批次結帳回傳 items 清單', real && Array.isArray(real.items) && real.items.length >= 1);

  // 二次跑（不 force）應全部 skip（冪等）
  const replay = await post('/receivables/batch-generate', {
    fromMonth: '2026-01',
    toMonth: '2026-12',
    statuses: ['shipped', 'billed'],
    dryRun: false,
  });
  ok('冪等：二次 batch-generated = 0', replay && replay.generated === 0, replay && replay.generated);
  ok('冪等：二次 batch-skipped ≥1', replay && replay.skipped >= 1, replay && replay.skipped);

  // force=true 應走 rebuild 路徑
  const forceRun = await post('/receivables/batch-generate', {
    fromMonth: '2026-01',
    toMonth: '2026-12',
    statuses: ['shipped', 'billed'],
    dryRun: false,
    force: true,
  });
  ok('force 重建：generated ≥1', forceRun && forceRun.generated >= 1, forceRun && forceRun.generated);

  /* ---------- 17. 登出 ---------- */
  console.log('\n[17] 登出');
  await post('/auth/logout');
  let afterLogout = null;
  try { await get('/customers'); } catch (e) { afterLogout = e; }
  ok('登出後 token 失效（401）', afterLogout && afterLogout.status === 401);

  /* ---------- 清理 ---------- */
  TOKEN = (await post('/auth/login', { empId: 'admin', password: ADMIN_PASSWORD }, { noAuth: true })).token;
  await del('/orders/' + order.id).catch(() => {});
  await del(`/users/${sales.id}`).catch(() => {});
  await del(`/products/${prod.id}`).catch(() => {});
  await del(`/customers/${cust.id}`).catch(() => {});
  await del(`/suppliers/${sup.id}`).catch(() => {});

  console.log(`\n=== 結果：${pass} 通過 / ${fail} 失敗 ===`);
  if (fail) { console.log('\n失敗項目：'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
}

main().catch((e) => { console.error('\n💥 Smoke 測試中斷：', e); process.exit(1); });
