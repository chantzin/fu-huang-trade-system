'use strict';
/**
 * 供應商訂單（採購單，Supplier Order，供應鏈）
 * 主檔 + 明細；金額重算（amount=qty*unit_price，tax=amount*tax_rate，total=amount+tax）。
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireManager } = require('../lib/auth');
const audit = require('../lib/audit');
const { num, str, toDateStr, round, decimalsFor } = require('../lib/util');
const { nextSerial } = require('../lib/serial-dual');

const router = express.Router();
router.use(requireAuth);

function contentSummary(items) {
  const lines = (items || []).map((it) => [it.part_no, it.description].filter(Boolean).join(' ') + ` x${num(it.qty, 0)}`);
  return lines.slice(0, 3).join('；') + (lines.length > 3 ? ` 等${lines.length}項` : '');
}

const SELECT = `SELECT o.*, s.name AS supplier_name, s.code AS supplier_code, s.email AS supplier_email
                FROM supplier_orders o
                LEFT JOIN suppliers s ON s.id = o.supplier_id`;

async function getItems(executor, oid) {
  return await executor.prepare('SELECT * FROM supplier_order_items WHERE order_id=? ORDER BY sort_order, id').all(oid);
}

async function withItems(o, executor = db) {
  const items = await getItems(executor, o.id);
  const subtotal = items.reduce((s, it) => s + num(it.amount), 0);
  const tax = items.reduce((s, it) => s + num(it.tax_amount), 0);
  const total = items.reduce((s, it) => s + num(it.total), 0);
  return Object.assign({}, o, { items, totals: { subtotal, tax, total } });
}

async function saveItems(executor, oid, items, taxRateDefault, rate = 1, currency) {
  await executor.prepare('DELETE FROM supplier_order_items WHERE order_id=?').run(oid);
  const sql =
    `INSERT INTO supplier_order_items (order_id, product_id, part_no, description, qty, unit, unit_price,
        amount, unit_price_base, total_base, tax_rate, tax_amount, total, note, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  let i = 0;
  for (const raw of items || []) {
    const qty = num(raw.qty, 0);
    const unitPrice = num(raw.unit_price, 0);
    const taxRate = raw.tax_rate === undefined || raw.tax_rate === null ? taxRateDefault : num(raw.tax_rate, 0);
    // 原幣：台幣取整數元、外幣到分；本位幣（台幣）一律整數元
    const dec = decimalsFor(currency);
    const baseDec = decimalsFor('TWD');
    const amount = round(qty * unitPrice, dec);
    const taxAmount = round(amount * taxRate, dec);
    const unitPriceBase = round(unitPrice * rate, baseDec);
    const totalBase = round((amount + taxAmount) * rate, baseDec);
    await executor.prepare(sql).run(
      oid,
      raw.product_id ? Number(raw.product_id) : null,
      str(raw.part_no),
      str(raw.description),
      qty,
      str(raw.unit, 'PCS') || 'PCS',
      unitPrice,
      amount,
      unitPriceBase,
      totalBase,
      taxRate,
      taxAmount,
      round(amount + taxAmount, dec),
      str(raw.note) || null,
      i++
    );
  }
}

/** GET / 列表（可篩選） */
router.get('/', async (req, res, next) => { try {
  const q = req.query || {};
  const cond = [];
  const args = [];
  if (q.keyword) {
    cond.push('(o.order_no LIKE ? OR o.note LIKE ? OR s.name LIKE ? OR o.id IN (SELECT order_id FROM supplier_order_items WHERE part_no LIKE ? OR description LIKE ?))');
    args.push(...Array(5).fill(`%${q.keyword}%`));
  }
  if (q.supplier_id) { cond.push('o.supplier_id = ?'); args.push(Number(q.supplier_id)); }
  if (q.status) { cond.push('o.status = ?'); args.push(str(q.status)); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = await db.prepare(`${SELECT} ${where} ORDER BY o.order_date DESC, o.id DESC`).all(...args);
  res.json(await Promise.all(rows.map(async (row) => {
    const items = await getItems(db, row.id);
    return Object.assign({}, row, { content: contentSummary(items), items });
  })));
 } catch(e) { next(e); }
});

/** GET /:id 單筆含明細 */
router.get('/:id', async (req, res, next) => { try {
  const id = Number(req.params.id);
  const o = await db.prepare(`${SELECT} WHERE o.id=?`).get(id);
  if (!o) return res.status(404).json({ error: '供應商訂單不存在' });
  res.json(await withItems(o));
 } catch(e) { next(e); }
});

/** POST / 新增 */
router.post('/from-quote/:quoteId', async (req, res, next) => {
  try {
    const quoteId = Number(req.params.quoteId);
    const quote = await db.prepare('SELECT * FROM supplier_quotes WHERE id=?').get(quoteId);
    if (!quote) return res.status(404).json({ error: '供應商報價不存在' });
    if (quote.status !== 'quoted' || (quote.valid_until && quote.valid_until < toDateStr(new Date()))) return res.status(409).json({ error: '僅可由有效且已報價的報價單轉採購單' });
    const existing = await db.prepare('SELECT id FROM supplier_orders WHERE source_quote_id=?').get(quoteId);
    if (existing) return res.status(409).json({ error: `此報價已轉成採購單 ${existing.id}` });
    const items = await db.prepare('SELECT * FROM supplier_quote_items WHERE quote_id=? ORDER BY sort_order,id').all(quoteId);
    if (!items.length) return res.status(409).json({ error: '報價單沒有明細，無法轉單' });
    let orderNo;
    const id = await db.transaction(async (tx) => {
      orderNo = await nextSerial(tx, 'supplier_order_no_prefix', 'supplier_order_no_seq', 'SPO');
      const created = (await tx.prepare(`INSERT INTO supplier_orders (order_no,order_date,supplier_id,tax_rate,currency,exchange_rate,status,note,created_by,source_quote_id)
        VALUES (?,?,?,?,? ,1,'draft',?,?,?)`).run(orderNo,toDateStr(new Date()),quote.supplier_id,quote.tax_rate||0.05,'TWD',`由報價 ${quote.quote_no} 轉入`,req.user.id,quoteId)).lastInsertRowid;
      await saveItems(tx, created, items, quote.tax_rate||0.05, 1, 'TWD');
      return created;
    })();
    audit.log(req, 'supplier_quote_convert', `報價 ${quote.quote_no} 轉採購 ${orderNo}`);
    res.status(201).json(await withItems(await db.prepare(`${SELECT} WHERE o.id=?`).get(id)));
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const supplierId = b.supplier_id ? Number(b.supplier_id) : null;
    if (!supplierId) return res.status(400).json({ error: '請選擇供應商' });
    const sup = await db.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId);
    if (!sup) return res.status(404).json({ error: '供應商不存在' });

    let orderNo = str(b.order_no);
    if (orderNo && await db.prepare('SELECT id FROM supplier_orders WHERE order_no=?').get(orderNo)) {
      return res.status(400).json({ error: `採購單編號 ${orderNo} 已存在` });
    }

    const odate = str(b.order_date) || toDateStr(new Date());
    const taxRate = num(b.tax_rate, 0.05);
    const currency = str(b.currency, 'TWD') || 'TWD';
    const rate = num(b.exchange_rate, 0) > 0 ? num(b.exchange_rate) : 1;
    const id = await db.transaction(async (tx) => {
      if (!orderNo) orderNo = await nextSerial(tx, 'supplier_order_no_prefix', 'supplier_order_no_seq', 'SPO');
      if (await tx.prepare('SELECT id FROM supplier_orders WHERE order_no=?').get(orderNo)) throw Object.assign(new Error(`採購單編號 ${orderNo} 已存在`), { status: 400 });
      const info = await tx.prepare(
        `INSERT INTO supplier_orders (order_no, order_date, due_date, supplier_id, tax_rate, currency, exchange_rate, status, note, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(
        orderNo, odate, str(b.due_date), supplierId, taxRate, currency, rate,
        str(b.status, 'draft'), str(b.note), req.user.id
      );
      await saveItems(tx, info.lastInsertRowid, b.items || [], taxRate, rate, currency);
      return info.lastInsertRowid;
    })();
    audit.log(req, 'supplier_order_create', `建立供應商訂單 ${orderNo}`);
    res.status(201).json(await withItems(await db.prepare(`${SELECT} WHERE o.id=?`).get(id)));
  } catch (e) { next(e); }
});

/** PUT /:id 更新（含明細重寫） */
router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = await db.prepare('SELECT * FROM supplier_orders WHERE id=?').get(id);
    if (!cur) return res.status(404).json({ error: '供應商訂單不存在' });
    const b = req.body || {};
    const supplierId = b.supplier_id ? Number(b.supplier_id) : cur.supplier_id;
    if (!supplierId) return res.status(400).json({ error: '請選擇供應商' });

    const orderNo = str(b.order_no) || cur.order_no;
    const dup = await db.prepare('SELECT id FROM supplier_orders WHERE order_no=? AND id<>?').get(orderNo, id);
    if (dup) return res.status(400).json({ error: `採購單編號 ${orderNo} 已存在` });

    const taxRate = num(b.tax_rate, cur.tax_rate ?? 0.05);
    const currency = b.currency !== undefined ? str(b.currency, 'TWD') || 'TWD' : cur.currency;
    const rate = num(b.exchange_rate, 0) > 0 ? num(b.exchange_rate) : (cur.exchange_rate || 1);
    await db.transaction(async (tx) => {
      await tx.prepare(
        `UPDATE supplier_orders SET order_no=?, order_date=?, due_date=?, supplier_id=?,
          tax_rate=?, currency=?, exchange_rate=?, status=?, note=?, updated_at=datetime('now','localtime')
       WHERE id=?`
      ).run(
        orderNo, str(b.order_date) || cur.order_date, str(b.due_date), supplierId, taxRate,
        currency, rate,
        str(b.status, cur.status), b.note === undefined ? cur.note : str(b.note), id
      );
      if (b.items) await saveItems(tx, id, b.items, taxRate, rate, currency);
    })();
    audit.log(req, 'supplier_order_update', `更新供應商訂單 ${orderNo}`);
    res.json(await withItems(await db.prepare(`${SELECT} WHERE o.id=?`).get(id)));
  } catch (e) { next(e); }
});

/** DELETE /:id 刪除 */
router.delete('/:id', requireManager, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = await db.prepare('SELECT * FROM supplier_orders WHERE id=?').get(id);
    if (!cur) return res.status(404).json({ error: '供應商訂單不存在' });
    await db.transaction(async (tx) => {
      await tx.prepare('DELETE FROM supplier_order_items WHERE order_id=?').run(id);
      await tx.prepare('DELETE FROM supplier_orders WHERE id=?').run(id);
    })();
    audit.log(req, 'supplier_order_delete', `刪除供應商訂單 ${cur.order_no}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
