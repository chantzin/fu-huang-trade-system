'use strict';
/** 客戶主檔 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireMasterWrite } = require('../lib/auth');
const audit = require('../lib/audit');
const { num, str } = require('../lib/util');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();
router.use(requireAuth);

const SELECT = `SELECT c.*, u.name AS owner_name, u.emp_id AS owner_emp_id,
                        t.name AS ar_terms_name, t.basis AS ar_terms_basis, t.days AS ar_terms_days
                  FROM customers c
                  LEFT JOIN users u ON u.id = c.owner_id
                  LEFT JOIN ar_terms t ON t.id = c.ar_terms_id`;

router.get('/', wrap(async (req, res) => {
  const kw = str(req.query.keyword);
  const where = kw ? `WHERE c.name LIKE ? OR c.customer_no LIKE ? OR c.short_name LIKE ? OR c.tax_id LIKE ?` : '';
  const args = kw ? Array(4).fill(`%${kw}%`) : [];
  res.json(await db.prepare(`${SELECT} ${where} ORDER BY c.active DESC, c.customer_no, c.id`).all(...args));
}));

router.get('/:id', wrap(async (req, res) => {
  const r = await db.prepare(`${SELECT} WHERE c.id=?`).get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: '客戶不存在' });
  res.json(r);
}));

router.post('/', requireMasterWrite, wrap(async (req, res) => {
  const b = req.body || {};
  if (!str(b.name)) return res.status(400).json({ error: '公司名稱為必填' });
  const customerNo = str(b.customer_no) || null;
  if (customerNo && await db.prepare('SELECT id FROM customers WHERE customer_no=?').get(customerNo)) {
    return res.status(400).json({ error: `客戶編號 ${customerNo} 已存在` });
  }
  const info = await db.prepare(
    `INSERT INTO customers (customer_no, name, short_name, tax_id, invoice_title, contact_name, phone, fax, email,
        address, invoice_addr, currency, payment_terms, terms_days, tax_rate, owner_id, note, active, ar_terms_id, is_test)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    customerNo, str(b.name), str(b.short_name), str(b.tax_id), str(b.invoice_title), str(b.contact_name),
    str(b.phone), str(b.fax), str(b.email), str(b.address), str(b.invoice_addr),
    str(b.currency, 'TWD') || 'TWD', str(b.payment_terms, '月結60天') || '月結60天',
    num(b.terms_days, 60), num(b.tax_rate, 0.05), Number(b.owner_id) > 0 ? Number(b.owner_id) : null,
    str(b.note), b.active === undefined ? 1 : (Number(b.active) ? 1 : 0),
    Number(b.ar_terms_id) > 0 ? Number(b.ar_terms_id) : null,
    b.is_test ? 1 : 0
  );
  audit.log(req, 'create', 'customers', info.lastInsertRowid, str(b.name));
  res.json(await db.prepare(`${SELECT} WHERE c.id=?`).get(info.lastInsertRowid));
}));

router.put('/:id', requireMasterWrite, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '客戶不存在' });
  const b = req.body || {};
  const customerNo = b.customer_no !== undefined ? str(b.customer_no) : cur.customer_no;
  if (customerNo && await db.prepare('SELECT id FROM customers WHERE customer_no=? AND id<>?').get(customerNo, id)) {
    return res.status(400).json({ error: `客戶編號 ${customerNo} 已被其他客戶使用` });
  }
  await db.prepare(
    `UPDATE customers SET customer_no=?, name=?, short_name=?, tax_id=?, invoice_title=?, contact_name=?, phone=?,
        fax=?, email=?, address=?, invoice_addr=?, currency=?, payment_terms=?, terms_days=?, tax_rate=?,
        owner_id=?, note=?, active=?, ar_terms_id=?, is_test=?, updated_at=datetime('now','localtime') WHERE id=?`
  ).run(
    customerNo || null,
    b.name !== undefined ? str(b.name) : cur.name,
    b.short_name !== undefined ? str(b.short_name) : cur.short_name,
    b.tax_id !== undefined ? str(b.tax_id) : cur.tax_id,
    b.invoice_title !== undefined ? str(b.invoice_title) : cur.invoice_title,
    b.contact_name !== undefined ? str(b.contact_name) : cur.contact_name,
    b.phone !== undefined ? str(b.phone) : cur.phone,
    b.fax !== undefined ? str(b.fax) : cur.fax,
    b.email !== undefined ? str(b.email) : cur.email,
    b.address !== undefined ? str(b.address) : cur.address,
    b.invoice_addr !== undefined ? str(b.invoice_addr) : cur.invoice_addr,
    b.currency !== undefined ? str(b.currency, 'TWD') : cur.currency,
    b.payment_terms !== undefined ? str(b.payment_terms) : cur.payment_terms,
    b.terms_days !== undefined ? num(b.terms_days, 60) : cur.terms_days,
    b.tax_rate !== undefined ? num(b.tax_rate, 0.05) : cur.tax_rate,
    b.owner_id !== undefined ? (Number(b.owner_id) > 0 ? Number(b.owner_id) : null) : cur.owner_id,
    b.note !== undefined ? str(b.note) : cur.note,
    b.active === undefined ? cur.active : (Number(b.active) ? 1 : 0),
    b.ar_terms_id !== undefined ? (Number(b.ar_terms_id) > 0 ? Number(b.ar_terms_id) : null) : cur.ar_terms_id,
    b.is_test === undefined ? (cur.is_test ? 1 : 0) : (b.is_test ? 1 : 0),
    id
  );
  audit.log(req, 'update', 'customers', id, cur.name);
  res.json(await db.prepare(`${SELECT} WHERE c.id=?`).get(id));
}));

router.delete('/:id', requireMasterWrite, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const c = await db.prepare('SELECT * FROM customers WHERE id=?').get(id);
  if (!c) return res.status(404).json({ error: '客戶不存在' });
  const used = await db.prepare('SELECT COUNT(*) AS n FROM orders WHERE customer_id=?').get(id).n;
  if (used > 0) {
    await db.prepare("UPDATE customers SET active=0, updated_at=datetime('now','localtime') WHERE id=?").run(id);
    audit.log(req, 'deactivate', 'customers', id, c.name);
    return res.json({ ok: true, deactivated: true, message: '該客戶已有訂單資料，已改為停用' });
  }
  await db.prepare('DELETE FROM customers WHERE id=?').run(id);
  audit.log(req, 'delete', 'customers', id, c.name);
  res.json({ ok: true });
}));

module.exports = router;
