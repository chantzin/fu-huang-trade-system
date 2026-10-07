'use strict';
/** 產品（料號）主檔
 *  P3-2 Phase2 2.4 遷移示範：handler 改 async + 所有 db 存取加 await。
 *  primary（failover 關閉，預設）下 db-dual 回傳同步值，await 無害、行為不變；
 *  secondary（failover 啟用）下 db-dual 回傳 Promise，await 正確非同步。
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireMasterWrite } = require('../lib/auth');
const audit = require('../lib/audit');
const { num, str } = require('../lib/util');

const router = express.Router();
router.use(requireAuth);

/** async 錯誤轉送：避免 async handler 的 rejected promise 變成 unhandled（Express4 不會自動 catch） */
function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const SELECT = `SELECT p.*, s.name AS supplier_name
                  FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id`;

function inventoryMasterError(body, current = null) {
  for (const key of ['stock_qty', 'cost_unit']) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value < 0) return `${key} 必須為有效的非負數`;
    const oldValue = current ? Number(current[key]) || 0 : 0;
    if (Math.abs(value - oldValue) > 0.000001) {
      return '庫存量與成本不可由產品主檔修改，請使用「庫存管理」的期初建帳、收貨或調整功能';
    }
  }
  return null;
}

router.get('/', wrap(async (req, res) => {
  const kw = str(req.query.keyword);
  const where = kw ? 'WHERE p.part_no LIKE ? OR p.name LIKE ? OR p.spec LIKE ?' : '';
  const args = kw ? Array(3).fill(`%${kw}%`) : [];
  res.json(await db.prepare(`${SELECT} ${where} ORDER BY p.active DESC, p.part_no, p.id`).all(...args));
}));

// P3（2026-09-23 體檢）：單筆產品主檔查詢（唯讀，不含庫存異動；庫存欄僅展示）
router.get('/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '無效的產品 id' });
  const p = await db.prepare(`${SELECT} WHERE p.id=?`).get(id);
  if (!p) return res.status(404).json({ error: '產品不存在' });
  res.json(p);
}));

router.post('/', requireMasterWrite, wrap(async (req, res) => {
  const b = req.body || {};
  const inventoryError = inventoryMasterError(b);
  if (inventoryError) return res.status(400).json({ error: inventoryError });
  const partNo = str(b.part_no);
  if (!partNo) return res.status(400).json({ error: '料號為必填' });
  if (!str(b.name)) return res.status(400).json({ error: '品名為必填' });
  if (await db.prepare('SELECT id FROM products WHERE part_no=?').get(partNo)) {
    return res.status(400).json({ error: `料號 ${partNo} 已存在` });
  }
  const info = await db.prepare(
    `INSERT INTO products (part_no, name, spec, version, unit, price, currency, supplier_id, note, active, safety_stock)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    partNo, str(b.name), str(b.spec), str(b.version), str(b.unit, 'PCS') || 'PCS',
    num(b.price), str(b.currency, 'TWD') || 'TWD',
    Number(b.supplier_id) > 0 ? Number(b.supplier_id) : null, str(b.note), b.active === undefined ? 1 : (Number(b.active) ? 1 : 0),
    num(b.safety_stock, 0)
  );
  audit.log(req, 'create', 'products', info.lastInsertRowid, partNo);
  res.json(await db.prepare(`${SELECT} WHERE p.id=?`).get(info.lastInsertRowid));
}));

router.put('/:id', requireMasterWrite, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '產品不存在' });
  const b = req.body || {};
  const inventoryError = inventoryMasterError(b, cur);
  if (inventoryError) return res.status(400).json({ error: inventoryError });
  const partNo = b.part_no !== undefined ? str(b.part_no) : cur.part_no;
  if (!partNo) return res.status(400).json({ error: '料號不可空白' });
  if (await db.prepare('SELECT id FROM products WHERE part_no=? AND id<>?').get(partNo, id)) {
    return res.status(400).json({ error: `料號 ${partNo} 已被其他產品使用` });
  }
  await db.prepare(
    `UPDATE products SET part_no=?, name=?, spec=?, version=?, unit=?, price=?,
        currency=?, supplier_id=?, note=?, active=?, safety_stock=?, updated_at=datetime('now','localtime') WHERE id=?`
  ).run(
    partNo,
    b.name !== undefined ? str(b.name) : cur.name,
    b.spec !== undefined ? str(b.spec) : cur.spec,
    b.version !== undefined ? str(b.version) : cur.version,
    b.unit !== undefined ? str(b.unit, 'PCS') : cur.unit,
    b.price !== undefined ? num(b.price, cur.price) : cur.price,
    b.currency !== undefined ? str(b.currency, 'TWD') : cur.currency,
    b.supplier_id !== undefined ? (Number(b.supplier_id) > 0 ? Number(b.supplier_id) : null) : cur.supplier_id,
    b.note !== undefined ? str(b.note) : cur.note,
    b.active === undefined ? cur.active : (Number(b.active) ? 1 : 0),
    b.safety_stock !== undefined ? num(b.safety_stock, cur.safety_stock) : cur.safety_stock,
    id
  );
  audit.log(req, 'update', 'products', id, partNo);
  res.json(await db.prepare(`${SELECT} WHERE p.id=?`).get(id));
}));

router.delete('/:id', requireMasterWrite, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const p = await db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: '產品不存在' });
  const used = (await db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE product_id=?').get(id)).n;
  const inventoryHistory = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM stock_transactions WHERE product_id=?) +
       (SELECT COUNT(*) FROM stock_lots WHERE product_id=?) +
       (SELECT COUNT(*) FROM stock_serials WHERE product_id=?) +
       (SELECT COUNT(*) FROM stocktake_items WHERE product_id=?) +
       (SELECT COUNT(*) FROM shipments WHERE product_id=?) +
       (SELECT COUNT(*) FROM supplier_shipments WHERE product_id=?) AS n`
  ).get(id, id, id, id, id, id);
  if (used > 0 || Number(inventoryHistory.n) > 0) {
    await db.prepare("UPDATE products SET active=0, updated_at=datetime('now','localtime') WHERE id=?").run(id);
    audit.log(req, 'deactivate', 'products', id, p.part_no);
    return res.json({ ok: true, deactivated: true, message: '該料號已有訂單或庫存歷史，已改為停用' });
  }
  await db.prepare('DELETE FROM products WHERE id=?').run(id);
  audit.log(req, 'delete', 'products', id, p.part_no);
  res.json({ ok: true });
}));

module.exports = router;
