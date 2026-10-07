'use strict';
/**
 * 訂單管理（核心模組）
 * 一張訂單主檔 + 多筆料號明細；所有金額由計算引擎自動重算，不接受人工帶入的衍生值。
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireManager } = require('../lib/auth');
const audit = require('../lib/audit');
const { num, str, toMonthStr, toDateStr } = require('../lib/util');
const { nextSerial } = require('../lib/serial-dual');
const { calcItem, calcOrderTotals, deriveAR, orderTermsBasis } = require('../lib/calc');
const { cfg } = require('../lib/config');

const router = express.Router();
router.use(requireAuth);

const SELECT = `SELECT o.*, c.name AS customer_name, c.customer_no, c.payment_terms AS cust_terms,
                       c.terms_days AS cust_terms_days, c.tax_rate AS cust_tax_rate, c.currency AS cust_currency,
                       u.name AS sales_name, u.emp_id AS sales_emp_id, s.name AS supplier_name
                  FROM orders o
                  LEFT JOIN customers c ON c.id = o.customer_id
                  LEFT JOIN users u ON u.id = o.sales_id
                  LEFT JOIN suppliers s ON s.id = o.supplier_id`;

/** 業務只看自己的單；其餘角色看全部 */
function scopeWhere(req) {
  if (req.user.role === 'sales') return { sql: 'WHERE (o.sales_id = ? OR o.created_by = ?)', args: [req.user.id, req.user.id] };
  return { sql: '', args: [] };
}

async function getItems(orderId, executor = db) {
  return await executor.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY sort_order, id').all(orderId);
}

async function withTotals(o, executor = db) {
  const items = await getItems(o.id, executor);
  const totals = calcOrderTotals(items);
  return Object.assign({}, o, { items, totals });
}

/** 寫入明細（先清再寫，全部走計算引擎重算） */
async function saveItems(executor, orderId, items, ctx) {
  await executor.prepare('DELETE FROM order_items WHERE order_id=?').run(orderId);
  const stmt = executor.prepare(
    `INSERT INTO order_items (order_id, product_id, part_no, qty, unit, unit_price, amount, tax_rate, tax_amount,
        total, total_base, cost_unit, other_fee, cost_total, freight_cn, freight_tw, freight_pct, profit, margin, note, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let i = 0;
  for (const raw of items || []) {
    const c = calcItem(raw, ctx);
    await stmt.run(
      orderId,
      raw.product_id ? Number(raw.product_id) : null,
      str(raw.part_no),
      c.qty,
      str(raw.unit, 'PCS') || 'PCS',
      c.unit_price,
      c.amount,
      c.tax_rate,
      c.tax_amount,
      c.total,
      c.total_base,
      c.cost_unit,
      c.other_fee,
      c.cost_total,
      c.freight_cn,
      c.freight_tw,
      c.freight_pct,
      c.profit,
      c.margin,
      str(raw.note),
      i++
    );
  }
}

async function getParamValue(key, def = null, executor = db) {
  const r = await executor.prepare('SELECT value FROM parameters WHERE `key`=?').get(key);
  return r ? r.value : def;
}

async function getOrderRate(currency, dateStr, executor = db) {
  const cur = String(currency || 'TWD').toUpperCase();
  if (cur === 'TWD') return 1;
  const d = dateStr || toDateStr(new Date());
  const row = await executor.prepare('SELECT rate FROM exchange_rates WHERE currency=? AND effective_date<=? ORDER BY effective_date DESC, id DESC LIMIT 1').get(cur, d);
  if (row && Number(row.rate) > 0) return Number(row.rate);
  const fallback = cfg.currency && cfg.currency.rates ? cfg.currency.rates[cur] : null;
  return fallback && Number(fallback) > 0 ? Number(fallback) : 1;
}

router.get('/', async (req, res, next) => { try {
  const q = req.query || {};
  const cond = [];
  const args = [];
  const sc = scopeWhere(req);
  if (sc.sql) cond.push(sc.sql.replace(/^WHERE /, ''));
  if (sc.args.length) args.push(...sc.args);

  if (q.keyword) {
    cond.push('(o.order_no LIKE ? OR o.note LIKE ? OR c.name LIKE ? OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.part_no LIKE ?))');
    args.push(...Array(4).fill(`%${q.keyword}%`));
  }
  if (q.customer_id) { cond.push('o.customer_id = ?'); args.push(Number(q.customer_id)); }
  if (q.sales_id) { cond.push('o.sales_id = ?'); args.push(Number(q.sales_id)); }
  if (q.status) { cond.push('o.status = ?'); args.push(q.status); }
  if (q.month) { cond.push('o.month = ?'); args.push(q.month); }
  if (q.date_from) { cond.push('o.order_date >= ?'); args.push(q.date_from); }
  if (q.date_to) { cond.push('o.order_date <= ?'); args.push(q.date_to); }
  if (q.unshipped === '1') { cond.push("o.status IN ('draft','confirmed')"); }

  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const list = await db.prepare(`${SELECT} ${where} ORDER BY o.order_date DESC, o.id DESC LIMIT 500`).all(...args);
  const showItems = q.with_items === '1';
  res.json(await Promise.all(list.map((o) => (showItems ? withTotals(o) : Object.assign({}, o, { items: undefined })))));
 } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => { try {
  const o = await db.prepare(`${SELECT} WHERE o.id=?`).get(Number(req.params.id));
  if (!o) return res.status(404).json({ error: '訂單不存在' });
  if (req.user.role === 'sales' && o.sales_id !== req.user.id && o.created_by !== req.user.id) {
    return res.status(403).json({ error: '無權檢視他人訂單' });
  }
  res.json(await withTotals(o));
 } catch (e) { next(e); }
});

/** 建立訂單 */
router.post('/', async (req, res, next) => {
  const b = req.body || {};
  const customerId = b.customer_id ? Number(b.customer_id) : null;
  if (!customerId) return res.status(400).json({ error: '請選擇客戶' });
  const cust = await db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
  if (!cust) return res.status(404).json({ error: '客戶不存在' });

  const orderDate = str(b.order_date) || toDateStr(new Date());
  const currency = str(b.currency) || cust.currency || 'TWD';
  const rate = num(b.exchange_rate, 0) > 0 ? num(b.exchange_rate) : await getOrderRate(currency, orderDate);
  const termsText = str(b.payment_terms) || cust.payment_terms || '月結60天';
  // 【2026-09-10 健檢 N4 修正】原寫法 `num(b.terms_days,0) > 0 ? ... : (cust.terms_days || 60)`
  //   對「現金款／預付款」客戶（terms_days=0）會因 0 被判為 falsy 而 fallback 成 60 天，
  //   導致到期日整整多算 60 天。改為明確區分「有沒有給值」，0 就是 0。
  const hasDays = b.terms_days !== undefined && b.terms_days !== null && String(b.terms_days).trim() !== '';
  const termsDays = hasDays
    ? num(b.terms_days, 0)
    : (cust.terms_days !== undefined && cust.terms_days !== null ? num(cust.terms_days, 0) : 60);
  const taxRate = num(b.tax_rate, num(cust.tax_rate, num(await getParamValue('tax_rate', 0.05))));
  const salesId = req.user.role === 'sales' ? req.user.id : (b.sales_id ? Number(b.sales_id) : req.user.id);

  let orderNo = str(b.order_no);
  if (orderNo && await db.prepare('SELECT id FROM orders WHERE order_no=?').get(orderNo)) {
    return res.status(400).json({ error: `訂單編號 ${orderNo} 已存在` });
  }

  const items = (b.items || []).map((it) => Object.assign({}, it, {
    tax_rate: it.tax_rate === undefined || it.tax_rate === null ? taxRate : it.tax_rate,
  }));

  let newId;
  try {
    const tx = db.transaction(async (executor) => {
      if (!orderNo) orderNo = await nextSerial(executor, 'order_no_prefix', 'order_no_seq', 'SO');
      if (await executor.prepare('SELECT id FROM orders WHERE order_no=?').get(orderNo)) throw Object.assign(new Error(`訂單編號 ${orderNo} 已存在`), { status: 400 });
      const info = await executor.prepare(
        `INSERT INTO orders (order_no, order_date, month, customer_id, sales_id, supplier_id, currency, exchange_rate,
            payment_terms, terms_days, factory_eta, customer_eta, ship_date, customer_po_no, status, note, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        orderNo, orderDate, toMonthStr(orderDate), customerId, salesId,
        b.supplier_id ? Number(b.supplier_id) : null,
        currency, rate, termsText, termsDays,
        str(b.factory_eta) || null, str(b.customer_eta) || null, str(b.ship_date) || null,
        str(b.customer_po_no) || null,
        b.status || 'draft', str(b.note), req.user.id
      );
      newId = info.lastInsertRowid;
      await saveItems(executor, newId, items, { exchange_rate: rate, currency, order_date: orderDate });
      return newId;
    });
    newId = await tx();
    audit.log(req, 'create', 'orders', newId, orderNo);
    res.json(await withTotals(await db.prepare(`${SELECT} WHERE o.id=?`).get(newId)));
  } catch (e) { next(e); }
});

/** 修改訂單（含明細整批覆寫後重算） */
router.put('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '訂單不存在' });
  if (req.user.role === 'sales' && cur.sales_id !== req.user.id && cur.created_by !== req.user.id) {
    return res.status(403).json({ error: '無權修改他人訂單' });
  }
  const b = req.body || {};
  const orderDate = b.order_date !== undefined ? str(b.order_date) : cur.order_date;
  const currency = b.currency !== undefined ? str(b.currency) : cur.currency;
  const rate = num(b.exchange_rate, 0) > 0 ? num(b.exchange_rate) : await getOrderRate(currency, orderDate);
  const items = b.items
    ? b.items.map((it) => Object.assign({}, it, {
        tax_rate: it.tax_rate === undefined || it.tax_rate === null ? cur.tax_rate : it.tax_rate,
      }))
    : null;

  try {
    const tx = db.transaction(async (executor) => {
      await executor.prepare(
        `UPDATE orders SET order_date=?, month=?, customer_id=?, sales_id=?, supplier_id=?, currency=?, exchange_rate=?,
            payment_terms=?, terms_days=?, factory_eta=?, customer_eta=?, ship_date=?, customer_po_no=?, status=?, note=?,
            updated_at=datetime('now','localtime') WHERE id=?`
      ).run(
        orderDate,
        toMonthStr(orderDate),
        b.customer_id !== undefined ? (b.customer_id ? Number(b.customer_id) : null) : cur.customer_id,
        b.sales_id !== undefined ? (b.sales_id ? Number(b.sales_id) : null) : cur.sales_id,
        b.supplier_id !== undefined ? (b.supplier_id ? Number(b.supplier_id) : null) : cur.supplier_id,
        currency,
        rate,
        b.payment_terms !== undefined ? str(b.payment_terms) : cur.payment_terms,
        b.terms_days !== undefined ? num(b.terms_days, 60) : cur.terms_days,
        b.factory_eta !== undefined ? str(b.factory_eta) || null : cur.factory_eta,
        b.customer_eta !== undefined ? str(b.customer_eta) || null : cur.customer_eta,
        b.ship_date !== undefined ? str(b.ship_date) || null : cur.ship_date,
        b.customer_po_no !== undefined ? str(b.customer_po_no) || null : cur.customer_po_no,
        b.status !== undefined ? b.status : cur.status,
        b.note !== undefined ? str(b.note) : cur.note,
        id
      );
      if (items) await saveItems(executor, id, items, { exchange_rate: rate, currency, order_date: orderDate });
      else {
        // 沒有帶明細但匯率/幣別變了 → 也要重算
        const exist = await getItems(id, executor);
        if (exist.length) await saveItems(executor, id, exist, { exchange_rate: rate, currency, order_date: orderDate });
      }
    });
    await tx();
    audit.log(req, 'update', 'orders', id, cur.order_no);
    res.json(await withTotals(await db.prepare(`${SELECT} WHERE o.id=?`).get(id)));
  } catch (e) { next(e); }
});

/** 變更狀態 */
router.post('/:id/status', async (req, res, next) => { try {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '訂單不存在' });
  const st = str(req.body && req.body.status);
  const allowed = ['draft', 'confirmed', 'shipped', 'billed', 'paid', 'closed', 'cancelled'];
  if (!allowed.includes(st)) return res.status(400).json({ error: '狀態不合法' });
  await db.prepare("UPDATE orders SET status=?, updated_at=datetime('now','localtime') WHERE id=?").run(st, id);
  audit.log(req, 'status', 'orders', id, `${cur.status} → ${st}`);
  res.json({ ok: true, status: st });
 } catch (e) { next(e); }
});

/** 重算（匯率或成本調整後用它） */
router.post('/:id/recalc', async (req, res, next) => {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '訂單不存在' });
  const rate = num((req.body || {}).exchange_rate, 0) > 0 ? num((req.body || {}).exchange_rate) : cur.exchange_rate;
  const items = await getItems(id);
  try {
    await db.transaction(async (executor) => {
      await saveItems(executor, id, items, { exchange_rate: rate, currency: cur.currency, order_date: cur.order_date });
      await executor.prepare("UPDATE orders SET exchange_rate=?, updated_at=datetime('now','localtime') WHERE id=?").run(rate, id);
    })();
    res.json(await withTotals(await db.prepare(`${SELECT} WHERE o.id=?`).get(id)));
  } catch (e) { next(e); }
});

router.delete('/:id', requireManager, async (req, res, next) => { try {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '訂單不存在' });
  await db.transaction(async (executor) => {
    await executor.prepare('DELETE FROM order_items WHERE order_id=?').run(id);
    await executor.prepare('DELETE FROM shipments WHERE order_id=?').run(id);
    await executor.prepare('DELETE FROM receivables WHERE order_id=?').run(id);
    await executor.prepare('DELETE FROM orders WHERE id=?').run(id);
  })();
  audit.log(req, 'delete', 'orders', id, cur.order_no);
  res.json({ ok: true });
 } catch (e) { next(e); }
});

/** 依出貨日預覽應收推導結果（供前端即時顯示） */
router.post('/:id/preview-ar', async (req, res, next) => { try {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '訂單不存在' });
  const base = str((req.body || {}).base_date) || cur.ship_date || cur.order_date || toDateStr(new Date());
  // 帶入客戶帳期規則的 basis：現金款／預付款才會算成「基準日當天」而非月底 + N 天
  res.json(deriveAR(base, cur.terms_days || cur.payment_terms, orderTermsBasis(cur)));
 } catch (e) { next(e); }
});

module.exports = router;
