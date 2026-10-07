'use strict';
/**
 * 庫存管理（P1/P2/P4/P5，2026-09-23）
 * 彙整：總覽 KPI、異動日記帳、批號/序號、補貨建議、成本評價、手動調整、盤點。
 * 讀取：所有登入角色；異動（調整/盤點確認）：manager / admin。
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireManager } = require('../lib/auth');
const audit = require('../lib/audit');
const inv = require('../lib/inventory');
const { num, str, nextSerial } = require('../lib/util');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();
router.use(requireAuth);

/** GET /summary 總覽 KPI */
router.get('/summary', wrap(async (req, res) => {
  const prods = await db.prepare('SELECT COUNT(*) AS c FROM products WHERE active=1').get();
  const val = await db.prepare('SELECT COALESCE(ROUND(SUM(stock_qty*cost_unit)),0) AS v FROM products WHERE active=1').get();
  const below = await db.prepare('SELECT COUNT(*) AS c FROM products WHERE active=1 AND safety_stock>0 AND stock_qty<=safety_stock').get();
  const lots = await db.prepare('SELECT COUNT(*) AS c FROM stock_lots WHERE qty>0').get();
  const serials = await db.prepare("SELECT COUNT(*) AS c FROM stock_serials WHERE status='in'").get();
  const expiring = await db.prepare("SELECT COUNT(*) AS c FROM stock_lots WHERE qty>0 AND exp_date IS NOT NULL AND exp_date<=date('now','localtime','+90 day')").get();
  res.json({
    totalSku: prods.c,
    stockValue: val.v || 0,
    belowSafety: below.c,
    activeLots: lots.c,
    serialsIn: serials.c,
    expiringSoon: expiring.c,
  });
}));

/** GET /transactions 異動日記帳 */
router.get('/transactions', wrap(async (req, res) => {
  const q = req.query || {};
  const cond = [];
  const args = [];
  if (q.product_id) { cond.push('t.product_id = ?'); args.push(Number(q.product_id)); }
  if (q.doc_type) { cond.push('t.doc_type = ?'); args.push(str(q.doc_type)); }
  if (q.date_from) { cond.push('t.created_at >= ?'); args.push(q.date_from); }
  if (q.date_to) { cond.push('t.created_at <= ?'); args.push(q.date_to); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = await db.prepare(
    `SELECT t.*, p.part_no, p.name AS product_name
     FROM stock_transactions t LEFT JOIN products p ON p.id = t.product_id
     ${where} ORDER BY t.id DESC LIMIT 1000`
  ).all(...args);
  res.json(rows);
}));

/** GET /lots 批號庫存 */
router.get('/lots', wrap(async (req, res) => {
  const q = req.query || {};
  const cond = [];
  const args = [];
  if (q.product_id) { cond.push('l.product_id = ?'); args.push(Number(q.product_id)); }
  if (q.expire_before) { cond.push('l.exp_date IS NOT NULL AND l.exp_date <= ?'); args.push(str(q.expire_before)); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = await db.prepare(
    `SELECT l.*, p.part_no, p.name AS product_name
     FROM stock_lots l LEFT JOIN products p ON p.id = l.product_id
     ${where} ORDER BY l.exp_date ASC, l.id ASC`
  ).all(...args);
  res.json(rows);
}));

/** GET /serials 序號追蹤 */
router.get('/serials', wrap(async (req, res) => {
  const q = req.query || {};
  const cond = [];
  const args = [];
  if (q.product_id) { cond.push('s.product_id = ?'); args.push(Number(q.product_id)); }
  if (q.status) { cond.push("s.status = ?"); args.push(str(q.status)); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = await db.prepare(
    `SELECT s.*, p.part_no, p.name AS product_name
     FROM stock_serials s LEFT JOIN products p ON p.id = s.product_id
     ${where} ORDER BY s.id DESC LIMIT 2000`
  ).all(...args);
  res.json(rows);
}));

/** GET /reorder 低於安全庫存 / 建議補貨 */
router.get('/reorder', wrap(async (req, res) => {
  const rows = await db.prepare(
    `SELECT p.id, p.part_no, p.name, p.stock_qty, p.safety_stock, p.cost_unit, p.supplier_id, s.name AS supplier_name
     FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.active=1 AND p.safety_stock>0 AND p.stock_qty <= p.safety_stock
     ORDER BY (p.safety_stock - p.stock_qty) DESC, p.part_no`
  ).all();
  res.json(rows);
}));

/** GET /cost-report 成本評價（加權平均 + 庫存價值） */
router.get('/cost-report', wrap(async (req, res) => {
  const rows = await db.prepare(
    `SELECT p.id, p.part_no, p.name, p.stock_qty, p.cost_unit AS avg_cost,
            ROUND(p.stock_qty * p.cost_unit, 2) AS stock_value
     FROM products p WHERE p.active=1 AND p.stock_qty <> 0
     ORDER BY stock_value DESC, p.part_no`
  ).all();
  res.json(rows);
}));

/** GET /opening-candidates 尚可建立期初庫存的產品 */
router.get('/opening-candidates', wrap(async (req, res) => {
  const rows = await db.prepare(
    `SELECT p.id, p.part_no, p.name
     FROM products p
     WHERE p.active=1 AND COALESCE(p.stock_qty,0)=0
       AND NOT EXISTS (SELECT 1 FROM stock_transactions t WHERE t.product_id=p.id)
       AND NOT EXISTS (SELECT 1 FROM stock_lots l WHERE l.product_id=p.id)
       AND NOT EXISTS (SELECT 1 FROM stock_serials s WHERE s.product_id=p.id)
     ORDER BY p.part_no, p.id`
  ).all();
  res.json(rows);
}));

/** POST /opening 期初庫存建帳（僅零庫存且無既有庫存日記帳的產品） */
router.post('/opening', requireManager, wrap(async (req, res) => {
  const b = req.body || {};
  const productId = Number(b.product_id);
  const qty = Number(b.qty);
  const unitCost = Number(b.unit_cost);
  if (!Number.isInteger(productId) || productId <= 0) return res.status(400).json({ error: '請選擇產品' });
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: '期初數量必須大於 0' });
  if (!Number.isFinite(unitCost) || unitCost < 0) return res.status(400).json({ error: '期初單位成本必須為有效的非負數' });
  const operator = (req.user && (req.user.emp_id || req.user.name)) || '';
  try {
    const result = await db.transaction(async (tx) => inv.initializeStock({
      productId, qty, unitCost, batchNo: str(b.batch_no),
      mfgDate: str(b.mfg_date), expDate: str(b.exp_date), serials: b.serials,
      operator, note: str(b.note) || '期初庫存建帳',
    }, tx))();
    audit.log(req, 'stock_opening', 'products', productId, `期初建帳 ${qty} @ ${unitCost}`);
    res.status(201).json({ ok: true, stxId: result.stxId, newQty: result.newQty, newCost: result.newCost });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

/** POST /adjust 手動調整（盤盈/盤虧/矯正） */
router.post('/adjust', requireManager, wrap(async (req, res) => {
  const b = req.body || {};
  const productId = Number(b.product_id);
  if (!productId) return res.status(400).json({ error: '請選擇產品' });
  if (!inv.getProduct(productId)) return res.status(404).json({ error: '產品不存在' });
  const delta = num(b.delta);
  if (delta === 0) return res.status(400).json({ error: '調整量不可為 0' });
  const operator = (req.user && (req.user.emp_id || req.user.name)) || '';
  let r;
  try {
    r = await db.transaction(() => inv.adjustStock({
      productId, delta, reason: str(b.reason) || 'adjust', operator, note: str(b.note),
    }))();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  audit.log(req, 'stock_adjust', 'products', productId, `手動調整 ${delta}`);
  const p = await db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  res.json({ ok: true, stxId: r.stxId, newQty: p.stock_qty });
}));

/* ---------------- 盤點 ---------------- */
/** GET /stocktake 盤點單列表 */
router.get('/stocktake', wrap(async (req, res) => {
  const rows = await db.prepare('SELECT * FROM stocktakes ORDER BY id DESC').all();
  res.json(rows);
}));

/** POST /stocktake 新建盤點單（草稿，帶入所有啟用產品系統量） */
router.post('/stocktake', requireManager, wrap(async (req, res) => {
  const b = req.body || {};
  const no = str(b.stocktake_no) || nextSerial('stocktake_no_prefix', 'stocktake_no_seq', 'STK');
  const id = await db.transaction(() => {
    const stocktakeId = db.prepare(
      `INSERT INTO stocktakes (stocktake_no, status, counted_by, note) VALUES (?, 'draft', ?, ?)`
    ).run(no, req.user ? req.user.id : null, str(b.note)).lastInsertRowid;
    const prods = db.prepare('SELECT id, stock_qty FROM products WHERE active=1').all();
    const ins = db.prepare(
      'INSERT INTO stocktake_items (stocktake_id, product_id, system_qty, counted_qty, diff) VALUES (?,?,?,?,0)'
    );
    for (const p of prods) ins.run(stocktakeId, p.id, Number(p.stock_qty) || 0, Number(p.stock_qty) || 0);
    return stocktakeId;
  })();
  audit.log(req, 'stocktake_create', 'stocktakes', id, no);
  res.status(201).json(await db.prepare('SELECT * FROM stocktakes WHERE id=?').get(id));
}));

/** GET /stocktake/:id 盤點單 + 明細 */
router.get('/stocktake/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const head = await db.prepare('SELECT * FROM stocktakes WHERE id=?').get(id);
  if (!head) return res.status(404).json({ error: '盤點單不存在' });
  const items = await db.prepare(
    `SELECT i.*, p.part_no, p.name AS product_name, p.safety_stock
     FROM stocktake_items i LEFT JOIN products p ON p.id = i.product_id
     WHERE i.stocktake_id=? ORDER BY p.part_no`
  ).all(id);
  res.json({ head, items });
}));

/** POST /stocktake/:id/confirm 確認盤點：對每項差額做調整異動 */
router.post('/stocktake/:id/confirm', requireManager, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const head = await db.prepare('SELECT * FROM stocktakes WHERE id=?').get(id);
  if (!head) return res.status(404).json({ error: '盤點單不存在' });
  if (head.status !== 'draft') return res.status(409).json({ error: '只有草稿盤點單可以確認' });
  const items = req.body && req.body.items ? req.body.items : [];
  if (!Array.isArray(items)) return res.status(400).json({ error: '盤點明細格式錯誤' });
  const operator = (req.user && (req.user.emp_id || req.user.name)) || '';
  try {
    // db-dual 雙驅動：交易回呼以 async + await 撰寫，primary/secondary 皆安全
    await db.transaction(async () => {
      const allItems = await db.prepare('SELECT * FROM stocktake_items WHERE stocktake_id=?').all(id);
      const submittedIds = items.map((it) => Number(it.id));
      if (submittedIds.length !== allItems.length || new Set(submittedIds).size !== allItems.length ||
          allItems.some((it) => !submittedIds.includes(Number(it.id)))) {
        throw new Error('盤點明細不完整或有重複項目，請重新載入盤點單');
      }
      const upd = db.prepare('UPDATE stocktake_items SET counted_qty=?, diff=?, note=? WHERE id=?');
      for (const it of items) {
        const iid = Number(it.id);
        const counted = Number(it.counted_qty);
        if (!Number.isFinite(counted) || counted < 0) throw new Error('實盤數量必須是大於或等於 0 的有效數字');
        const cur = await db.prepare('SELECT * FROM stocktake_items WHERE id=?').get(iid);
        if (!cur || Number(cur.stocktake_id) !== id) throw new Error('盤點明細不存在或不屬於此盤點單');
        const product = await db.prepare('SELECT stock_qty FROM products WHERE id=?').get(cur.product_id);
        if (!product) throw new Error(`產品 ${cur.product_id} 已不存在`);
        // Keep displayed variance against the captured snapshot, but post against the live balance.
        const variance = counted - (Number(cur.system_qty) || 0);
        const postingDelta = counted - (Number(product.stock_qty) || 0);
        await upd.run(counted, variance, str(it.note), iid);
        if (postingDelta !== 0) {
          inv.adjustStock({ productId: cur.product_id, delta: postingDelta, reason: 'stocktake', operator, note: `盤點單 ${head.stocktake_no}` });
        }
      }
      const changed = await db.prepare("UPDATE stocktakes SET status='confirmed', counted_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=? AND status='draft'").run(id);
      if (changed.changes !== 1) throw new Error('盤點單狀態已變更，請重新載入');
    })();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  audit.log(req, 'stocktake_confirm', 'stocktakes', id, head.stocktake_no);
  res.json({ ok: true });
}));

module.exports = router;
