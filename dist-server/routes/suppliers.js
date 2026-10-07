'use strict';
/** 供應商／大陸工廠主檔 */
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

router.get('/', wrap(async (req, res) => {
  const kw = str(req.query.keyword);
  const where = kw ? 'WHERE name LIKE ? OR code LIKE ? OR contact_name LIKE ?' : '';
  const args = kw ? Array(3).fill(`%${kw}%`) : [];
  res.json(await db.prepare(`SELECT * FROM suppliers ${where} ORDER BY active DESC, code, id`).all(...args));
}));

router.post('/', requireMasterWrite, wrap(async (req, res) => {
  const b = req.body || {};
  if (!str(b.name)) return res.status(400).json({ error: '供應商名稱為必填' });
  const code = str(b.code) || null;
  if (code && await db.prepare('SELECT id FROM suppliers WHERE code=?').get(code)) {
    return res.status(400).json({ error: `供應商代號 ${code} 已存在` });
  }
  const info = await db.prepare(
    `INSERT INTO suppliers (code, name, contact_name, phone, email, country, lead_time_days, payment_terms, currency, note, active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    code, str(b.name), str(b.contact_name), str(b.phone), str(b.email), str(b.country, '中國') || '中國',
    num(b.lead_time_days, 30), str(b.payment_terms), str(b.currency, 'RMB') || 'RMB',
    str(b.note), b.active === undefined ? 1 : (Number(b.active) ? 1 : 0)
  );
  audit.log(req, 'create', 'suppliers', info.lastInsertRowid, str(b.name));
  res.json(await db.prepare('SELECT * FROM suppliers WHERE id=?').get(info.lastInsertRowid));
}));

router.put('/:id', requireMasterWrite, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM suppliers WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '供應商不存在' });
  const b = req.body || {};
  const code = b.code !== undefined ? str(b.code) : cur.code;
  if (code && await db.prepare('SELECT id FROM suppliers WHERE code=? AND id<>?').get(code, id)) {
    return res.status(400).json({ error: `供應商代號 ${code} 已被其他供應商使用` });
  }
  await db.prepare(
    `UPDATE suppliers SET code=?, name=?, contact_name=?, phone=?, email=?, country=?, lead_time_days=?,
        payment_terms=?, currency=?, note=?, active=?, updated_at=datetime('now','localtime') WHERE id=?`
  ).run(
    code || null,
    b.name !== undefined ? str(b.name) : cur.name,
    b.contact_name !== undefined ? str(b.contact_name) : cur.contact_name,
    b.phone !== undefined ? str(b.phone) : cur.phone,
    b.email !== undefined ? str(b.email) : cur.email,
    b.country !== undefined ? str(b.country, '中國') : cur.country,
    b.lead_time_days !== undefined ? num(b.lead_time_days, 30) : cur.lead_time_days,
    b.payment_terms !== undefined ? str(b.payment_terms) : cur.payment_terms,
    b.currency !== undefined ? str(b.currency, 'RMB') : cur.currency,
    b.note !== undefined ? str(b.note) : cur.note,
    b.active === undefined ? cur.active : (Number(b.active) ? 1 : 0),
    id
  );
  audit.log(req, 'update', 'suppliers', id, cur.name);
  res.json(await db.prepare('SELECT * FROM suppliers WHERE id=?').get(id));
}));

router.delete('/:id', requireMasterWrite, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const s = await db.prepare('SELECT * FROM suppliers WHERE id=?').get(id);
  if (!s) return res.status(404).json({ error: '供應商不存在' });
  const used = await db.prepare('SELECT COUNT(*) AS n FROM orders WHERE supplier_id=?').get(id).n
             + await db.prepare('SELECT COUNT(*) AS n FROM products WHERE supplier_id=?').get(id).n;
  if (used > 0) {
    await db.prepare("UPDATE suppliers SET active=0, updated_at=datetime('now','localtime') WHERE id=?").run(id);
    audit.log(req, 'deactivate', 'suppliers', id, s.name);
    return res.json({ ok: true, deactivated: true, message: '該供應商已被引用，已改為停用' });
  }
  await db.prepare('DELETE FROM suppliers WHERE id=?').run(id);
  audit.log(req, 'delete', 'suppliers', id, s.name);
  res.json({ ok: true });
}));

module.exports = router;
