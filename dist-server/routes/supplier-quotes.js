'use strict';
/**
 * 供應商報價單（Supplier Quotation，供應鏈）
 * 主檔 + 明細；金額由 calc 引擎重算（amount=qty*unit_price，tax=amount*tax_rate，total=amount+tax）。
 * 列表欄位：報價單號／報價日期／有效日期／供應商名稱／報價內容／備註。
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
  const lines = (items || []).map((it) => {
    const name = [it.part_no, it.description].filter(Boolean).join(' ');
    return name ? `${name} x${num(it.qty, 0)}` : '';
  }).filter(Boolean);
  return lines.slice(0, 3).join('；') + (lines.length > 3 ? ` 等${lines.length}項` : '');
}

const SELECT = `SELECT q.*, s.name AS supplier_name, s.code AS supplier_code, s.email AS supplier_email
                FROM supplier_quotes q
                LEFT JOIN suppliers s ON s.id = q.supplier_id`;

async function getItems(executor, qid) {
  return await executor.prepare('SELECT * FROM supplier_quote_items WHERE quote_id=? ORDER BY sort_order, id').all(qid);
}

async function withItems(q, executor = db) {
  const items = await getItems(executor, q.id);
  // 幣別取自供應商主檔：台幣取整數元、外幣到分
  const sup = await executor.prepare('SELECT currency FROM suppliers WHERE id=?').get(q.supplier_id);
  const dec = decimalsFor((sup && sup.currency) || 'TWD');
  const subtotal = round(items.reduce((s, it) => s + num(it.amount), 0), dec);
  const tax = round(items.reduce((s, it) => s + num(it.tax_amount), 0), dec);
  const total = round(items.reduce((s, it) => s + num(it.total), 0), dec);
  return Object.assign({}, q, { items, totals: { subtotal, tax, total } });
}

async function saveItems(executor, qid, items, taxRateDefault, currency = 'TWD') {
  await executor.prepare('DELETE FROM supplier_quote_items WHERE quote_id=?').run(qid);
  const sql =
    `INSERT INTO supplier_quote_items (quote_id, product_id, part_no, description, qty, unit, unit_price,
        amount, tax_rate, tax_amount, total, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  let i = 0;
  const dec = decimalsFor(currency); // 台幣整數元、外幣到分
  for (const raw of items || []) {
    const qty = num(raw.qty, 0);
    const unitPrice = num(raw.unit_price, 0);
    const taxRate = raw.tax_rate === undefined || raw.tax_rate === null ? taxRateDefault : num(raw.tax_rate, 0);
    const amount = round(qty * unitPrice, dec);
    const taxAmount = round(amount * taxRate, dec);
    await executor.prepare(sql).run(
      qid,
      raw.product_id ? Number(raw.product_id) : null,
      str(raw.part_no),
      str(raw.description),
      qty,
      str(raw.unit, 'PCS') || 'PCS',
      unitPrice,
      amount,
      taxRate,
      taxAmount,
      round(amount + taxAmount, dec),
      i++
    );
  }
}

/** GET / 列表（可篩選） */
router.get('/', async (req, res, next) => {
 try {
  const q = req.query || {};
  const cond = [];
  const args = [];
  if (q.keyword) {
    cond.push('(q.quote_no LIKE ? OR q.note LIKE ? OR s.name LIKE ? OR q.id IN (SELECT quote_id FROM supplier_quote_items WHERE part_no LIKE ? OR description LIKE ?))');
    args.push(...Array(5).fill(`%${q.keyword}%`));
  }
  if (q.supplier_id) { cond.push('q.supplier_id = ?'); args.push(Number(q.supplier_id)); }
  if (q.status) { cond.push('q.status = ?'); args.push(str(q.status)); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = await db.prepare(`${SELECT} ${where} ORDER BY q.quote_date DESC, q.id DESC`).all(...args);
  res.json(await Promise.all(rows.map(async (row) => Object.assign({}, row, { content: contentSummary(await getItems(db, row.id)) }))));
 } catch (e) { next(e); }
});

/** GET /:id 單筆含明細 */
router.get('/:id', async (req, res, next) => { try {
  const id = Number(req.params.id);
  const q = await db.prepare(`${SELECT} WHERE q.id=?`).get(id);
  if (!q) return res.status(404).json({ error: '供應商報價單不存在' });
  res.json(await withItems(q));
 } catch(e) { next(e); }
});

/** POST / 新增 */
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const supplierId = b.supplier_id ? Number(b.supplier_id) : null;
    if (!supplierId) return res.status(400).json({ error: '請選擇供應商' });
    const sup = await db.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId);
    if (!sup) return res.status(404).json({ error: '供應商不存在' });

    let quoteNo = str(b.quote_no);
    if (!quoteNo && db.raw.getActive() === 'primary') quoteNo = undefined;
    if (quoteNo && await db.prepare('SELECT id FROM supplier_quotes WHERE quote_no=?').get(quoteNo)) {
      return res.status(400).json({ error: `報價單編號 ${quoteNo} 已存在` });
    }

    const qdate = str(b.quote_date) || toDateStr(new Date());
    const taxRate = num(b.tax_rate, 0.05);
    const id = await db.transaction(async (tx) => {
      if (!quoteNo) quoteNo = await nextSerial(tx, 'supplier_quote_no_prefix', 'supplier_quote_no_seq', 'SPQ');
      if (await tx.prepare('SELECT id FROM supplier_quotes WHERE quote_no=?').get(quoteNo)) throw Object.assign(new Error(`報價單編號 ${quoteNo} 已存在`), { status: 400 });
      const info = await tx.prepare(
        `INSERT INTO supplier_quotes (quote_no, quote_date, valid_until, supplier_id, tax_rate, status, note, created_by)
       VALUES (?,?,?,?,?,?,?,?)`
      ).run(
        quoteNo, qdate, str(b.valid_until), supplierId, taxRate,
        str(b.status, 'draft'), str(b.note), req.user.id
      );
      await saveItems(tx, info.lastInsertRowid, b.items || [], taxRate, (sup && sup.currency) || 'TWD');
      return info.lastInsertRowid;
    })();
    audit.log(req, 'supplier_quote_create', `建立供應商報價單 ${quoteNo}`);
    res.status(201).json(await withItems(await db.prepare(`${SELECT} WHERE q.id=?`).get(id)));
  } catch (e) { next(e); }
});

/** PUT /:id 更新（含明細重寫） */
router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = await db.prepare('SELECT * FROM supplier_quotes WHERE id=?').get(id);
    if (!cur) return res.status(404).json({ error: '供應商報價單不存在' });
    const b = req.body || {};
    const supplierId = b.supplier_id ? Number(b.supplier_id) : cur.supplier_id;
    if (!supplierId) return res.status(400).json({ error: '請選擇供應商' });

    const quoteNo = str(b.quote_no) || cur.quote_no;
    const dup = await db.prepare('SELECT id FROM supplier_quotes WHERE quote_no=? AND id<>?').get(quoteNo, id);
    if (dup) return res.status(400).json({ error: `報價單編號 ${quoteNo} 已存在` });

    const taxRate = num(b.tax_rate, cur.tax_rate ?? 0.05);
    const supCur = await db.prepare('SELECT currency FROM suppliers WHERE id=?').get(supplierId);
    const currency = (supCur && supCur.currency) || 'TWD';
    await db.transaction(async (tx) => {
      await tx.prepare(
        `UPDATE supplier_quotes SET quote_no=?, quote_date=?, valid_until=?, supplier_id=?,
          tax_rate=?, status=?, note=?, updated_at=datetime('now','localtime')
       WHERE id=?`
      ).run(
        quoteNo, str(b.quote_date) || cur.quote_date, str(b.valid_until), supplierId, taxRate,
        str(b.status, cur.status), b.note === undefined ? cur.note : str(b.note), id
      );
      if (b.items) await saveItems(tx, id, b.items, taxRate, currency);
    })();
    audit.log(req, 'supplier_quote_update', `更新供應商報價單 ${quoteNo}`);
    res.json(await withItems(await db.prepare(`${SELECT} WHERE q.id=?`).get(id)));
  } catch (e) { next(e); }
});

/** DELETE /:id 刪除 */
router.delete('/:id', requireManager, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = await db.prepare('SELECT * FROM supplier_quotes WHERE id=?').get(id);
    if (!cur) return res.status(404).json({ error: '供應商報價單不存在' });
    await db.transaction(async (tx) => {
      await tx.prepare('DELETE FROM supplier_quote_items WHERE quote_id=?').run(id);
      await tx.prepare('DELETE FROM supplier_quotes WHERE id=?').run(id);
    })();
    audit.log(req, 'supplier_quote_delete', `刪除供應商報價單 ${cur.quote_no}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
