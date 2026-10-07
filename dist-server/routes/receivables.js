'use strict';
/**
 * 應收帳款管理
 * 依交易條件（月結 60/90 天）自動推導：結帳月份 / 應收月份 / 兌現日 / 付款日
 * 收款登錄後自動判定 status：pending（未收）/ partial（部分）/ received（已收）
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireAccounting } = require('../lib/auth');
const audit = require('../lib/audit');
const { num, str, toDateStr, round, nextSerial } = require('../lib/util');
const { calcOrderTotals, deriveAR, agingBucket, orderTermsBasis } = require('../lib/calc');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();
router.use(requireAuth);

const SELECT = `SELECT r.*, o.order_no, o.order_date, o.ship_date, o.currency, o.exchange_rate, o.payment_terms AS order_terms,
                       c.name AS customer_name, c.customer_no,
                       sh.shipment_no AS shipment_no
                  FROM receivables r
                  JOIN orders o ON o.id = r.order_id
                  LEFT JOIN customers c ON c.id = r.customer_id
                  LEFT JOIN shipments sh ON sh.id = r.shipment_id`;

function decorate(r) {
  const outstanding = round(num(r.amount_base) - num(r.received_amount));
  return Object.assign({}, r, {
    outstanding,
    aging: r.status === 'received' ? '已結清' : agingBucket(r.due_date),
    overdue_days: r.due_date
      ? Math.floor((new Date(toDateStr(new Date())).getTime() - new Date(r.due_date).getTime()) / 86400000)
      : null,
  });
}

/**
 * 依訂單自動產生／重建應收（A1：出貨時自動呼叫；亦供手動 /generate 委託）
 * 與原 /generate 完全一致：基準日 = 出貨日（無則訂單日）；依交易條件推導
 * 結帳月份 / 應收月份 / 兌現日 / 付款日；已存在則以最新金額重算（UPSERT by order_id）。
 * shipmentId 用於填寫 P1 直接 FK（receivables.shipment_id，指向觸發產生的出貨單）。
 * @param {object} dbArg  資料庫實例（須與呼叫端同一連線，確保同交易原子化）
 * @param {number} orderId
 * @param {object} req    審計用
 * @param {object} [opts] { shipmentId?:number, manual?:boolean }
 * @returns {object|null}
 */
function ensureReceivableForOrder(dbArg, orderId, req, opts = {}) {
  const { shipmentId = null, manual = false } = opts;
  const o = dbArg.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o) return null;
  const items = dbArg.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId);
  const totals = calcOrderTotals(items);
  const base = o.ship_date || o.order_date || toDateStr(new Date());
  const d = deriveAR(base, o.terms_days || o.payment_terms, orderTermsBasis(o));
  // 優先取「整單 AR」（shipment_id 為空 或 legacy=1）；若已是分批 AR 管理則 per_order 不重複建
  const legacyAR = dbArg.prepare('SELECT * FROM receivables WHERE order_id=? AND (shipment_id IS NULL OR legacy=1)').get(orderId);
  const hasPerShipment = dbArg.prepare("SELECT 1 FROM receivables WHERE order_id=? AND legacy=0 AND shipment_id IS NOT NULL LIMIT 1").get(orderId);
  let exist = legacyAR;
  if (!exist && hasPerShipment) {
    return dbArg.prepare('SELECT * FROM receivables WHERE order_id=? AND shipment_id IS NOT NULL LIMIT 1').get(orderId);
  }
  const no = exist ? exist.receivable_no
    : (req.body && req.body.receivable_no ? String(req.body.receivable_no) : nextSerial('receivable_no_prefix', 'receivable_no_seq', 'AR'));
  if (exist) {
    dbArg.prepare(
      `UPDATE receivables SET billing_month=?, receivable_month=?, due_date=?, payment_date=?, currency=?,
          amount=?, amount_base=?, shipment_id=COALESCE(shipment_id, ?), updated_at=datetime('now','localtime') WHERE id=?`
    ).run(d.billing_month, d.receivable_month, d.due_date, d.payment_date, o.currency, totals.total, totals.total_base, shipmentId || null, exist.id);
    audit.log(req, manual ? 'regenerate' : 'auto-regenerate', 'receivables', exist.id, o.order_no);
    return dbArg.prepare('SELECT * FROM receivables WHERE id=?').get(exist.id);
  }
  const info = dbArg.prepare(
    `INSERT INTO receivables (receivable_no, order_id, customer_id, billing_month, receivable_month, due_date,
        payment_date, currency, amount, amount_base, received_amount, confirmed, status, note, shipment_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,0,'pending',?,?)`
  ).run(no, orderId, o.customer_id, d.billing_month, d.receivable_month, d.due_date, d.payment_date,
        o.currency, totals.total, totals.total_base, (req.body && req.body.note) ? String(req.body.note) : null, shipmentId || null);
  // 訂單狀態推進到已結帳
  if (['draft', 'confirmed', 'shipped'].includes(o.status)) {
    dbArg.prepare("UPDATE orders SET status='billed', updated_at=datetime('now','localtime') WHERE id=?").run(orderId);
  }
  audit.log(req, manual ? 'generate' : 'auto-generate', 'receivables', info.lastInsertRowid, o.order_no);
  return dbArg.prepare('SELECT * FROM receivables WHERE id=?').get(info.lastInsertRowid);
}

/**
 * 計算單筆 shipment 在訂單中的應收分攤金額（原幣 amount 與本位幣 amount_base）。
 * 優先以 shipment.product_id 對應 order_items 明細行，按比例 (shipment.qty / item.qty) 分攤；
 * 找不到對應明細（或 product_id 為空）時，回退為「依數量佔全訂單出貨總量比例」分攤。
 */
function calcShipmentReceivableAmount(dbArg, shipmentId) {
  const sh = dbArg.prepare('SELECT * FROM shipments WHERE id=?').get(shipmentId);
  if (!sh) return { amount: 0, amount_base: 0 };
  const items = dbArg.prepare('SELECT * FROM order_items WHERE order_id=?').all(sh.order_id);
  let orderTotal = 0, orderTotalBase = 0;
  for (const it of items) { orderTotal += num(it.total); orderTotalBase += num(it.total_base); }
  const item = items.find((it) => it.product_id && sh.product_id && Number(it.product_id) === Number(sh.product_id));
  if (item && num(item.qty) > 0) {
    const ratio = num(sh.qty) / num(item.qty);
    return { amount: round(num(item.total) * ratio), amount_base: round(num(item.total_base) * ratio) };
  }
  // 回退：依本 shipment 數量佔全訂單出貨總量比例分攤
  const allShip = dbArg.prepare('SELECT qty FROM shipments WHERE order_id=?').all(sh.order_id);
  let totalQty = 0;
  for (const s of allShip) totalQty += num(s.qty);
  if (totalQty <= 0) return { amount: 0, amount_base: 0 };
  const ratio = num(sh.qty) / totalQty;
  return { amount: round(orderTotal * ratio), amount_base: round(orderTotalBase * ratio) };
}

/**
 * 將某 order 真正「整單 AR」（shipment_id 為 NULL 或已 legacy=1）標記 legacy=1 並中性化
 * （status=received、received_amount=amount_base → outstanding=0），避免與新分批 AR 雙重計入。
 *
 * 注意：A1 時代「綁定某 shipment 且金額＝整單」的殘留 AR「不」在此退休——
 * 改由 ensureReceivableForShipment 的「全 shipment 重算 + UPSERT by shipment_id」就地更正其金額，
 * 避免把舊批 AR 誤殺導致該批漏算（分批後首批被次批觸發退休的失真）。
 */
function retireLegacyReceivables(dbArg, orderId, shipmentId, orderTotalBase, shipmentNo) {
  const ars = dbArg.prepare('SELECT * FROM receivables WHERE order_id=?').all(orderId);
  for (const ar of ars) {
    if (ar.legacy === 1) continue;
    const isTrueLegacy = (ar.shipment_id === null || ar.shipment_id === undefined);
    if (isTrueLegacy) {
      dbArg.prepare(
        `UPDATE receivables SET legacy=1, status='received', received_amount=amount_base,
            note=?, updated_at=datetime('now','localtime') WHERE id=?`
      ).run(`legacy 整單（已改分批，金額併入分批 AR，出貨單 ${shipmentNo || ''}）`, ar.id);
    }
  }
}

/**
 * 依出貨批次自動產生／重建應收（A2 核心）。
 *  - 基準日 = 各 shipment 的 ship_date（每批各自推導帳期，解決 A2「帳期壓扁」問題）
 *  - 金額 = 各 shipment 佔訂單的比例分攤（calcShipmentReceivableAmount）
 *  - 觸發時「重算本訂單所有 shipment」的 AR（UPSERT by shipment_id）：
 *      確保分批後各批比例一致、舊批金額隨新增批次自動更正
 *      （修復「首批建出貨即全額、次批才拆 → 首批 AR 被誤殺漏算」的失真）
 *  - 先將同 order 真正整單 AR（shipment_id NULL）標 legacy 退場（避免雙重計入）
 *  - 首筆 AR 將訂單推進至 billed
 * @param {object} dbArg
 * @param {number} shipmentId
 * @param {object} req
 * @returns {object|null}
 */
function ensureReceivableForShipment(dbArg, shipmentId, req) {
  const sh = dbArg.prepare('SELECT * FROM shipments WHERE id=?').get(shipmentId);
  if (!sh) return null;
  const orderId = sh.order_id;
  const o = dbArg.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o) return null;
  const orderItems = dbArg.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId);
  let orderTotalBase = 0;
  for (const it of orderItems) orderTotalBase += num(it.total_base);
  // 退場真正整單 AR（shipment_id NULL）；綁定 shipment 的殘留整單 AR 由下方 UPSERT 就地更正
  retireLegacyReceivables(dbArg, orderId, shipmentId, orderTotalBase, sh.shipment_no);
  // A2：重算本訂單「全部」shipment 的 AR（比例隨總出貨量自動平衡，冪等）
  const ships = dbArg.prepare('SELECT * FROM shipments WHERE order_id=? ORDER BY id').all(orderId);
  for (const s of ships) {
    const { amount, amount_base } = calcShipmentReceivableAmount(dbArg, s.id);
    const base = s.ship_date || o.ship_date || o.order_date || toDateStr(new Date());
    const d = deriveAR(base, o.terms_days || o.payment_terms, orderTermsBasis(o));
    const exist = dbArg.prepare('SELECT * FROM receivables WHERE shipment_id=?').get(s.id);
    const no = exist ? exist.receivable_no
      : (req.body && req.body.receivable_no ? String(req.body.receivable_no) : nextSerial('receivable_no_prefix', 'receivable_no_seq', 'AR'));
    if (exist) {
      dbArg.prepare(
        `UPDATE receivables SET billing_month=?, receivable_month=?, due_date=?, payment_date=?, currency=?,
            amount=?, amount_base=?, updated_at=datetime('now','localtime') WHERE id=?`
      ).run(d.billing_month, d.receivable_month, d.due_date, d.payment_date, o.currency, amount, amount_base, exist.id);
      audit.log(req, 'auto-regenerate', 'receivables', exist.id, `${o.order_no} / ${s.shipment_no}`);
    } else {
      const info = dbArg.prepare(
        `INSERT INTO receivables (receivable_no, order_id, shipment_id, customer_id, billing_month, receivable_month, due_date,
            payment_date, currency, amount, amount_base, received_amount, confirmed, status, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,'pending',?)`
      ).run(no, orderId, s.id, o.customer_id, d.billing_month, d.receivable_month, d.due_date,
            d.payment_date, o.currency, amount, amount_base, null);
      audit.log(req, 'auto-generate', 'receivables', info.lastInsertRowid, `${o.order_no} / ${s.shipment_no}`);
    }
  }
  // 首筆 AR 將訂單推進到已結帳（billed）
  if (['draft', 'confirmed', 'shipped'].includes(o.status)) {
    dbArg.prepare("UPDATE orders SET status='billed', updated_at=datetime('now','localtime') WHERE id=?").run(orderId);
  }
  return dbArg.prepare('SELECT * FROM receivables WHERE shipment_id=?').get(shipmentId);
}

router.get('/', wrap(async (req, res) => {
  const q = req.query || {};
  const cond = [];
  const args = [];
  if (q.customer_id) { cond.push('r.customer_id = ?'); args.push(Number(q.customer_id)); }
  if (q.status) { cond.push('r.status = ?'); args.push(q.status); }
  if (q.billing_month) { cond.push('r.billing_month = ?'); args.push(q.billing_month); }
  if (q.receivable_month) { cond.push('r.receivable_month = ?'); args.push(q.receivable_month); }
  if (q.confirmed === '1') cond.push('r.confirmed = 1');
  if (q.confirmed === '0') cond.push('r.confirmed = 0');
  if (q.keyword) {
    cond.push('(r.receivable_no LIKE ? OR o.order_no LIKE ? OR c.name LIKE ?)');
    args.push(...Array(3).fill(`%${q.keyword}%`));
  }
  // A2：預設排除已退場的舊整單 AR（legacy=1），避免與分批 AR 雙重計入；include_legacy=1 才顯示
  if (q.include_legacy !== '1') cond.push('(r.legacy IS NULL OR r.legacy = 0)');
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = await db.prepare(`${SELECT} ${where} ORDER BY r.due_date, r.id DESC LIMIT 500`).all(...args).map(decorate);
  res.json(rows);
}));

/** 依訂單產生／重建應收（以出貨日為基準，無出貨日則用訂單日） */
router.post('/generate', requireAccounting, wrap(async (req, res) => {
  const orderId = Number((req.body || {}).order_id);
  const o = await db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o) return res.status(404).json({ error: '訂單不存在' });
  const row = ensureReceivableForOrder(db, orderId, req, { shipmentId: null, manual: true });
  if (!row) return res.status(404).json({ error: '無法產生應收（訂單不存在）' });
  res.json(decorate(row));
}));

/** 收款登錄／編輯（會計以上） */
router.put('/:id', requireAccounting, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM receivables WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '應收紀錄不存在' });
  const b = req.body || {};

  const received = b.received_amount !== undefined ? num(b.received_amount, cur.received_amount) : cur.received_amount;
  const amountBase = b.amount_base !== undefined ? num(b.amount_base, cur.amount_base) : cur.amount_base;
  const confirmed = b.confirmed === undefined ? cur.confirmed : (b.confirmed ? 1 : 0);
  let status = cur.status;
  if (received <= 0) status = 'pending';
  else if (received >= amountBase - 0.01) status = 'received';
  else status = 'partial';

  const receivedDate = b.received_date !== undefined ? str(b.received_date) || null : cur.received_date;
  const paymentDate = b.payment_date !== undefined ? str(b.payment_date) || null : cur.payment_date;

  await db.prepare(
    `UPDATE receivables SET received_amount=?, amount_base=?, confirmed=?, status=?, received_date=?, payment_date=?,
        bank_note=?, billing_month=?, receivable_month=?, due_date=?, note=?, updated_at=datetime('now','localtime')
      WHERE id=?`
  ).run(
    received, amountBase, confirmed, status, receivedDate, paymentDate,
    b.bank_note !== undefined ? str(b.bank_note) : cur.bank_note,
    b.billing_month !== undefined ? str(b.billing_month) : cur.billing_month,
    b.receivable_month !== undefined ? str(b.receivable_month) : cur.receivable_month,
    b.due_date !== undefined ? str(b.due_date) || null : cur.due_date,
    b.note !== undefined ? str(b.note) : cur.note,
    id
  );

  // 全額收款 → 僅當該訂單「所有有效 AR（legacy=0）皆已收訖」才推進訂單為 paid（A2 多批各自收款）
  if (status === 'received') {
    const remain = await db.prepare("SELECT COUNT(*) AS n FROM receivables WHERE order_id=? AND legacy=0 AND status <> 'received'").get(cur.order_id);
    if (remain.n === 0) {
      await db.prepare("UPDATE orders SET status='paid', updated_at=datetime('now','localtime') WHERE id=? AND status IN ('draft','confirmed','shipped','billed')")
        .run(cur.order_id);
    }
  }
  audit.log(req, 'update', 'receivables', id, `${cur.receivable_no} 收款 ${received}`);
  res.json(decorate(await db.prepare(`${SELECT} WHERE r.id=?`).get(id)));
}));

/** 快速收款沖帳 */
router.post('/:id/receive', requireAccounting, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM receivables WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '應收紀錄不存在' });
  const b = req.body || {};
  const add = num(b.amount, 0);
  if (add <= 0) return res.status(400).json({ error: '收款金額必須大於 0' });
  const received = round(num(cur.received_amount) + add);
  const status = received >= num(cur.amount_base) - 0.01 ? 'received' : 'partial';
  await db.prepare(
    `UPDATE receivables SET received_amount=?, status=?, confirmed=1, received_date=?, bank_note=?,
        updated_at=datetime('now','localtime') WHERE id=?`
  ).run(received, status, str(b.received_date) || toDateStr(new Date()), str(b.bank_note) || cur.bank_note, id);
  if (status === 'received') {
    const remain = await db.prepare("SELECT COUNT(*) AS n FROM receivables WHERE order_id=? AND legacy=0 AND status <> 'received'").get(cur.order_id);
    if (remain.n === 0) {
      await db.prepare("UPDATE orders SET status='paid', updated_at=datetime('now','localtime') WHERE id=? AND status IN ('draft','confirmed','shipped','billed')")
        .run(cur.order_id);
    }
  }
  audit.log(req, 'receive', 'receivables', id, `${cur.receivable_no} +${add}`);
  res.json(decorate(await db.prepare(`${SELECT} WHERE r.id=?`).get(id)));
}));

router.delete('/:id', requireAccounting, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM receivables WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '應收紀錄不存在' });
  await db.prepare('DELETE FROM receivables WHERE id=?').run(id);
  audit.log(req, 'delete', 'receivables', id, cur.receivable_no);
  res.json({ ok: true });
}));

/** 帳齡分析 */
router.get('/aging', wrap(async (req, res) => {
  const asOf = str(req.query.as_of) || toDateStr(new Date());
  const rows = await db.prepare('SELECT r.* FROM receivables r WHERE (r.legacy IS NULL OR r.legacy = 0)').all().map(decorate);
  const buckets = { '未到期': 0, '逾期1-30天': 0, '逾期31-60天': 0, '逾期61-90天': 0, '逾期90天以上': 0, '已結清': 0 };
  const list = [];
  for (const r of rows) {
    const out = num(r.outstanding);
    if (out <= 0.01) continue;
    const bucket = agingBucket(r.due_date, asOf);
    buckets[bucket] = round(num(buckets[bucket]) + out);
    list.push(r);
  }
  res.json({ as_of: asOf, buckets, total_outstanding: round(list.reduce((s, r) => s + num(r.outstanding), 0)), items: list });
}));

/** 客戶對帳單 */
router.get('/statement', wrap(async (req, res) => {
  const q = req.query || {};
  const cond = [];
  const args = [];
  if (q.customer_id) { cond.push('r.customer_id = ?'); args.push(Number(q.customer_id)); }
  if (q.month) { cond.push('(r.billing_month = ? OR r.receivable_month = ?)'); args.push(q.month, q.month); }
  if (q.include_legacy !== '1') cond.push('(r.legacy IS NULL OR r.legacy = 0)');
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = await db.prepare(`${SELECT} ${where} ORDER BY r.due_date, r.id`).all(...args).map(decorate);
  const summary = {
    count: rows.length,
    amount: round(rows.reduce((s, r) => s + num(r.amount_base), 0)),
    received: round(rows.reduce((s, r) => s + num(r.received_amount), 0)),
    outstanding: round(rows.reduce((s, r) => s + num(r.outstanding), 0)),
  };
  res.json({ summary, items: rows });
}));

/**
 * 批次結帳（會計以上）—— 省月結 30 分鐘
 *   body: {
 *     fromMonth?: 'YYYY-MM',         // 含起月（出貨日落在起月之前的不處理）
 *     toMonth?:   'YYYY-MM',         // 含迄月
 *     statuses?:  ['shipped','billed',...] // 訂單狀態白名單；預設 ['shipped','billed']
 *     force?:     boolean,           // true 時對已有應收的訂單也重建（會計覆核場景）
 *     dryRun?:    boolean            // true 時只回傳會被處理的清單，不寫入
 *   }
 *
 * 回傳：
 *   { ok, scanned, generated, skipped, errors,
 *     total_amount_base, by_month: { 'YYYY-MM': count, ... },
 *     items: [{ order_id, order_no, action: 'create'|'rebuild'|'skip', receivable_no?, billing_month, amount_base }] }
 */
router.post('/batch-generate', requireAccounting, wrap(async (req, res) => {
  const b = req.body || {};
  const fromMonth = str(b.fromMonth) || str(b.from_month) || '';
  const toMonth   = str(b.toMonth)   || str(b.to_month)   || '';
  const statuses  = Array.isArray(b.statuses) && b.statuses.length ? b.statuses : ['shipped', 'billed'];
  const force = b.force === true;
  const dryRun = b.dryRun === true || b.dry_run === true;
  // A2：mode 預設 per_order（向下相容）；per_shipment 才啟用分批請款
  const mode = str(b.mode) || 'per_order';

  const placeholders = statuses.map(() => '?').join(',');

  // 篩選訂單：依狀態白名單 + （選用）依 ship_date 月份範圍
  const conds = [`o.status IN (${placeholders})`];
  const args = statuses.slice();
  if (fromMonth) {
    conds.push("COALESCE(o.ship_date, o.order_date) >= ?");
    args.push(fromMonth + '-01');
  }
  if (toMonth) {
    // 含整月：toMonth 月底
    const [y, m] = toMonth.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    conds.push("COALESCE(o.ship_date, o.order_date) <= ?");
    args.push(`${toMonth}-${String(lastDay).padStart(2, '0')}`);
  }
  const sql = `SELECT o.id, o.order_no, o.status, o.ship_date, o.order_date, o.customer_id,
                      o.terms_days, o.payment_terms, o.currency, o.exchange_rate
                 FROM orders o
                WHERE ${conds.join(' AND ')}
                ORDER BY COALESCE(o.ship_date, o.order_date), o.id`;
  const orders = await db.prepare(sql).all(...args);

  const items = [];
  let generated = 0, skipped = 0, errors = 0;
  const byMonth = {};
  let totalBase = 0;
  // 預先取現有「整單 AR」索引（order_id → 整單 receivable；分批 AR 不納入，避免覆寫）
  const existing = new Map();
  for (const r of await db.prepare('SELECT * FROM receivables').all()) {
    if (r.shipment_id === null || r.shipment_id === undefined || r.legacy === 1) {
      if (!existing.has(r.order_id)) existing.set(r.order_id, r);
    }
  }

  // 事務批量：先試掃描所有 → 再逐筆寫入（每筆獨立 try，失敗不影響其他）
  for (const o of orders) {
    try {
      if (mode === 'per_shipment') {
        // A2 分批請款：逐筆 shipment 產生各自 AR（各批金額＋各批帳期）
        const ships = await db.prepare('SELECT * FROM shipments WHERE order_id=? ORDER BY id').all(o.id);
        if (!ships.length) {
          skipped++;
          items.push({ order_id: o.id, order_no: o.order_no, action: 'skip', reason: 'no_shipments' });
          continue;
        }
        let orderBase = 0;
        for (const s of ships) {
          const exShip = await db.prepare('SELECT * FROM receivables WHERE shipment_id=? AND legacy=0').get(s.id);
          if (exShip && !force) {
            skipped++;
            items.push({ order_id: o.id, order_no: o.order_no, shipment_id: s.id, shipment_no: s.shipment_no, action: 'skip', receivable_no: exShip.receivable_no, amount_base: exShip.amount_base });
            continue;
          }
          if (dryRun) {
            const amt = calcShipmentReceivableAmount(db, s.id);
            const d = deriveAR(s.ship_date || o.ship_date || o.order_date, o.terms_days || o.payment_terms, orderTermsBasis(o));
            generated++; orderBase += num(amt.amount_base);
            byMonth[d.billing_month] = (byMonth[d.billing_month] || 0) + 1;
            items.push({ order_id: o.id, order_no: o.order_no, shipment_id: s.id, shipment_no: s.shipment_no, action: exShip ? 'rebuild' : 'create', billing_month: d.billing_month, amount_base: amt.amount_base });
            continue;
          }
          const ar = ensureReceivableForShipment(db, s.id, req);
          if (ar) {
            generated++; orderBase += num(ar.amount_base);
            byMonth[ar.billing_month] = (byMonth[ar.billing_month] || 0) + 1;
            items.push({ order_id: o.id, order_no: o.order_no, shipment_id: s.id, shipment_no: s.shipment_no, action: exShip ? 'rebuild' : 'create', receivable_no: ar.receivable_no, billing_month: ar.billing_month, amount_base: ar.amount_base });
          } else {
            errors++;
            items.push({ order_id: o.id, order_no: o.order_no, shipment_id: s.id, action: 'error', error: 'ensure failed' });
          }
        }
        totalBase = round(totalBase + orderBase);
        continue;
      }

      // ---- per_order（預設，向下相容）----
      const ex = existing.get(o.id);
      // 已是分批 AR 管理則跳過（避免雙重計入）
      const perShip = await db.prepare("SELECT 1 FROM receivables WHERE order_id=? AND legacy=0 AND shipment_id IS NOT NULL LIMIT 1").get(o.id);
      if (perShip && !force) {
        skipped++;
        items.push({ order_id: o.id, order_no: o.order_no, action: 'skip', reason: 'already_per_shipment' });
        continue;
      }
      if (ex && !force) {
        skipped++;
        items.push({ order_id: o.id, order_no: o.order_no, action: 'skip', receivable_no: ex.receivable_no, billing_month: ex.billing_month, amount_base: ex.amount_base });
        continue;
      }
      const orderItems = await db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);
      if (!orderItems.length) {
        skipped++;
        items.push({ order_id: o.id, order_no: o.order_no, action: 'skip', reason: 'no_items' });
        continue;
      }
      const totals = calcOrderTotals(orderItems);
      const baseDate = o.ship_date || o.order_date || toDateStr(new Date());
      const d = deriveAR(baseDate, o.terms_days || o.payment_terms, orderTermsBasis(o));
      const no = ex ? ex.receivable_no : str(b.receivable_no) || nextSerial('receivable_no_prefix', 'receivable_no_seq', 'AR');
      const billingMonth = d.billing_month;

      if (dryRun) {
        generated++;
        totalBase += num(totals.total_base);
        byMonth[billingMonth] = (byMonth[billingMonth] || 0) + 1;
        items.push({ order_id: o.id, order_no: o.order_no, action: ex ? 'rebuild' : 'create', receivable_no: no, billing_month: billingMonth, amount_base: totals.total_base });
        continue;
      }

      const row = ensureReceivableForOrder(db, o.id, req, { shipmentId: null, manual: true });
      if (row) {
        generated++;
        totalBase = round(totalBase + num(row.amount_base));
        byMonth[billingMonth] = (byMonth[billingMonth] || 0) + 1;
        items.push({ order_id: o.id, order_no: o.order_no, action: ex ? 'rebuild' : 'create', receivable_no: row.receivable_no, billing_month: billingMonth, amount_base: row.amount_base });
      } else {
        errors++;
        items.push({ order_id: o.id, order_no: o.order_no, action: 'error', error: 'ensure failed' });
      }
    } catch (e) {
      errors++;
      items.push({ order_id: o.id, order_no: o.order_no, action: 'error', error: e.message });
    }
  }

  audit.log(req, 'batch-generate', 'receivables', null, {
    fromMonth, toMonth, statuses, force, dryRun, mode,
    scanned: orders.length, generated, skipped, errors, totalBase: round(totalBase),
  });

  res.json({
    ok: true,
    dryRun,
    mode,
    scanned: orders.length,
    generated,
    skipped,
    errors,
    total_amount_base: round(totalBase),
    by_month: byMonth,
    items,
  });
}));

// 供 routes/shipments.js 在出貨建立/更新時自動觸發應收產生
router.ensureReceivableForOrder = ensureReceivableForOrder;     // A1：整單路徑（兼容）
router.ensureReceivableForShipment = ensureReceivableForShipment; // A2：分批路徑（依出貨批）
router.calcShipmentReceivableAmount = calcShipmentReceivableAmount; // 供遷移腳本估計分批金額

module.exports = router;
