'use strict';
/**
 * 客戶對帳單（Customer Statement）
 * 選客戶+列帳區間 → 自動抓該區間出貨明細（shipments × orders × order_items）→ 存檔 → 出 PDF。
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireManager } = require('../lib/auth');
const audit = require('../lib/audit');
const { num, str } = require('../lib/util');

const router = express.Router();
router.use(requireAuth);

const SELECT = `SELECT s.*, c.name AS customer_name, c.customer_no, c.tax_id AS customer_tax_id,
                       c.phone AS customer_phone, c.fax AS customer_fax, c.address AS customer_addr,
                       c.email AS customer_email,
                       u.name AS created_by_name
                FROM customer_statements s
                LEFT JOIN customers c ON c.id = s.customer_id
                LEFT JOIN users u ON u.id = s.created_by`;

function getItems(sid) {
  return db.prepare('SELECT * FROM customer_statement_items WHERE statement_id=? ORDER BY sort_order, id').all(sid);
}

function withItems(s) {
  const items = getItems(s.id);
  return Object.assign({}, s, { items });
}

/** 自動從出貨單抓明細 */
function fetchItems(customerId, periodStart, periodEnd) {
  return db.prepare(`
    SELECT o.order_no AS po_no,
           oi.part_no,
           oi.qty,
           oi.unit_price,
           oi.amount,
           (oi.total - oi.amount) AS tax_amount,
           oi.total,
           COALESCE(sh.invoice_no, '') AS invoice_no,
           sh.ship_date,
           COALESCE(oi.note, '') AS note
    FROM shipments sh
    JOIN orders o ON o.id = sh.order_id
    JOIN order_items oi ON oi.order_id = o.id
    WHERE o.customer_id = ? AND sh.ship_date BETWEEN ? AND ?
    ORDER BY sh.ship_date, sh.id, oi.sort_order, oi.id
  `).all(Number(customerId), periodStart, periodEnd);
}

/** 對帳單號：ST + yymm + 流水 */
function nextStmtNo() {
  const d = new Date();
  const prefix = `ST${String(d.getFullYear() % 100).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}`;
  const row = db.prepare("SELECT COUNT(*) AS c FROM customer_statements WHERE statement_no LIKE ?").get(prefix + '%');
  return `${prefix}${String(row.c + 1).padStart(4, '0')}`;
}

router.get('/', (req, res) => {
  const q = req.query || {};
  const cond = []; const args = [];
  if (q.customer_id) { cond.push('s.customer_id=?'); args.push(Number(q.customer_id)); }
  if (q.from) { cond.push('s.period_end>=?'); args.push(q.from); }
  if (q.to) { cond.push('s.period_start<=?'); args.push(q.to); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = db.prepare(`${SELECT} ${where} ORDER BY s.id DESC`).all(...args);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const s = db.prepare(`${SELECT} WHERE s.id=?`).get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: '對帳單不存在' });
  res.json(withItems(s));
});

router.post('/', requireManager, async (req, res, next) => {
  try {
    const b = req.body || {};
    const customerId = Number(b.customer_id);
    if (!customerId) return res.status(400).json({ error: '請選擇客戶' });
    if (!b.period_start || !b.period_end) return res.status(400).json({ error: '請填列帳起訖日' });
    const items = fetchItems(customerId, b.period_start, b.period_end);
    const subtotal = items.reduce((s, i) => s + num(i.amount), 0);
    const taxAmount = items.reduce((s, i) => s + num(i.tax_amount), 0);
    const grand = items.reduce((s, i) => s + num(i.total), 0);
    const stmtNo = b.statement_no || nextStmtNo();
    const tx = await db.transaction(async () => {
      const info = db.prepare(`INSERT INTO customer_statements
      (statement_no, customer_id, period_start, period_end, subtotal, tax_amount, grand_total, payment_terms, note, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        stmtNo, customerId, b.period_start, b.period_end,
        subtotal, taxAmount, grand,
        str(b.payment_terms), str(b.note), req.user.id);
      const sid = info.lastInsertRowid;
      const ins = db.prepare(`INSERT INTO customer_statement_items
      (statement_id, po_no, part_no, qty, unit_price, amount, tax_amount, total, invoice_no, ship_date, note, sort_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      items.forEach((it, i) => ins.run(sid, it.po_no, it.part_no, it.qty, it.unit_price, it.amount, it.tax_amount, it.total, it.invoice_no, it.ship_date, it.note, i));
      return sid;
    })();
    audit.log(req, 'statement_create', `建立對帳單 ${stmtNo}（客戶#${customerId}，${items.length} 筆明細）`);
    res.status(201).json(withItems(db.prepare(`${SELECT} WHERE s.id=?`).get(tx)));
  } catch (e) { next(e); }
});

router.put('/:id', requireManager, (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM customer_statements WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '對帳單不存在' });
  const b = req.body || {};
  db.prepare(`UPDATE customer_statements SET period_start=?, period_end=?, payment_terms=?, note=? WHERE id=?`)
    .run(b.period_start || cur.period_start, b.period_end || cur.period_end,
      str(b.payment_terms, cur.payment_terms), str(b.note, cur.note), id);
  res.json(withItems(db.prepare(`${SELECT} WHERE s.id=?`).get(id)));
});

router.delete('/:id', requireManager, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await db.transaction(async () => {
      db.prepare('DELETE FROM customer_statement_items WHERE statement_id=?').run(id);
      db.prepare('DELETE FROM customer_statements WHERE id=?').run(id);
    })();
    audit.log(req, 'statement_delete', `刪除對帳單 #${id}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
