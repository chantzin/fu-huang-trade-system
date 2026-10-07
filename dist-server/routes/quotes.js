'use strict';
/**
 * 客戶報價單（Quotation）
 * 報價單主檔 + 明細；金額由 calc 引擎重算（amount=qty*unit_price，tax=amount*tax_rate，total=amount+tax）。
 * 列表欄位：報價單號／報價日期／有效日期／客戶名稱／報價內容／備註。
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireManager } = require('../lib/auth');
const audit = require('../lib/audit');
const { num, str, toDateStr, nextSerial, round, decimalsFor } = require('../lib/util');

const router = express.Router();
router.use(requireAuth);

/** 報價內容摘要：由明細組成「料號 品名 x數量」清單（最多 3 行） */
function contentSummary(items) {
  const lines = (items || []).map((it) => {
    const name = [it.part_no, it.description].filter(Boolean).join(' ');
    return name ? `${name} x${num(it.qty, 0)}` : '';
  }).filter(Boolean);
  return lines.slice(0, 3).join('；') + (lines.length > 3 ? ` 等${lines.length}項` : '');
}

const SELECT = `SELECT q.*, c.name AS customer_name, c.customer_no, c.email AS customer_email, u.name AS sales_name,
                       (SELECT GROUP_CONCAT(part_no || ' ' || description || ' x' || qty, '；')
                          FROM quotation_items qi WHERE qi.quotation_id = q.id) AS content
                  FROM quotations q
                  LEFT JOIN customers c ON c.id = q.customer_id
                  LEFT JOIN users u ON u.id = q.sales_id`;

function getItems(qid) {
  return db.prepare('SELECT * FROM quotation_items WHERE quotation_id=? ORDER BY sort_order, id').all(qid);
}

function withItems(q) {
  const items = getItems(q.id);
  const subtotal = items.reduce((s, it) => s + num(it.amount), 0);
  const tax = items.reduce((s, it) => s + num(it.tax_amount), 0);
  const total = items.reduce((s, it) => s + num(it.total), 0);
  return Object.assign({}, q, { items, totals: { subtotal, tax, total } });
}

/** 寫入明細（先清再寫，金額全重算） */
function saveItems(qid, items, taxRateDefault, currency) {
  db.prepare('DELETE FROM quotation_items WHERE quotation_id=?').run(qid);
  const stmt = db.prepare(
    `INSERT INTO quotation_items (quotation_id, product_id, part_no, description, qty, unit, unit_price,
        amount, tax_rate, tax_amount, total, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let i = 0;
  for (const raw of items || []) {
    const qty = num(raw.qty, 0);
    const unitPrice = num(raw.unit_price, 0);
    const taxRate = raw.tax_rate === undefined || raw.tax_rate === null ? taxRateDefault : num(raw.tax_rate, 0);
    // 台幣（本位幣）取整數元、外幣到分——與 lib/calc.ts decimalsFor 一致
    const dec = decimalsFor(currency);
    const amount = round(qty * unitPrice, dec);
    const taxAmount = round(amount * taxRate, dec);
    stmt.run(
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
router.get('/', (req, res) => {
  const q = req.query || {};
  const cond = [];
  const args = [];
  if (q.keyword) {
    cond.push('(q.quotation_no LIKE ? OR q.note LIKE ? OR c.name LIKE ? OR q.id IN (SELECT quotation_id FROM quotation_items WHERE part_no LIKE ? OR description LIKE ?))');
    args.push(...Array(5).fill(`%${q.keyword}%`));
  }
  if (q.customer_id) { cond.push('q.customer_id = ?'); args.push(Number(q.customer_id)); }
  if (q.status) { cond.push('q.status = ?'); args.push(str(q.status)); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = db.prepare(`${SELECT} ${where} ORDER BY q.quotation_date DESC, q.id DESC`).all(...args);
  res.json(rows);
});

/** GET /:id 單筆含明細 */
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const q = db.prepare(`${SELECT} WHERE q.id=?`).get(id);
  if (!q) return res.status(404).json({ error: '報價單不存在' });
  res.json(withItems(q));
});

/** POST / 新增 */
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const customerId = b.customer_id ? Number(b.customer_id) : null;
    if (!customerId) return res.status(400).json({ error: '請選擇客戶' });
    const cust = db.prepare('SELECT * FROM customers WHERE id=?').get(customerId);
    if (!cust) return res.status(404).json({ error: '客戶不存在' });

    let quotationNo = str(b.quotation_no);
    if (!quotationNo) quotationNo = nextSerial('quotation_no_prefix', 'quotation_no_seq', 'QT');
    if (db.prepare('SELECT id FROM quotations WHERE quotation_no=?').get(quotationNo)) {
      return res.status(400).json({ error: `報價單編號 ${quotationNo} 已存在` });
    }

    const qdate = str(b.quotation_date) || toDateStr(new Date());
    const taxRate = num(b.tax_rate, 0.05);
    const id = await db.transaction(async () => {
      const info = db.prepare(
        `INSERT INTO quotations (quotation_no, quotation_date, valid_until, customer_id, sales_id, currency,
          exchange_rate, tax_rate, status, note, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        quotationNo, qdate, str(b.valid_until), customerId,
        b.sales_id ? Number(b.sales_id) : (req.user.id || null),
        str(b.currency, 'TWD') || 'TWD',
        num(b.exchange_rate, 1) > 0 ? num(b.exchange_rate) : 1,
        taxRate,
        str(b.status, 'draft'),
        str(b.note),
        req.user.id
      );
      saveItems(info.lastInsertRowid, b.items || [], taxRate, str(b.currency, 'TWD'));
      return info.lastInsertRowid;
    })();
    audit.log(req, 'quotation_create', `建立報價單 ${quotationNo}`);
    res.status(201).json(withItems(db.prepare(`${SELECT} WHERE q.id=?`).get(id)));
  } catch (e) { next(e); }
});

/** PUT /:id 更新（含明細重寫） */
router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM quotations WHERE id=?').get(id);
    if (!cur) return res.status(404).json({ error: '報價單不存在' });
    if (cur.approval_status === 'pending' || cur.approval_status === 'approved') {
      return res.status(409).json({ error: '報價單已送簽核，不可修改（退回後才可改）' });
    }
    const b = req.body || {};
    const customerId = b.customer_id ? Number(b.customer_id) : cur.customer_id;
    if (!customerId) return res.status(400).json({ error: '請選擇客戶' });

    const quotationNo = str(b.quotation_no) || cur.quotation_no;
    const dup = db.prepare('SELECT id FROM quotations WHERE quotation_no=? AND id<>?').get(quotationNo, id);
    if (dup) return res.status(400).json({ error: `報價單編號 ${quotationNo} 已存在` });

    const taxRate = num(b.tax_rate, cur.tax_rate ?? 0.05);
    await db.transaction(async () => {
      db.prepare(
        `UPDATE quotations SET quotation_no=?, quotation_date=?, valid_until=?, customer_id=?, sales_id=?,
          currency=?, exchange_rate=?, tax_rate=?, status=?, note=?, updated_at=datetime('now','localtime')
       WHERE id=?`
      ).run(
        quotationNo, str(b.quotation_date) || cur.quotation_date, str(b.valid_until), customerId,
        b.sales_id ? Number(b.sales_id) : cur.sales_id,
        str(b.currency, cur.currency) || 'TWD',
        num(b.exchange_rate, cur.exchange_rate) > 0 ? num(b.exchange_rate) : cur.exchange_rate,
        taxRate,
        str(b.status, cur.status),
        b.note === undefined ? cur.note : str(b.note),
        id
      );
      if (b.items) saveItems(id, b.items, taxRate, str(b.currency, cur.currency));
    })();
    audit.log(req, 'quotation_update', `更新報價單 ${quotationNo}`);
    res.json(withItems(db.prepare(`${SELECT} WHERE q.id=?`).get(id)));
  } catch (e) { next(e); }
});

/** DELETE /:id 刪除 */
router.delete('/:id', requireManager, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM quotations WHERE id=?').get(id);
    if (!cur) return res.status(404).json({ error: '報價單不存在' });
    if (cur.approval_status === 'pending' || cur.approval_status === 'approved') {
      return res.status(409).json({ error: '報價單已送簽核，不可刪除（退回後才可刪）' });
    }
    await db.transaction(async () => {
      db.prepare('DELETE FROM quotation_items WHERE quotation_id=?').run(id);
      db.prepare('DELETE FROM quotations WHERE id=?').run(id);
    })();
    audit.log(req, 'quotation_delete', `刪除報價單 ${cur.quotation_no}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
