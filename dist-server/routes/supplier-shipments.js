'use strict';
/**
 * 供應商出貨與單據（進貨單，Supplier Shipment，供應鏈）
 * 主檔：進貨單號／供應商／關聯採購單／進貨日期／數量／發票／備註。
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireManager } = require('../lib/auth');
const audit = require('../lib/audit');
const { num, str, toDateStr } = require('../lib/util');
const { nextSerial } = require('../lib/serial-dual');
const inv = require('../lib/inventory');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();
router.use(requireAuth);

// A3/P2：列表直接帶出「已結應付標誌」與「應付發票金額 vs 實收成本」勾稽欄位
const SELECT = `SELECT sh.*, s.name AS supplier_name, s.code AS supplier_code, so.order_no,
                (SELECT CASE WHEN COUNT(*)>0 AND MIN(CASE WHEN p.paid_amount >= p.amount_base - 0.01 THEN 1 ELSE 0 END)=1 THEN 1 ELSE 0 END
                   FROM payable_sources ps JOIN payables p ON p.id=ps.payable_id WHERE ps.shipment_id=sh.id) AS ap_settled,
                COALESCE((SELECT SUM(p.amount_base) FROM payable_sources ps JOIN payables p ON p.id=ps.payable_id WHERE ps.shipment_id=sh.id),0) AS ap_amount,
                COALESCE((SELECT SUM(st.unit_cost * st.qty) FROM stock_transactions st
                          WHERE st.doc_type='receipt' AND st.doc_id=sh.id AND st.direction=1 AND st.reversed_by IS NULL),0) AS received_cost
           FROM supplier_shipments sh
           LEFT JOIN suppliers s ON s.id = sh.supplier_id
           LEFT JOIN supplier_orders so ON so.id = sh.order_id`;

// P2：勾稽閾值（差異超過 AP 金額 1% 或 1 元即標註異常）
function reconcileThreshold(row) { return Math.max(0.01 * Math.abs(Number(row.ap_amount) || 0), 1); }
function decorateReconcile(row) {
  const ap = Number(row.ap_amount) || 0;
  const rc = Number(row.received_cost) || 0;
  const variance = round(ap - rc);
  return Object.assign({}, row, {
    cost_variance: variance,
    reconcile_flag: Math.abs(variance) > reconcileThreshold(row) ? 1 : 0,
  });
}

async function refreshOrderStatus(orderId, executor = db) {
  if (!orderId) return;
  const order = await executor.prepare('SELECT status, approval_status FROM supplier_orders WHERE id=?').get(orderId);
  if (!order || order.status === 'cancelled') return;
  const items = await executor.prepare('SELECT id, qty FROM supplier_order_items WHERE order_id=?').all(orderId);
  const received = [];
  for (const it of items) received.push(Number((await executor.prepare('SELECT COALESCE(SUM(qty),0) AS qty FROM supplier_shipments WHERE order_item_id=?').get(it.id))?.qty || 0));
  const any = received.some((q) => q > 0);
  const all = items.length > 0 && items.every((it, i) => received[i] + 1e-9 >= Number(it.qty || 0));
  const next = all ? 'received' : any ? 'partial' : (order.approval_status === 'approved' ? 'confirmed' : 'draft');
  await executor.prepare("UPDATE supplier_orders SET status=?, updated_at=datetime('now','localtime') WHERE id=?").run(next, orderId);
}

async function validateReceipt(b, supplierId, executor = db, excludeShipmentId = 0) {
  const qty = Number(b.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw Object.assign(new Error('進貨數量必須大於 0'), { status: 400 });
  if (!b.order_id) return null;
  const orderId = Number(b.order_id);
  const order = await executor.prepare('SELECT * FROM supplier_orders WHERE id=?').get(orderId);
  if (!order) throw Object.assign(new Error('關聯採購單不存在'), { status: 404 });
  if (Number(order.supplier_id) !== Number(supplierId)) throw Object.assign(new Error('進貨供應商與採購單供應商不一致'), { status: 400 });
  if (order.status === 'cancelled') throw Object.assign(new Error('已取消的採購單不可收貨'), { status: 409 });
  if (order.approval_status !== 'approved') throw Object.assign(new Error('採購單尚未核准，不可收貨'), { status: 409 });
  const legacyUnlinked = await executor.prepare('SELECT COUNT(*) AS n FROM supplier_shipments WHERE order_id=? AND order_item_id IS NULL AND id<>?').get(orderId, excludeShipmentId);
  if (Number(legacyUnlinked?.n || 0) > 0) throw Object.assign(new Error('此採購單含無法自動對應採購明細的舊進貨紀錄，請先完成明細對帳再收貨'), { status: 409 });
  let itemId = Number(b.order_item_id) || null;
  if (!itemId && b.product_id) {
    const candidates = await executor.prepare('SELECT id FROM supplier_order_items WHERE order_id=? AND product_id=?').all(orderId, Number(b.product_id));
    if (candidates.length === 1) itemId = candidates[0].id;
    else if (candidates.length > 1) throw Object.assign(new Error('採購單有多筆相同產品，請指定採購明細'), { status: 400 });
  }
  const item = itemId
    ? await executor.prepare('SELECT * FROM supplier_order_items WHERE id=? AND order_id=?').get(itemId, orderId)
    : null;
  if (!item) throw Object.assign(new Error('請指定有效的採購明細'), { status: 400 });
  if (item.product_id && Number(b.product_id) !== Number(item.product_id)) throw Object.assign(new Error('進貨產品與採購明細不一致'), { status: 400 });
  const already = Number((await executor.prepare('SELECT COALESCE(SUM(qty),0) AS qty FROM supplier_shipments WHERE order_item_id=? AND id<>?').get(itemId, excludeShipmentId))?.qty || 0);
  if (already + qty > Number(item.qty) + 1e-9) throw Object.assign(new Error(`收貨超過採購數量（採購 ${item.qty}，已收 ${already}）`), { status: 409 });
  return { orderId, itemId };
}

/** GET / 列表（可篩選） */
router.get('/', wrap(async (req, res) => {
  const q = req.query || {};
  const cond = [];
  const args = [];
  if (q.keyword) {
    cond.push('(sh.shipment_no LIKE ? OR sh.invoice_no LIKE ? OR s.name LIKE ? OR so.order_no LIKE ?)');
    args.push(...Array(4).fill(`%${q.keyword}%`));
  }
  if (q.supplier_id) { cond.push('sh.supplier_id = ?'); args.push(Number(q.supplier_id)); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = await db.prepare(`${SELECT} ${where} ORDER BY sh.ship_date DESC, sh.id DESC`).all(...args);
  res.json(rows.map(decorateReconcile));
}));

/** P2：應付（發票金額）vs 庫存（實收成本）金額勾稽 — 列出差異超過閾值的進貨單 */
router.get('/reconcile', wrap(async (req, res) => {
  const rows = await db.prepare(`${SELECT} ORDER BY sh.ship_date DESC, sh.id DESC`).all();
  const flagged = rows.map(decorateReconcile).filter((r) => r.reconcile_flag === 1);
  res.json({
    ok: true,
    count: flagged.length,
    threshold_note: '差異超過 AP 金額 1% 或 1 元（幣別：本幣）即視為異常，請人工查核發票金額與實收成本是否一致',
    items: flagged,
  });
}));

/** POST / 新增 */
router.post('/', wrap(async (req, res) => {
  const b = req.body || {};
  const supplierId = b.supplier_id ? Number(b.supplier_id) : null;
  if (!supplierId) return res.status(400).json({ error: '請選擇供應商' });
  const sup = await db.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId);
  if (!sup) return res.status(404).json({ error: '供應商不存在' });
  let receipt;
  try { receipt = await validateReceipt(b, supplierId); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  let shipmentNo = str(b.shipment_no);
  if (!shipmentNo) shipmentNo = `SPS${Date.now()}`;
  if (await db.prepare('SELECT id FROM supplier_shipments WHERE shipment_no=?').get(shipmentNo)) {
    return res.status(400).json({ error: `進貨單編號 ${shipmentNo} 已存在` });
  }

  // 寫入進貨單 + 關聯採購單推進 + 自動入庫驅動庫存（同一交易，任一失敗整筆回滾）
  const id = await db.transaction(async (tx) => {
    if (!str(b.shipment_no)) shipmentNo = await nextSerial(tx, 'supplier_shipment_no_prefix', 'supplier_shipment_no_seq', 'SPS');
    if (await tx.prepare('SELECT id FROM supplier_shipments WHERE shipment_no=?').get(shipmentNo)) throw Object.assign(new Error(`進貨單編號 ${shipmentNo} 已存在`), { status: 400 });
    const _id = (await tx.prepare(
      `INSERT INTO supplier_shipments (shipment_no, supplier_id, order_id, ship_date, qty, invoice_no, invoice_date, note, created_by, product_id, unit_cost, batch_no, serials, order_item_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      shipmentNo, supplierId,
      b.order_id ? Number(b.order_id) : null,
      str(b.ship_date) || toDateStr(new Date()),
      num(b.qty, 0),
      str(b.invoice_no), str(b.invoice_date), str(b.note), req.user.id,
      b.product_id ? Number(b.product_id) : null,
      num(b.unit_cost, 0),
      str(b.batch_no), str(b.serials), receipt?.itemId || null
    )).lastInsertRowid;
    if (receipt) await refreshOrderStatus(receipt.orderId, tx);
    if (b.product_id) {
      await inv.recordReceipt({
        productId: Number(b.product_id), qty: num(b.qty, 0), unitCost: num(b.unit_cost, 0),
        batchNo: str(b.batch_no), mfgDate: str(b.mfg_date), expDate: str(b.exp_date),
        serials: b.serials, docType: 'receipt', docId: _id, docNo: shipmentNo,
        operator: (req.user && (req.user.emp_id || req.user.name)) || '', note: str(b.note),
      }, tx);
    }
    return _id;
  })();
  audit.log(req, 'supplier_shipment_create', `登錄供應商進貨 ${shipmentNo}`);
  res.status(201).json(await db.prepare(`${SELECT} WHERE sh.id=?`).get(id));
}));

/** PUT /:id 更新 */
router.put('/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM supplier_shipments WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '進貨單不存在' });
  const b = req.body || {};
  const supplierId = b.supplier_id ? Number(b.supplier_id) : cur.supplier_id;
  const shipmentNo = str(b.shipment_no) || cur.shipment_no;
  const dup = await db.prepare('SELECT id FROM supplier_shipments WHERE shipment_no=? AND id<>?').get(shipmentNo, id);
  if (dup) return res.status(400).json({ error: `進貨單編號 ${shipmentNo} 已存在` });
  if (await db.prepare('SELECT id FROM payable_sources WHERE shipment_id=?').get(id)) return res.status(409).json({ error: '此進貨已結轉應付，請先依會計更正流程處理，不能直接編輯' });
  let receipt;
  try { receipt = await validateReceipt({ ...cur, ...b, order_id: b.order_id === undefined ? cur.order_id : b.order_id, product_id: b.product_id === undefined ? cur.product_id : b.product_id, qty: b.qty === undefined ? cur.qty : b.qty }, supplierId, db, id); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  const result = await db.transaction(async (tx) => {
    await inv.reverseDoc('receipt', id, tx);
    const values = [
      shipmentNo, supplierId, b.order_id === undefined ? cur.order_id : (Number(b.order_id) || null),
      str(b.ship_date) || cur.ship_date,
      b.qty === undefined ? cur.qty : num(b.qty, 0),
      b.invoice_no === undefined ? cur.invoice_no : str(b.invoice_no),
      b.invoice_date === undefined ? cur.invoice_date : str(b.invoice_date),
      b.note === undefined ? cur.note : str(b.note),
      b.product_id !== undefined ? (Number(b.product_id) > 0 ? Number(b.product_id) : null) : cur.product_id,
      b.unit_cost === undefined ? cur.unit_cost : num(b.unit_cost, 0),
      b.batch_no !== undefined ? str(b.batch_no) : cur.batch_no,
      b.serials !== undefined ? str(b.serials) : cur.serials,
    ];
    if (values[8]) {
      await inv.recordReceipt({
        productId: values[8], qty: values[4], unitCost: values[9], batchNo: values[10],
        mfgDate: b.mfg_date === undefined ? cur.mfg_date : str(b.mfg_date),
        expDate: b.exp_date === undefined ? cur.exp_date : str(b.exp_date),
        serials: b.serials === undefined ? cur.serials : b.serials,
        docType: 'receipt', docId: id, docNo: shipmentNo,
        operator: (req.user && (req.user.emp_id || req.user.name)) || '', note: values[7],
      }, tx);
    }
    await tx.prepare(
      `UPDATE supplier_shipments SET shipment_no=?, supplier_id=?, order_id=?, ship_date=?, qty=?, invoice_no=?, invoice_date=?, note=?, product_id=?, unit_cost=?, batch_no=?, serials=?, order_item_id=? WHERE id=?`
    ).run(...values, receipt?.itemId || null, id);
    await refreshOrderStatus(cur.order_id, tx);
    if (values[2] && values[2] !== cur.order_id) await refreshOrderStatus(values[2], tx);
    return shipmentNo;
  })();
  audit.log(req, 'supplier_shipment_update', `更新供應商進貨 ${result}`);
  res.json(await db.prepare(`${SELECT} WHERE sh.id=?`).get(id));
}));
/** DELETE /:id 刪除 */
router.delete('/:id', requireManager, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM supplier_shipments WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '進貨單不存在' });
  if (await db.prepare('SELECT id FROM payable_sources WHERE shipment_id=?').get(id)) return res.status(409).json({ error: '此進貨已結轉應付，請先依會計更正流程處理，不能直接刪除' });
  await db.transaction(async (tx) => {
    await inv.reverseDoc('receipt', id, tx);
    await tx.prepare('DELETE FROM supplier_shipments WHERE id=?').run(id);
    await refreshOrderStatus(cur.order_id, tx);
  })();
  audit.log(req, 'supplier_shipment_delete', `刪除供應商進貨 ${cur.shipment_no}`);
  res.json({ ok: true });
}));
module.exports = router;
