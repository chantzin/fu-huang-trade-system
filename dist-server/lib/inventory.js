// @ts-nocheck
'use strict';
/**
 * 庫存核心邏輯（P1/P2/P4/P5，2026-09-23）
 *
 * 設計原則：
 *   - 本模組只執行「純陳述句」，不自行開交易；交易由呼叫方（route）用 db.transaction 包住，
 *     以避免 better-sqlite3 巢狀交易（SAVEPOINT）問題。
 *   - 庫存唯一真相來源 = products.stock_qty；所有異動都寫入 stock_transactions 日記帳。
 *   - 成本採「移動加權平均」：每次入庫後 cost_unit = (舊量×舊成本 + 新量×新成本) / 新量。
 *
 * 依賴：db-dual（primary=SQLite 同步；failover 關閉下零回歸）。
 */
const { db } = require('./db-dual');

/** 解析序號清單：支援陣列 / 逗號 / 換行分隔的字串 */
function parseSerials(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v)
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function getProduct(id) {
  return db.prepare('SELECT * FROM products WHERE id=?').get(id);
}

/** 建立期初庫存：僅允許零庫存、無既有異動的產品，並以正式日記帳過帳。 */
async function initializeStock({ productId, qty, unitCost, batchNo, mfgDate, expDate, serials, operator, note }, executor = db) {
  const p = await executor.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!p) throw new Error('產品不存在');
  if (Number(p.active) !== 1) throw new Error('停用產品不能建立期初庫存');
  if (Number(p.stock_qty) !== 0) throw new Error('產品目前庫存不為 0，不能建立期初庫存');
  const history = await executor.prepare('SELECT COUNT(*) AS n FROM stock_transactions WHERE product_id=?').get(productId);
  if (Number(history && history.n) > 0) throw new Error('產品已有庫存日記帳，不能重複建立期初庫存');
  const lots = await executor.prepare('SELECT COUNT(*) AS n FROM stock_lots WHERE product_id=?').get(productId);
  const serialRows = await executor.prepare('SELECT COUNT(*) AS n FROM stock_serials WHERE product_id=?').get(productId);
  if (Number(lots && lots.n) > 0 || Number(serialRows && serialRows.n) > 0) {
    throw new Error('產品已有批號或序號紀錄，不能建立期初庫存');
  }
  const q = Number(qty);
  const cost = Number(unitCost);
  if (!Number.isFinite(q) || q <= 0) throw new Error('期初數量必須大於 0');
  if (!Number.isFinite(cost) || cost < 0) throw new Error('期初單位成本必須為有效的非負數');
  return await recordReceipt({
    productId, qty: q, unitCost: cost, batchNo, mfgDate, expDate, serials,
    docType: 'opening_balance', docId: productId, docNo: `OPEN-${p.part_no}`,
    operator, note: note || '期初庫存建帳',
  }, executor);
}

/**
 * 收貨入庫（P1 + P2 成本 + P4 批號/序號）
 * 回傳 { stxId, newQty, newCost }
 */
async function recordReceipt({ productId, qty, unitCost, batchNo, mfgDate, expDate, serials, docType, docId, docNo, operator, note }, executor = db) {
  const p = await executor.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!p) throw new Error('產品不存在');
  const q = Number(qty) || 0;
  if (q <= 0) throw new Error('入庫數量必須大於 0');
  const cost = Number(unitCost) || 0;

  const oldQty = Number(p.stock_qty) || 0;
  const oldCost = Number(p.cost_unit) || 0;
  const newQty = oldQty + q;
  // 移動加權平均成本（P2）
  const newCost = newQty > 0 ? (oldQty * oldCost + q * cost) / newQty : cost;
  await executor.prepare("UPDATE products SET stock_qty=?, cost_unit=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(newQty, newCost, productId);

  let lotId = null;
  if (batchNo) {
    const lot = await executor.prepare('SELECT * FROM stock_lots WHERE product_id=? AND batch_no=?').get(productId, batchNo);
    if (lot) {
      await executor.prepare("UPDATE stock_lots SET qty=qty+?, unit_cost=?, exp_date=COALESCE(?,exp_date), updated_at=datetime('now','localtime') WHERE id=?")
        .run(q, cost, expDate || null, lot.id);
      lotId = lot.id;
    } else {
      lotId = (await executor.prepare(
        `INSERT INTO stock_lots (product_id, batch_no, qty, unit_cost, mfg_date, exp_date, received_doc_id, received_doc_no)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(productId, batchNo, q, cost, mfgDate || null, expDate || null, docId || null, docNo || null)).lastInsertRowid;
    }
  }

  let serialIds = null;
  const ser = parseSerials(serials);
  if (ser.length) {
    if (!Number.isInteger(q) || ser.length !== q) throw new Error('序號數量必須與整數入庫數量一致');
    if (new Set(ser).size !== ser.length) throw new Error('序號清單含重複值');
    serialIds = [];
    const ins = executor.prepare('INSERT INTO stock_serials (product_id, lot_id, serial_no, status) VALUES (?,?,?, \'in\')');
    for (const s of ser) {
      const sid = (await ins.run(productId, lotId, s)).lastInsertRowid;
      serialIds.push(sid);
    }
    serialIds = JSON.stringify(serialIds);
  }

  const cur = await executor.prepare('SELECT stock_qty, cost_unit FROM products WHERE id=?').get(productId);
  const stxId = (await executor.prepare(
    `INSERT INTO stock_transactions (product_id, doc_type, doc_id, doc_no, direction, qty, unit_cost, balance_qty, balance_cost, lot_id, serial_ids, note, operator)
     VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?)`
  ).run(
    productId, docType || 'receipt', docId || null, docNo || null, q, cost,
    cur.stock_qty, cur.cost_unit, lotId, serialIds, note || '', operator || ''
  )).lastInsertRowid;
  return { stxId, newQty: cur.stock_qty, newCost: cur.cost_unit };
}

/**
 * 出貨扣庫（P1 + P4 批號/序號消耗）
 * 優先序：指定序號 > 指定批號 > FIFO 自動消耗批號
 * 回傳 { stxId, newQty }
 */
function recordOutbound({ productId, qty, batchNo, serials, docType, docId, docNo, operator, note }) {
  const p = getProduct(productId);
  if (!p) throw new Error('產品不存在');
  const q = Number(qty) || 0;
  if (q <= 0) throw new Error('出貨數量必須大於 0');
  const curQty = Number(p.stock_qty) || 0;
  if (curQty < q) throw new Error(`庫存不足：現有 ${curQty}，欲出 ${q}`);

  const cost = Number(p.cost_unit) || 0;
  let remaining = q;
  let usedLotId = null;
  let usedSerialIds = null;
  const lotSlices = [];

  const ser = parseSerials(serials);
  if (ser.length) {
    if (!Number.isInteger(q) || ser.length !== q) throw new Error('序號數量必須與整數出貨數量一致');
    if (new Set(ser).size !== ser.length) throw new Error('序號清單含重複值');
    usedSerialIds = [];
    const up = db.prepare("UPDATE stock_serials SET status='out', outbound_doc_id=?, outbound_doc_no=?, updated_at=datetime('now','localtime') WHERE id=? AND status='in'");
    for (const sidRaw of ser) {
      const serialNo = String(sidRaw).trim();
      const row = db.prepare("SELECT * FROM stock_serials WHERE product_id=? AND serial_no=? AND status='in'").get(productId, serialNo);
      if (!row) throw new Error(`序號 ${serialNo} 不可用：不存在、產品不符或已出庫`);
      up.run(docId || null, docNo || null, row.id);
      usedSerialIds.push(row.id);
      if (row.lot_id) {
        const lotUpdate = db.prepare('UPDATE stock_lots SET qty=qty-1, updated_at=datetime(\'now\',\'localtime\') WHERE id=? AND qty>0').run(row.lot_id);
        if (lotUpdate.changes !== 1) throw new Error(`序號 ${serialNo} 對應批號庫存不足，請先對帳`);
        lotSlices.push({ lotId: row.lot_id, qty: 1 });
      }
      remaining -= 1;
    }
    if (remaining !== 0) throw new Error('序號數量必須與出貨數量一致');
    usedSerialIds = JSON.stringify(usedSerialIds);
  } else if (batchNo) {
    const lot = db.prepare('SELECT * FROM stock_lots WHERE product_id=? AND batch_no=?').get(productId, batchNo);
    if (!lot) throw new Error(`找不到批號 ${batchNo}`);
    if (Number(lot.qty) < q) throw new Error(`批號 ${batchNo} 庫存不足：現有 ${lot.qty}，欲出 ${q}`);
    db.prepare('UPDATE stock_lots SET qty=qty-?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(q, lot.id);
    usedLotId = lot.id;
    lotSlices.push({ lotId: lot.id, qty: q });
    remaining = 0;
  } else {
    // FIFO：舊批先出
    const lots = db.prepare('SELECT * FROM stock_lots WHERE product_id=? AND qty>0 ORDER BY id ASC').all(productId);
    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(lot.qty));
      db.prepare('UPDATE stock_lots SET qty=qty-?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(take, lot.id);
      remaining -= take;
      if (take > 0) lotSlices.push({ lotId: lot.id, qty: take });
      if (!usedLotId) usedLotId = lot.id;
    }
    // remaining>0 表示無批號庫存可扣，仍直接扣主檔（允許負批號追蹤外的存量調整）
  }

  const newQty = curQty - q;
  db.prepare("UPDATE products SET stock_qty=?, updated_at=datetime('now','localtime') WHERE id=?").run(newQty, productId);

  const stxId = db.prepare(
    `INSERT INTO stock_transactions (product_id, doc_type, doc_id, doc_no, direction, qty, unit_cost, balance_qty, balance_cost, lot_id, serial_ids, note, operator)
     VALUES (?,?,?,?,-1,?,?,?,?,?,?,?,?)`
  ).run(
    productId, docType || 'shipment', docId || null, docNo || null, q, cost,
    newQty, cost, usedLotId, usedSerialIds, note || '', operator || ''
  ).lastInsertRowid;
  // Keep every lot slice so FIFO reversal can restore the original batches exactly.
  const insertSlice = db.prepare('INSERT INTO stock_transaction_lots (transaction_id, lot_id, qty) VALUES (?,?,?)');
  for (const slice of lotSlices) insertSlice.run(stxId, slice.lotId, slice.qty);
  return { stxId, newQty };
}

/** 手動調整（盤盈/盤虧/矯正）；delta 為帶符號異動量 */
function adjustStock({ productId, delta, reason, operator, note }) {
  const p = getProduct(productId);
  if (!p) throw new Error('產品不存在');
  const d = Number(delta) || 0;
  const curQty = Number(p.stock_qty) || 0;
  const newQty = curQty + d;
  if (newQty < 0) throw new Error('調整後庫存不可為負');
  const cost = Number(p.cost_unit) || 0;
  const stxId = db.prepare(
    `INSERT INTO stock_transactions (product_id, doc_type, doc_id, doc_no, direction, qty, unit_cost, balance_qty, balance_cost, note, operator)
     VALUES (?, 'adjust', NULL, ?, 0, ?, ?, ?, ?, ?, ?)`
  ).run(productId, reason || 'adjust', d, cost, newQty, cost, note || '', operator || '').lastInsertRowid;
  db.prepare("UPDATE products SET stock_qty=?, updated_at=datetime('now','localtime') WHERE id=?").run(newQty, productId);
  return { stxId, newQty };
}

/**
 * 反向沖銷某單據產生的所有庫存異動（刪除/作廢時復原）
 * 復原：主檔庫存、序號狀態、批號數量、並刪除日記帳列。
 */
async function reverseDoc(docType, docId, executor = db) {
  const rows = await executor.prepare('SELECT * FROM stock_transactions WHERE doc_type=? AND doc_id=? AND reversed_by IS NULL ORDER BY id DESC').all(docType, docId);
  if (!rows.length) return;
  for (const stx of rows) {
    const p = await executor.prepare('SELECT * FROM products WHERE id=?').get(stx.product_id);
    if (p) {
      const newQty = (Number(p.stock_qty) || 0) - stx.direction * stx.qty;
      if (newQty < -0.0000001) throw new Error(`無法沖銷庫存異動 #${stx.id}：現有庫存不足，請先處理後續出貨/調整`);
      let newCost = Number(p.cost_unit) || 0;
      if (stx.direction === 1) {
        const remainingValue = (Number(p.stock_qty) || 0) * newCost - Number(stx.qty) * Number(stx.unit_cost || 0);
        newCost = newQty > 0 ? Math.max(0, remainingValue / newQty) : 0;
      }
      await executor.prepare("UPDATE products SET stock_qty=?, cost_unit=?, updated_at=datetime('now','localtime') WHERE id=?").run(Math.max(0, newQty), newCost, stx.product_id);
    }
    if (stx.serial_ids) {
      let ids = [];
      try { ids = JSON.parse(stx.serial_ids); } catch { /* ignore */ }
      for (const sid of ids) {
        if (stx.direction === 1) {
          await executor.prepare('DELETE FROM stock_serials WHERE id=?').run(sid);
        } else {
          await executor.prepare("UPDATE stock_serials SET status='in', outbound_doc_id=NULL, outbound_doc_no=NULL, updated_at=datetime('now','localtime') WHERE id=?").run(sid);
        }
      }
    }
    if (stx.direction === 1 && stx.lot_id) {
      const lot = await executor.prepare('SELECT qty FROM stock_lots WHERE id=?').get(stx.lot_id);
      if (!lot || Number(lot.qty) + 0.0000001 < Number(stx.qty)) throw new Error(`無法沖銷異動 #${stx.id}：原批號庫存不足`);
      await executor.prepare('UPDATE stock_lots SET qty=qty-?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(stx.qty, stx.lot_id);
    } else if (stx.direction === -1) {
      const slices = await executor.prepare('SELECT lot_id, qty FROM stock_transaction_lots WHERE transaction_id=?').all(stx.id);
      for (const slice of slices) {
        await executor.prepare('UPDATE stock_lots SET qty=qty+?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(slice.qty, slice.lot_id);
      }
      // Backward compatibility for outbound rows created before lot allocations existed.
      if (!slices.length && stx.lot_id) {
        await executor.prepare('UPDATE stock_lots SET qty=qty+?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?').run(stx.qty, stx.lot_id);
      }
    }
    const balance = await executor.prepare('SELECT stock_qty, cost_unit FROM products WHERE id=?').get(stx.product_id);
    const reversalId = (await executor.prepare(
      `INSERT INTO stock_transactions (product_id, doc_type, doc_id, doc_no, direction, qty, unit_cost, balance_qty, balance_cost, lot_id, serial_ids, note, operator)
       VALUES (?, 'reversal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(stx.product_id, stx.id, stx.doc_no, -stx.direction, stx.qty, stx.unit_cost,
      balance?.stock_qty || 0, balance?.cost_unit || 0,
      stx.lot_id, stx.serial_ids, `沖銷異動 #${stx.id}`, stx.operator || '')).lastInsertRowid;
    await executor.prepare('UPDATE stock_transactions SET reversed_by=? WHERE id=?').run(reversalId, stx.id);
  }
}

module.exports = { parseSerials, getProduct, initializeStock, recordReceipt, recordOutbound, adjustStock, reverseDoc };
