'use strict';
/** 出貨與單據管理（出貨日、出貨單號、進口報單、發票號碼） */
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db, DATA_DIR } = require('../lib/db-dual');
const { requireAuth, requireManager } = require('../lib/auth');
const audit = require('../lib/audit');
const { num, str, toDateStr, nextSerial } = require('../lib/util');
const inv = require('../lib/inventory');
const receivablesRoute = require('./receivables'); // A1：出貨自動產生應收（共用 ensureReceivableForOrder）

const router = express.Router();
router.use(requireAuth);

const UPLOAD_DIR = path.join(DATA_DIR, '_uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const safe = String(file.originalname || 'file').replace(/[^\w.\-一-龥]/g, '_');
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const SELECT = `SELECT sh.*, o.order_no, o.customer_id, c.name AS customer_name, u.name AS created_by_name
                  FROM shipments sh
                  JOIN orders o ON o.id = sh.order_id
                  LEFT JOIN customers c ON c.id = o.customer_id
                  LEFT JOIN users u ON u.id = sh.created_by`;

router.get('/', (req, res) => {
  const q = req.query || {};
  const cond = [];
  const args = [];
  if (q.order_id) { cond.push('sh.order_id = ?'); args.push(Number(q.order_id)); }
  if (q.customer_id) { cond.push('o.customer_id = ?'); args.push(Number(q.customer_id)); }
  if (q.date_from) { cond.push('sh.ship_date >= ?'); args.push(q.date_from); }
  if (q.date_to) { cond.push('sh.ship_date <= ?'); args.push(q.date_to); }
  if (q.keyword) {
    cond.push('(sh.shipment_no LIKE ? OR sh.declaration_no LIKE ? OR sh.invoice_no LIKE ? OR o.order_no LIKE ?)');
    args.push(...Array(4).fill(`%${q.keyword}%`));
  }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  res.json(db.prepare(`${SELECT} ${where} ORDER BY sh.ship_date DESC, sh.id DESC LIMIT 500`).all(...args));
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const orderId = Number(b.order_id);
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!o) return res.status(404).json({ error: '訂單不存在' });
    const shipDate = str(b.ship_date) || toDateStr(new Date());
    const shipmentNo = str(b.shipment_no) || nextSerial('shipment_no_prefix', 'shipment_no_seq', 'SH');

    const info = await db.transaction(() => {
      const _info = db.prepare(
        `INSERT INTO shipments (shipment_no, order_id, ship_date, qty, declaration_no, invoice_no, invoice_date, file_path, note, created_by, product_id, batch_no, serials)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        shipmentNo, orderId, shipDate, num(b.qty), str(b.declaration_no), str(b.invoice_no),
        str(b.invoice_date) || null, str(b.file_path) || null, str(b.note), req.user.id,
        b.product_id ? Number(b.product_id) : null, str(b.batch_no), str(b.serials)
      );
      // 回寫訂單：出貨日（取最近一次）+ 狀態推進
      db.prepare("UPDATE orders SET ship_date=?, updated_at=datetime('now','localtime') WHERE id=?").run(shipDate, orderId);
      if (['draft', 'confirmed'].includes(o.status)) {
        db.prepare("UPDATE orders SET status='shipped', updated_at=datetime('now','localtime') WHERE id=?").run(orderId);
      }
      // 自動出貨扣庫（P1）；庫存不足會 throw → 整筆交易回滾
      if (b.product_id) {
        inv.recordOutbound({
          productId: Number(b.product_id), qty: num(b.qty, 0), batchNo: str(b.batch_no), serials: b.serials,
          docType: 'shipment', docId: _info.lastInsertRowid, docNo: shipmentNo,
          operator: (req.user && (req.user.emp_id || req.user.name)) || '', note: str(b.note),
        });
      }
      // A2：出貨自動產生「該批」應收（與扣庫同一交易，任一失敗整筆回滾；依該批出貨日推導帳期、依該批比例分攤金額）
      receivablesRoute.ensureReceivableForShipment(db, _info.lastInsertRowid, req);
      return _info;
    })();
    audit.log(req, 'create', 'shipments', info.lastInsertRowid, shipmentNo);
    res.json(db.prepare(`${SELECT} WHERE sh.id=?`).get(info.lastInsertRowid));
  } catch (e) { next(e); }
});

/** 上傳進口報單／發票檔案 */
router.post('/:id/file', upload.single('file'), (req, res) => {
  const id = Number(req.params.id);
  const sh = db.prepare('SELECT * FROM shipments WHERE id=?').get(id);
  if (!sh) return res.status(404).json({ error: '出貨紀錄不存在' });
  if (!req.file) return res.status(400).json({ error: '未收到檔案' });
  const rel = path.join('_uploads', req.file.filename).replace(/\\/g, '/');
  db.prepare('UPDATE shipments SET file_path=? WHERE id=?').run(rel, id);
  audit.log(req, 'upload', 'shipments', id, req.file.originalname);
  res.json({ ok: true, file_path: rel, filename: req.file.originalname });
});

router.get('/file/:name', (req, res) => {
  const name = path.basename(String(req.params.name || ''));
  const p = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(p)) return res.status(404).json({ error: '檔案不存在' });
  res.download(p);
});

router.put('/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const cur = db.prepare('SELECT * FROM shipments WHERE id=?').get(id);
    if (!cur) return res.status(404).json({ error: '出貨紀錄不存在' });
    if (cur.approval_status === 'pending' || cur.approval_status === 'approved') {
      return res.status(409).json({ error: '出貨單已送簽核，不可修改（退回後才可改）' });
    }
    const b = req.body || {};
    const updated = await db.transaction(async (tx) => {
      await inv.reverseDoc('shipment', id, tx);
      const values = [
        b.shipment_no !== undefined ? str(b.shipment_no) : cur.shipment_no,
        b.ship_date !== undefined ? str(b.ship_date) : cur.ship_date,
        b.qty !== undefined ? num(b.qty, cur.qty) : cur.qty,
        b.declaration_no !== undefined ? str(b.declaration_no) : cur.declaration_no,
        b.invoice_no !== undefined ? str(b.invoice_no) : cur.invoice_no,
        b.invoice_date !== undefined ? str(b.invoice_date) || null : cur.invoice_date,
        b.note !== undefined ? str(b.note) : cur.note,
        b.product_id !== undefined ? (Number(b.product_id) > 0 ? Number(b.product_id) : null) : cur.product_id,
        b.batch_no !== undefined ? str(b.batch_no) : cur.batch_no,
        b.serials !== undefined ? str(b.serials) : cur.serials,
        id,
      ];
      const effProduct = values[7];
      const effQty = values[2];
      if (effProduct) {
        inv.recordOutbound({
          productId: effProduct, qty: effQty, batchNo: values[8], serials: b.serials !== undefined ? b.serials : cur.serials,
          docType: 'shipment', docId: id, docNo: values[0],
          operator: (req.user && (req.user.emp_id || req.user.name)) || '', note: values[6],
        });
      }
      await tx.prepare(
        `UPDATE shipments SET shipment_no=?, ship_date=?, qty=?, declaration_no=?, invoice_no=?, invoice_date=?, note=?, product_id=?, batch_no=?, serials=? WHERE id=?`
      ).run(...values);
      // A2：出貨異動（數量/出貨日/產品）後以該批最新金額重算應收（同一交易）
      receivablesRoute.ensureReceivableForShipment(db, id, req);
      return values[0];
    })();
    audit.log(req, 'update', 'shipments', id, updated);
    res.json(db.prepare(`${SELECT} WHERE sh.id=?`).get(id));
  } catch (e) { next(e); }
});
router.delete('/:id', requireManager, async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const sh = db.prepare('SELECT * FROM shipments WHERE id=?').get(id);
    if (!sh) return res.status(404).json({ error: '出貨紀錄不存在' });
    if (sh.approval_status === 'pending' || sh.approval_status === 'approved') {
      return res.status(409).json({ error: '出貨單已送簽核，不可刪除（退回後才可刪）' });
    }
    await db.transaction(async (tx) => {
      await inv.reverseDoc('shipment', id, tx);
      await tx.prepare('DELETE FROM shipments WHERE id=?').run(id);
    })();
    audit.log(req, 'delete', 'shipments', id, sh.shipment_no);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
module.exports = router;
