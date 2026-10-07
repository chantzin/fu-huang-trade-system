'use strict';
/**
 * 應付帳款（Payable，供應鏈）
 * 對供應商的應付管理：應付單號／供應商／發票／金額／到期日／付款狀態。
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireManager } = require('../lib/auth');
const audit = require('../lib/audit');
const { num, str, toDateStr } = require('../lib/util');
const { nextSerial } = require('../lib/serial-dual');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();
router.use(requireAuth);

const SELECT = `SELECT p.*, s.name AS supplier_name, s.code AS supplier_code
                FROM payables p
                LEFT JOIN suppliers s ON s.id = p.supplier_id`;
const invoiceKey = (v) => String(v || '').trim().toUpperCase();
const closed = async (month) => !!(await db.prepare("SELECT id FROM accounting_periods WHERE module='payables' AND period_month=? AND status='closed'").get(month));
async function payableWithBalance(row) {
  if (!row) return row;
  const payments = await db.prepare('SELECT COALESCE(SUM(amount),0) AS paid, MAX(payment_date) AS paid_date FROM payable_payments WHERE payable_id=? AND reversed_payment_id IS NULL').get(row.id);
  const paid = Number(payments?.paid || 0);
  return { ...row, paid_amount: paid, paid_date: payments?.paid_date || row.paid_date, status: paid + 1e-9 >= Number(row.amount) ? 'paid' : paid > 0 ? 'partial' : 'pending' };
}

/** GET / 列表（可篩選） */
router.get('/', wrap(async (req, res) => {
  const q = req.query || {};
  const cond = [];
  const args = [];
  if (q.keyword) {
    cond.push('(p.payable_no LIKE ? OR p.invoice_no LIKE ? OR s.name LIKE ? OR p.note LIKE ?)');
    args.push(...Array(4).fill(`%${q.keyword}%`));
  }
  if (q.supplier_id) { cond.push('p.supplier_id = ?'); args.push(Number(q.supplier_id)); }
  if (q.status) { cond.push('p.status = ?'); args.push(str(q.status)); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = await db.prepare(`${SELECT} ${where} ORDER BY p.due_date DESC, p.id DESC`).all(...args);
  res.json(await Promise.all(rows.map(payableWithBalance)));
}));

/** POST / 新增 */
router.post('/', wrap(async (req, res) => {
  const b = req.body || {};
  const supplierId = b.supplier_id ? Number(b.supplier_id) : null;
  if (!supplierId) return res.status(400).json({ error: '請選擇供應商' });
  const sup = await db.prepare('SELECT * FROM suppliers WHERE id=?').get(supplierId);
  if (!sup) return res.status(404).json({ error: '供應商不存在' });

  let payableNo = str(b.payable_no);
  if (payableNo && await db.prepare('SELECT id FROM payables WHERE payable_no=?').get(payableNo)) {
    return res.status(400).json({ error: `應付單編號 ${payableNo} 已存在` });
  }

  const amount = num(b.amount, 0);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: '應付金額必須大於 0' });
  const invKey = invoiceKey(b.invoice_no);
  if (invKey && await db.prepare('SELECT id FROM payables WHERE supplier_id=? AND (invoice_key=? OR UPPER(TRIM(invoice_no))=?)').get(supplierId, invKey, invKey)) return res.status(409).json({ error: '同一供應商已存在相同發票號碼的應付帳款' });
  const currency = str(b.currency, 'TWD').toUpperCase() || 'TWD';
  const exchangeRate = num(b.exchange_rate, 1);
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) return res.status(400).json({ error: '匯率必須大於 0' });
  const payableMonth = str(b.payable_month) || (str(b.invoice_date) || toDateStr(new Date())).slice(0, 7);
  if (await closed(payableMonth)) return res.status(409).json({ error: `應付期間 ${payableMonth} 已關帳` });

  let id;
  try {
    id = await db.transaction(async (tx) => {
      if (!payableNo) payableNo = await nextSerial(tx, 'payable_no_prefix', 'payable_no_seq', 'AP');
      if (await tx.prepare('SELECT id FROM payables WHERE payable_no=?').get(payableNo)) throw Object.assign(new Error(`應付單編號 ${payableNo} 已存在`), { status: 400 });
      return (await tx.prepare(
        `INSERT INTO payables (payable_no, supplier_id, invoice_no, invoice_date, billing_month, payable_month,
            amount, due_date, paid_amount, paid_date, status, note, created_by, currency, exchange_rate, amount_base, invoice_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        payableNo, supplierId, str(b.invoice_no),
        str(b.invoice_date) || toDateStr(new Date()),
        b.billing_month || (str(b.invoice_date) || toDateStr(new Date())).slice(0, 7),
        payableMonth, amount, str(b.due_date), 0, '', 'pending', str(b.note), req.user.id,
        currency, exchangeRate, Math.round(amount * exchangeRate), invKey || null
      )).lastInsertRowid;
    })();
  } catch (e) {
    if (e && !e.status && /constraint/i.test(String(e.message))) return res.status(409).json({ error: '同一供應商已存在相同發票號碼的應付帳款' });
    throw e;
  }
  audit.log(req, 'payable_create', `建立應付帳款 ${payableNo}`);
  res.status(201).json(await payableWithBalance(await db.prepare(`${SELECT} WHERE p.id=?`).get(id)));
}));

/** PUT /:id 更新（含付款登錄） */
router.put('/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM payables WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '應付帳款不存在' });
  const b = req.body || {};
  if (b.paid_amount !== undefined || b.paid_date !== undefined || b.status !== undefined) return res.status(400).json({ error: '付款累計、付款日期與狀態由付款明細自動計算，請使用「新增付款」' });
  const supplierId = b.supplier_id ? Number(b.supplier_id) : cur.supplier_id;

  const payableNo = str(b.payable_no) || cur.payable_no;
  const dup = await db.prepare('SELECT id FROM payables WHERE payable_no=? AND id<>?').get(payableNo, id);
  if (dup) return res.status(400).json({ error: `應付單編號 ${payableNo} 已存在` });

  const amount = b.amount === undefined ? cur.amount : num(b.amount, 0);
  const month = b.payable_month === undefined ? cur.payable_month : str(b.payable_month);
  if (await closed(cur.payable_month) || await closed(month)) return res.status(409).json({ error: '應付期間已關帳，不可修改' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: '應付金額必須大於 0' });
  const invNo = b.invoice_no === undefined ? cur.invoice_no : str(b.invoice_no);
  const invKey = invoiceKey(invNo);
  if (invKey && await db.prepare('SELECT id FROM payables WHERE supplier_id=? AND (invoice_key=? OR UPPER(TRIM(invoice_no))=?) AND id<>?').get(supplierId, invKey, invKey, id)) return res.status(409).json({ error: '同一供應商已存在相同發票號碼的應付帳款' });
  const paidRow = await db.prepare('SELECT COALESCE(SUM(amount),0) AS paid FROM payable_payments WHERE payable_id=? AND reversed_payment_id IS NULL').get(id);
  const paid = Number(paidRow?.paid || 0);
  if (amount < paid) return res.status(409).json({ error: '應付金額不可低於已記錄付款總額' });

  try {
    await db.prepare(
      `UPDATE payables SET payable_no=?, supplier_id=?, invoice_no=?, invoice_date=?, billing_month=?, payable_month=?,
          amount=?, due_date=?, note=?, currency=?, exchange_rate=?, amount_base=?, invoice_key=?, updated_at=datetime('now','localtime')
       WHERE id=?`
    ).run(
      payableNo, supplierId,
      invNo,
      b.invoice_date !== undefined ? str(b.invoice_date) || null : cur.invoice_date,
      b.billing_month !== undefined ? str(b.billing_month) || null : cur.billing_month,
      month || null,
      amount, str(b.due_date) || cur.due_date,
      b.note === undefined ? cur.note : str(b.note),
      str(b.currency, cur.currency || 'TWD').toUpperCase() || 'TWD',
      num(b.exchange_rate, cur.exchange_rate || 1), Math.round(amount * num(b.exchange_rate, cur.exchange_rate || 1)), invKey || null, id
    );
  } catch (e) {
    if (e && /constraint/i.test(String(e.message))) return res.status(409).json({ error: '同一供應商已存在相同發票號碼的應付帳款' });
    throw e;
  }
  audit.log(req, 'payable_update', `更新應付帳款 ${payableNo}`);
  res.json(await payableWithBalance(await db.prepare(`${SELECT} WHERE p.id=?`).get(id)));
}));

/** 逐筆付款；已付金額由付款流水彙總，不接受負數、超付或回寫關帳月份。 */
router.get('/:id/payments', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!await db.prepare('SELECT id FROM payables WHERE id=?').get(id)) return res.status(404).json({ error: '應付帳款不存在' });
  res.json(await db.prepare('SELECT * FROM payable_payments WHERE payable_id=? ORDER BY payment_date,id').all(id));
}));
router.post('/:id/payments', wrap(async (req, res) => {
  const id = Number(req.params.id), b = req.body || {};
  const requestKey = str(b.idempotency_key);
  if (requestKey) {
    const prior = await db.prepare('SELECT * FROM payable_payments WHERE idempotency_key=?').get(requestKey);
    if (prior) return res.json(prior);
  }
  const payable = await db.prepare('SELECT * FROM payables WHERE id=?').get(id);
  if (!payable) return res.status(404).json({ error: '應付帳款不存在' });
  const amount = Number(b.amount), rate = Number(b.exchange_rate || 1), date = str(b.payment_date) || toDateStr(new Date());
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: '付款金額必須大於 0' });
  if (!Number.isFinite(rate) || rate <= 0) return res.status(400).json({ error: '付款匯率必須大於 0' });
  if (await closed(date.slice(0,7))) return res.status(409).json({ error: `付款月份 ${date.slice(0,7)} 已關帳` });
  const paidRow = await db.prepare('SELECT COALESCE(SUM(amount),0) AS paid FROM payable_payments WHERE payable_id=? AND reversed_payment_id IS NULL').get(id);
  const paid = Number(paidRow?.paid || 0);
  if (paid + amount > Number(payable.amount) + 1e-9) return res.status(409).json({ error: `付款超過未付餘額 ${Math.max(0, Number(payable.amount)-paid)}` });
  const currency = str(b.currency, payable.currency || 'TWD').toUpperCase() || 'TWD';
  if (currency !== String(payable.currency || 'TWD').toUpperCase()) return res.status(400).json({ error: '付款幣別需與應付幣別相同，跨幣別結清須走人工覆核流程' });
  let info;
  try {
    info = await db.transaction(async (tx) => {
      // F5：餘額重檢移至交易內，並發付款時依寫鎖順序讀取最新已付，避免兩筆同時通過應用層檢查而超付。
      const paidNow = Number((await tx.prepare('SELECT COALESCE(SUM(amount),0) AS paid FROM payable_payments WHERE payable_id=? AND reversed_payment_id IS NULL').get(id))?.paid || 0);
      if (paidNow + amount > Number(payable.amount) + 1e-9) throw Object.assign(new Error(`付款超過未付餘額 ${Math.max(0, Number(payable.amount)-paidNow)}`), { status: 409, code: 'OVERPAY' });
      const payment = await tx.prepare(`INSERT INTO payable_payments (payable_id,payment_date,amount,currency,exchange_rate,amount_base,method,reference_no,note,created_by,idempotency_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id,date,amount,currency,rate,Math.round(amount*rate),str(b.method),str(b.reference_no),str(b.note),req.user.id,requestKey||null);
      const total = await tx.prepare('SELECT COALESCE(SUM(amount),0) AS paid, MAX(payment_date) AS paid_date FROM payable_payments WHERE payable_id=? AND reversed_payment_id IS NULL').get(id);
      const paidAmount = Number(total?.paid || 0);
      const nextStatus = paidAmount + 1e-9 >= Number(payable.amount) ? 'paid' : paidAmount > 0 ? 'partial' : 'pending';
      await tx.prepare("UPDATE payables SET paid_amount=?,paid_date=?,status=?,updated_at=datetime('now','localtime') WHERE id=?").run(paidAmount,total?.paid_date || '',nextStatus,id);
      return payment;
    })();
  } catch (e) {
    if (e && !e.status && /constraint|超過應付/i.test(String(e.message))) return res.status(409).json({ error: '付款總額超過應付金額，請確認付款金額' });
    throw e;
  }
  audit.log(req, 'payable_payment_create', `應付 ${payable.payable_no} 新增付款 ${amount} ${currency}`);
  res.status(201).json(await db.prepare('SELECT * FROM payable_payments WHERE id=?').get(info.lastInsertRowid));
}));

/** 收貨發票由會計確認實際發票金額、原幣及匯率後轉應付，來源收貨單可追溯。 */
router.post('/from-supplier-shipment/:id', wrap(async (req, res) => {
  const shipment = await db.prepare('SELECT * FROM supplier_shipments WHERE id=?').get(Number(req.params.id));
  if (!shipment) return res.status(404).json({ error: '進貨單不存在' });
  if (!str(shipment.invoice_no)) return res.status(400).json({ error: '進貨單尚未填寫發票號碼' });
  const b = req.body || {}, amount = Number(b.amount), rate = Number(b.exchange_rate || 1);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(rate) || rate <= 0) return res.status(400).json({ error: '須確認正確的發票金額與匯率' });
  const key = invoiceKey(shipment.invoice_no);
  const existing = await db.prepare('SELECT id FROM payables WHERE supplier_id=? AND (invoice_key=? OR UPPER(TRIM(invoice_no))=?)').get(shipment.supplier_id,key,key);
  if (existing) {
    const linked = await db.prepare('SELECT id FROM payable_sources WHERE payable_id=? AND shipment_id=?').get(existing.id,shipment.id);
    if (linked) return res.json(await payableWithBalance(await db.prepare(`${SELECT} WHERE p.id=?`).get(existing.id)));
    return res.status(409).json({ error: '此供應商發票已建立應付，但未關聯本進貨單；請先核對既有應付' });
  }
  const month = (str(b.invoice_date) || shipment.invoice_date || shipment.ship_date || toDateStr(new Date())).slice(0,7);
  if (await closed(month)) return res.status(409).json({ error: `應付期間 ${month} 已關帳` });
  const sources = await db.prepare('SELECT id FROM supplier_shipments WHERE supplier_id=? AND UPPER(TRIM(invoice_no))=? ORDER BY id').all(shipment.supplier_id,key);
  for (const source of sources) if (await db.prepare('SELECT id FROM payable_sources WHERE shipment_id=?').get(source.id)) return res.status(409).json({ error: '同張發票部分進貨已結轉，請先核對既有應付' });
  const sup = await db.prepare('SELECT id FROM suppliers WHERE id=?').get(shipment.supplier_id);
  let payableNo = str(b.payable_no);
  const currency = str(b.currency,'TWD').toUpperCase() || 'TWD';
  let info;
  try {
    info = await db.transaction(async (tx) => {
      if (!payableNo) payableNo = await nextSerial(tx, 'payable_no_prefix','payable_no_seq','AP');
      if (await tx.prepare('SELECT id FROM payables WHERE payable_no=?').get(payableNo)) throw Object.assign(new Error(`應付單編號 ${payableNo} 已存在`), { status: 400 });
      const p = await tx.prepare(`INSERT INTO payables (payable_no,supplier_id,invoice_no,invoice_date,billing_month,payable_month,amount,due_date,paid_amount,paid_date,status,note,created_by,currency,exchange_rate,amount_base,invoice_key)
        VALUES (?,?,?,?,?,?,?,?,0,'','pending',?,?,?,?,?,?)`).run(payableNo,sup.id,shipment.invoice_no,str(b.invoice_date)||shipment.invoice_date||null,month,month,amount,str(b.due_date),str(b.note)||`由進貨 ${shipment.shipment_no} 結轉`,req.user.id,currency,rate,Math.round(amount*rate),key);
      for (const source of sources) await tx.prepare('INSERT INTO payable_sources (payable_id,shipment_id) VALUES (?,?)').run(p.lastInsertRowid,source.id);
      return p.lastInsertRowid;
    })();
  } catch (e) {
    if (e && !e.status && /constraint/i.test(String(e.message))) return res.status(409).json({ error: '此供應商發票已建立應付，請先核對既有應付' });
    throw e;
  }
  audit.log(req, 'payable_from_shipment', `由發票 ${shipment.invoice_no} 結轉應付 ${payableNo}`);
  res.status(201).json(await payableWithBalance(await db.prepare(`${SELECT} WHERE p.id=?`).get(info)));
}));

/** 應付期間預覽／關帳／反關帳。關帳保存餘額快照並阻止該期應付與付款回寫。 */
router.get('/periods/:month/preview', wrap(async (req, res) => {
  const month = String(req.params.month);
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: '月份格式須為 YYYY-MM' });
  const rows = await db.prepare('SELECT id, payable_no, supplier_id, invoice_no, amount, payable_month FROM payables WHERE payable_month=? ORDER BY id').all(month);
  const paidRow = await db.prepare(`SELECT COALESCE(SUM(pp.amount),0) AS amount FROM payable_payments pp WHERE pp.payment_date LIKE ? AND pp.reversed_payment_id IS NULL`).get(`${month}%`);
  const paid = Number(paidRow?.amount || 0);
  const state = await db.prepare("SELECT * FROM accounting_periods WHERE module='payables' AND period_month=?").get(month);
  res.json({ month, status: state?.status || 'open', payable_count: rows.length, amount: rows.reduce((s,r)=>s+Number(r.amount||0),0), paid, rows });
}));
router.post('/periods/:month/close', requireManager, wrap(async (req, res) => {
  const month = String(req.params.month);
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: '月份格式須為 YYYY-MM' });
  if (await closed(month)) return res.status(409).json({ error: '此期間已關帳' });
  const rows = await db.prepare('SELECT COALESCE(SUM(amount),0) AS amount FROM payables WHERE payable_month=?').get(month);
  const paid = await db.prepare(`SELECT COALESCE(SUM(pp.amount),0) AS amount FROM payable_payments pp WHERE pp.payment_date LIKE ? AND pp.reversed_payment_id IS NULL`).get(`${month}%`);
  const period = await db.prepare("SELECT id FROM accounting_periods WHERE module='payables' AND period_month=?").get(month);
  if (period) await db.prepare("UPDATE accounting_periods SET status='closed',closed_at=datetime('now','localtime'),closed_by=?,reopened_at=NULL,reopened_by=NULL,snapshot_amount=?,snapshot_paid=? WHERE id=?").run(req.user.id,rows.amount,paid.amount,period.id);
  else await db.prepare("INSERT INTO accounting_periods (module,period_month,status,closed_at,closed_by,snapshot_amount,snapshot_paid) VALUES ('payables',?,'closed',datetime('now','localtime'),?,?,?)").run(month,req.user.id,rows.amount,paid.amount);
  audit.log(req, 'payable_period_close', `關閉應付期間 ${month}`);
  res.json({ ok:true, month, amount:Number(rows.amount), paid:Number(paid.amount) });
}));
router.post('/periods/:month/reopen', requireManager, wrap(async (req, res) => {
  const month = String(req.params.month), reason = str(req.body?.reason);
  if (!reason) return res.status(400).json({ error: '反關帳必須填寫原因' });
  if (!await closed(month)) return res.status(409).json({ error: '此期間目前未關帳' });
  await db.prepare("UPDATE accounting_periods SET status='open',reopened_at=datetime('now','localtime'),reopened_by=?,close_reason=? WHERE module='payables' AND period_month=?").run(req.user.id,reason,month);
  audit.log(req, 'payable_period_reopen', `反關帳應付期間 ${month}：${reason}`);
  res.json({ ok:true, month, status:'open' });
}));

/** DELETE /:id 刪除 */
router.delete('/:id', requireManager, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM payables WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '應付帳款不存在' });
  if (await db.prepare('SELECT id FROM payable_payments WHERE payable_id=? LIMIT 1').get(id) || await db.prepare('SELECT id FROM payable_sources WHERE payable_id=? LIMIT 1').get(id)) return res.status(409).json({ error: '此應付已有付款或來源進貨紀錄，禁止刪除；請採用會計更正流程' });
  await db.prepare('DELETE FROM payables WHERE id=?').run(id);
  audit.log(req, 'payable_delete', `刪除應付帳款 ${cur.payable_no}`);
  res.json({ ok: true });
}));

module.exports = router;
