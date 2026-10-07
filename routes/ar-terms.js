'use strict';
/** 帳期規則管理（多樣式，每筆有唯一 ID） */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireManager } = require('../lib/auth');
const audit = require('../lib/audit');
const { str, num } = require('../lib/util');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();
router.use(requireAuth);

const BASIS_LABEL = {
  month_end: '結帳月底 + 月結天數',
  next_month_start: '次月 1 日 + (天數-1)',
  cash: '現金款（當天收款）',
  prepaid: '預付款（訂單時預收）',
};

/** 列表（全部，含停用；管理頁用） */
router.get('/', wrap(async (req, res) => {
  const rows = await db.prepare('SELECT * FROM ar_terms ORDER BY is_system DESC, id ASC').all();
  res.json(rows.map((r) => ({ ...r, basis_label: BASIS_LABEL[r.basis] || r.basis })));
}));

/** 只回傳啟用的（客戶檔下拉選單用） */
router.get('/active', wrap(async (req, res) => {
  const rows = await db.prepare('SELECT id, name, basis, days, description FROM ar_terms WHERE is_active=1 ORDER BY is_system DESC, id ASC').all();
  res.json(rows.map((r) => ({ ...r, basis_label: BASIS_LABEL[r.basis] || r.basis })));
}));

/** 單筆 */
router.get('/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const r = await db.prepare('SELECT * FROM ar_terms WHERE id=?').get(id);
  if (!r) return res.status(404).json({ error: '帳期規則不存在' });
  res.json({ ...r, basis_label: BASIS_LABEL[r.basis] || r.basis });
}));

/** 新增 */
router.post('/', requireManager, wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.name);
  const basis = str(b.basis) || 'month_end';
  const days = num(b.days, 0);
  const description = str(b.description);
  if (!name) return res.status(400).json({ error: '請輸入規則名稱' });
  if (!['month_end', 'next_month_start', 'cash', 'prepaid'].includes(basis)) {
    return res.status(400).json({ error: '推導方式不正確' });
  }
  if ((basis === 'month_end' || basis === 'next_month_start') && days <= 0) {
    return res.status(400).json({ error: '月結天數必須大於 0' });
  }
  const info = await db.prepare(
    'INSERT INTO ar_terms (name, basis, days, description, is_system, is_active) VALUES (?,?,?,?,0,1)'
  ).run(name, basis, days, description);
  audit.log(req, 'create', 'ar_terms', info.lastInsertRowid, name);
  res.json(await db.prepare('SELECT * FROM ar_terms WHERE id=?').get(info.lastInsertRowid));
}));

/** 修改 */
router.put('/:id', requireManager, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const r = await db.prepare('SELECT * FROM ar_terms WHERE id=?').get(id);
  if (!r) return res.status(404).json({ error: '帳期規則不存在' });
  const b = req.body || {};
  const name = str(b.name) || r.name;
  const basis = str(b.basis) || r.basis;
  const days = b.days !== undefined ? num(b.days, 0) : r.days;
  const description = b.description !== undefined ? str(b.description) : r.description;
  if (!['month_end', 'next_month_start', 'cash', 'prepaid'].includes(basis)) {
    return res.status(400).json({ error: '推導方式不正確' });
  }
  if ((basis === 'month_end' || basis === 'next_month_start') && days <= 0) {
    return res.status(400).json({ error: '月結天數必須大於 0' });
  }
  await db.prepare(
    'UPDATE ar_terms SET name=?, basis=?, days=?, description=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?'
  ).run(name, basis, days, description, id);
  audit.log(req, 'update', 'ar_terms', id, name);
  res.json(await db.prepare('SELECT * FROM ar_terms WHERE id=?').get(id));
}));

/** 刪除（系統預設 is_system=1 不可刪除） */
router.delete('/:id', requireManager, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const r = await db.prepare('SELECT * FROM ar_terms WHERE id=?').get(id);
  if (!r) return res.status(404).json({ error: '帳期規則不存在' });
  if (r.is_system) {
    return res.status(403).json({ error: '系統預設規則不可刪除（可停用或修改）' });
  }
  // 檢查是否有客戶使用此規則
  const used = await db.prepare('SELECT COUNT(*) AS c FROM customers WHERE ar_terms_id=?').get(id).c;
  if (used > 0) {
    return res.status(400).json({ error: `有 ${used} 個客戶使用此規則，請先變更客戶的交易條件` });
  }
  await db.prepare('DELETE FROM ar_terms WHERE id=?').run(id);
  audit.log(req, 'delete', 'ar_terms', id, r.name);
  res.json({ ok: true });
}));

/** 啟用/停用切換 */
router.put('/:id/toggle', requireManager, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const r = await db.prepare('SELECT * FROM ar_terms WHERE id=?').get(id);
  if (!r) return res.status(404).json({ error: '帳期規則不存在' });
  const newActive = r.is_active ? 0 : 1;
  await db.prepare('UPDATE ar_terms SET is_active=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(newActive, id);
  audit.log(req, 'update', 'ar_terms', id, `${r.name} ${newActive ? '啟用' : '停用'}`);
  res.json({ ok: true, is_active: newActive });
}));

module.exports = router;
