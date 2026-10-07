'use strict';
/** 報表與經營分析（客戶／業務／產品／月份別 + Excel 匯出） */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth } = require('../lib/auth');
const { num, str, round, toDateStr, toMonthStr } = require('../lib/util');
const { calcOrderTotals, agingBucket } = require('../lib/calc');
const exportx = require('../lib/exportx');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();
router.use(requireAuth);

const BASE_JOIN = `FROM orders o
   LEFT JOIN customers c ON c.id = o.customer_id
   LEFT JOIN users u ON u.id = o.sales_id`;

/**
 * 測試客戶（is_test=1，如 ETL 平行驗證客戶 C-ETL-*）預設自報表排除，
 * 避免測試資料污染經營分析；需要時帶 ?include_test=1 納入。
 * 【2026-09-10 健檢 P2-3】封存會破壞 MySQL parity，故採「報表層排除」而非改資料。
 */
const TEST_FILTER = 'COALESCE(c.is_test,0) = 0';
const TEST_FILTER_AR = 'COALESCE(c.is_test,0) = 0';

function includeTest(q) {
  const v = (q || {}).include_test;
  return v === '1' || v === 'true' || v === 'yes';
}

function periodWhere(q) {
  const cond = ["o.status <> 'cancelled'"];
  const args = [];
  if (!includeTest(q)) cond.push(TEST_FILTER);
  if (q.date_from) { cond.push('o.order_date >= ?'); args.push(q.date_from); }
  if (q.date_to) { cond.push('o.order_date <= ?'); args.push(q.date_to); }
  if (q.month) { cond.push('o.month = ?'); args.push(q.month); }
  if (q.customer_id) { cond.push('o.customer_id = ?'); args.push(Number(q.customer_id)); }
  if (q.sales_id) { cond.push('o.sales_id = ?'); args.push(Number(q.sales_id)); }
  if (q.status) { cond.push('o.status = ?'); args.push(q.status); }
  return { where: 'WHERE ' + cond.join(' AND '), args };
}

/** 應收帳款匯出的過濾條件（比 periodWhere 寬：無明細也能列） */
function arWhere(q) {
  const cond = ["o.status <> 'cancelled'"];
  const args = [];
  if (!includeTest(q)) cond.push(TEST_FILTER_AR);
  if (q.date_from) { cond.push('o.order_date >= ?'); args.push(q.date_from); }
  if (q.date_to) { cond.push('o.order_date <= ?'); args.push(q.date_to); }
  if (q.customer_id) { cond.push('r.customer_id = ?'); args.push(Number(q.customer_id)); }
  return { where: cond.join(' AND '), args };
}

/** 儀表板 KPI（支援 date_from / date_to 日期區間，預設當月） */
router.get('/dashboard', wrap(async (req, res) => {
  const now = new Date();
  const defaultFrom = toDateStr(new Date(now.getFullYear(), now.getMonth(), 1));
  const defaultTo = toDateStr(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  const dateFrom = req.query.date_from || defaultFrom;
  const dateTo = req.query.date_to || defaultTo;
  const monthFrom = dateFrom.substring(0, 7);
  const monthTo = dateTo.substring(0, 7);
  const incTest = includeTest(req.query);
  const periodCond = 'o.month >= ? AND o.month <= ?';
  const periodArgs = [monthFrom, monthTo];
  // 測試客戶過濾（P2-3）：orders 側需 JOIN customers 才能判斷 is_test
  const oJoin = 'LEFT JOIN customers c ON c.id = o.customer_id';
  const xTest = incTest ? '' : `AND ${TEST_FILTER}`;
  // 應收側：JOIN customers 判斷是否為測試客戶
  const rJoin = 'LEFT JOIN customers c ON c.id = r.customer_id';
  const xTestAR = incTest ? '' : `AND ${TEST_FILTER_AR}`;

  const m = await db.prepare(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(i.total_base),0) AS revenue,
            COALESCE(SUM(i.cost_total),0) AS cost,
            COALESCE(SUM(i.freight_cn + i.freight_tw),0) AS freight,
            COALESCE(SUM(i.profit),0) AS profit
       FROM orders o JOIN order_items i ON i.order_id = o.id ${oJoin}
      WHERE o.status <> 'cancelled' ${xTest} AND ${periodCond}`
  ).get(...periodArgs);
  const revenue = round(m.revenue);
  const profit = round(m.profit);

  // 應收應付為當前餘額（不受日期區間影響）
  const ar = await db.prepare(
    `SELECT COALESCE(SUM(r.amount_base),0) AS total,
            COALESCE(SUM(r.received_amount),0) AS received
       FROM receivables r ${rJoin}
      WHERE 1=1 ${xTestAR} AND (r.legacy IS NULL OR r.legacy = 0)`
  ).get();
  const outstanding = round(num(ar.total) - num(ar.received));
  const overdue = round(
    await db.prepare(`SELECT COALESCE(SUM(r.amount_base - r.received_amount),0) AS v
                  FROM receivables r ${rJoin}
                 WHERE r.status <> 'received' AND r.due_date < ? ${xTestAR} AND (r.legacy IS NULL OR r.legacy = 0)`)
      .get(toDateStr(new Date())).v
  );
  const ap = await db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS total,
            COALESCE(SUM(paid_amount),0) AS paid
       FROM payables`
  ).get();
  const apOutstanding = round(num(ap.total) - num(ap.paid));

  // 出貨統計（日期區間內）
  const shipCount = await db.prepare(
    `SELECT COUNT(*) AS n
       FROM shipments s
       JOIN orders o ON o.id = s.order_id ${oJoin}
      WHERE s.ship_date >= ? AND s.ship_date <= ? ${xTest}`
  ).get(dateFrom, dateTo).n;

  const statusRows = await db.prepare(
    `SELECT o.status, COUNT(*) AS n FROM orders o ${oJoin}
      WHERE o.status <> 'cancelled' ${xTest} AND ${periodCond} GROUP BY o.status`
  ).all(...periodArgs);
  const statusMap = {};
  for (const r of statusRows) statusMap[r.status] = r.n;

  // 趨勢：日期區間往前 12 個月（含訂單數與毛利率）
  const trendStart = monthShift(toMonthStr(new Date(dateTo)), -11);
  const trend = await db.prepare(
    `SELECT o.month,
            COUNT(DISTINCT o.id) AS order_count,
            COALESCE(SUM(i.total_base),0) AS revenue,
            COALESCE(SUM(i.profit),0) AS profit
       FROM orders o JOIN order_items i ON i.order_id = o.id ${oJoin}
      WHERE o.status <> 'cancelled' ${xTest} AND o.month IS NOT NULL AND o.month >= ?
      GROUP BY o.month ORDER BY o.month`
  ).all(trendStart);

  // === 新增 7 項戰情資料 ===
  const today = toDateStr(new Date());

  // 1. 應付帳齡分布（payables，status <> 'paid'）
  const apRows = await db.prepare(
    `SELECT amount, paid_amount, due_date FROM payables WHERE status <> 'paid'`
  ).all();
  const apAging = { '未到期': 0, '逾期1-30天': 0, '逾期31-60天': 0, '逾期61-90天': 0, '逾期90天以上': 0 };
  for (const r of apRows) {
    const bal = num(r.amount) - num(r.paid_amount);
    if (bal <= 0) continue;
    const days = Math.floor((new Date(today) - new Date(r.due_date)) / 86400000);
    if (days < 0) apAging['未到期'] += bal;
    else if (days <= 30) apAging['逾期1-30天'] += bal;
    else if (days <= 60) apAging['逾期31-60天'] += bal;
    else if (days <= 90) apAging['逾期61-90天'] += bal;
    else apAging['逾期90天以上'] += bal;
  }
  for (const k of Object.keys(apAging)) apAging[k] = round(apAging[k]);

  // 2. 逾期帳款明細（receivables JOIN customers，取前 10 筆）
  const overdueDetails = await db.prepare(
    `SELECT r.receivable_no, r.customer_id, c.name AS customer_name, c.customer_no,
            r.amount_base, r.received_amount, r.due_date, r.status,
            CAST(julianday(?) - julianday(r.due_date) AS INTEGER) AS overdue_days
       FROM receivables r LEFT JOIN customers c ON c.id = r.customer_id
      WHERE r.status <> 'received' AND r.due_date < ? ${xTestAR} AND (r.legacy IS NULL OR r.legacy = 0)
      ORDER BY overdue_days DESC LIMIT 10`
  ).all(today, today);

  // 3. 出貨達成率（已出貨以上狀態 / 已確認以上狀態，日期區間內）
  const shipRateRow = await db.prepare(
    `SELECT
       COUNT(*) AS total_confirmed,
       SUM(CASE WHEN o.status IN ('shipped','billed','paid','closed') THEN 1 ELSE 0 END) AS shipped_count
      FROM orders o ${oJoin}
      WHERE o.status NOT IN ('draft','cancelled') ${xTest} AND ${periodCond}`
  ).get(...periodArgs);
  const totalConfirmed = num(shipRateRow.total_confirmed);
  const shippedCount = num(shipRateRow.shipped_count);
  const shipRate = totalConfirmed > 0 ? round(shippedCount / totalConfirmed, 4) : 0;

  // 4. 客戶集中度（Top 5 客戶營收 / 總營收，日期區間內）
  const custRows = await db.prepare(
    `SELECT c.name AS customer_name, COALESCE(SUM(i.total_base),0) AS revenue
       FROM orders o JOIN order_items i ON i.order_id = o.id
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.status <> 'cancelled' ${xTest} AND ${periodCond}
      GROUP BY o.customer_id ORDER BY revenue DESC LIMIT 5`
  ).all(...periodArgs);
  const totalCustRevenue = custRows.reduce((s, r) => s + num(r.revenue), 0);
  const customerConcentration = custRows.map((r) => ({
    customer_name: r.customer_name || '（未指定）',
    revenue: round(r.revenue),
    pct: totalCustRevenue > 0 ? round(num(r.revenue) / totalCustRevenue, 4) : 0,
  }));

  // 5. 產品毛利排行 Top 5（日期區間內）
  const prodProfitRows = await db.prepare(
    `SELECT i.part_no, i.note AS description,
            COALESCE(SUM(i.qty),0) AS qty,
            COALESCE(SUM(i.total_base),0) AS revenue,
            COALESCE(SUM(i.profit),0) AS profit
       FROM orders o JOIN order_items i ON i.order_id = o.id ${oJoin}
      WHERE o.status <> 'cancelled' ${xTest} AND ${periodCond}
      GROUP BY i.part_no ORDER BY profit DESC LIMIT 5`
  ).all(...periodArgs);
  const productProfit = prodProfitRows.map((r) => ({
    part_no: r.part_no || '（未指定）',
    description: r.description || '',
    qty: round(r.qty),
    revenue: round(r.revenue),
    profit: round(r.profit),
    margin: num(r.revenue) > 0 ? round(num(r.profit) / num(r.revenue), 4) : 0,
  }));

  res.json({
    date_from: dateFrom,
    date_to: dateTo,
    include_test: incTest,
    kpi: {
      orders: m.orders,
      revenue,
      cost: round(m.cost),
      freight: round(m.freight),
      profit,
      margin: revenue > 0 ? round(profit / revenue, 6) : 0,
      outstanding,
      overdue,
      ap_outstanding: apOutstanding,
      shipments: shipCount,
    },
    status: statusMap,
    trend: trend.map((t) => ({
      month: t.month,
      order_count: t.order_count,
      revenue: round(t.revenue),
      profit: round(t.profit),
      margin: num(t.revenue) > 0 ? round(num(t.profit) / num(t.revenue), 4) : 0,
    })),
    ap_aging: apAging,
    overdue_details: overdueDetails.map((r) => ({
      receivable_no: r.receivable_no,
      customer_id: r.customer_id,
      customer_no: r.customer_no,
      customer_name: r.customer_name || '（未指定）',
      amount: round(r.amount_base),
      received: round(r.received_amount),
      balance: round(num(r.amount_base) - num(r.received_amount)),
      due_date: r.due_date,
      overdue_days: r.overdue_days,
      status: r.status,
    })),
    ship_rate: { total: totalConfirmed, shipped: shippedCount, rate: shipRate },
    customer_concentration: customerConcentration,
    product_profit: productProfit,
  });
}));

function monthShift(ym, delta) {
  const m = String(ym).match(/^(\d{4})-(\d{2})$/);
  if (!m) return ym;
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1);
  return toMonthStr(d);
}

/** 客戶別銷售彙總 */
router.get('/by-customer', wrap(async (req, res) => {
  const p = periodWhere(req.query);
  const rows = await db.prepare(
    `SELECT c.id AS customer_id, c.customer_no, c.name AS customer_name,
            COUNT(DISTINCT o.id) AS order_count,
            COALESCE(SUM(i.qty),0) AS qty,
            COALESCE(SUM(i.total_base),0) AS revenue,
            COALESCE(SUM(i.profit),0) AS profit
       ${BASE_JOIN} JOIN order_items i ON i.order_id = o.id
       ${p.where}
      GROUP BY c.id ORDER BY revenue DESC`
  ).all(...p.args);
  res.json(rows.map((r) => Object.assign({}, r, {
    revenue: round(r.revenue), profit: round(r.profit),
    margin: num(r.revenue) > 0 ? round(r.profit / r.revenue, 6) : 0,
  })));
}));

/** 業務別業績 */
router.get('/by-sales', wrap(async (req, res) => {
  const p = periodWhere(req.query);
  const rows = await db.prepare(
    `SELECT u.id AS sales_id, u.emp_id, u.name AS sales_name,
            COUNT(DISTINCT o.id) AS order_count,
            COALESCE(SUM(i.qty),0) AS qty,
            COALESCE(SUM(i.total_base),0) AS revenue,
            COALESCE(SUM(i.profit),0) AS profit
       ${BASE_JOIN} JOIN order_items i ON i.order_id = o.id
       ${p.where}
      GROUP BY u.id ORDER BY revenue DESC`
  ).all(...p.args);
  res.json(rows.map((r) => Object.assign({}, r, {
    revenue: round(r.revenue), profit: round(r.profit),
    margin: num(r.revenue) > 0 ? round(r.profit / r.revenue, 6) : 0,
  })));
}));

/** 產品別銷量與毛利 */
router.get('/by-product', wrap(async (req, res) => {
  const p = periodWhere(req.query);
  const rows = await db.prepare(
    `SELECT i.part_no, MAX(i.unit) AS unit,
            COALESCE(SUM(i.qty),0) AS qty,
            COALESCE(SUM(i.total_base),0) AS revenue,
            COALESCE(SUM(i.profit),0) AS profit
       ${BASE_JOIN} JOIN order_items i ON i.order_id = o.id
       ${p.where}
      GROUP BY i.part_no ORDER BY revenue DESC`
  ).all(...p.args);
  res.json(rows.map((r) => Object.assign({}, r, {
    revenue: round(r.revenue), profit: round(r.profit),
    margin: num(r.revenue) > 0 ? round(r.profit / r.revenue, 6) : 0,
  })));
}));

/** 月份別營收／成本／利潤 */
router.get('/by-month', wrap(async (req, res) => {
  const p = periodWhere(req.query);
  const rows = await db.prepare(
    `SELECT o.month,
            COUNT(DISTINCT o.id) AS order_count,
            COALESCE(SUM(i.total_base),0) AS revenue,
            COALESCE(SUM(i.cost_total),0) AS cost,
            COALESCE(SUM(i.freight_cn + i.freight_tw),0) AS freight,
            COALESCE(SUM(i.profit),0) AS profit
       ${BASE_JOIN} JOIN order_items i ON i.order_id = o.id
       ${p.where}
      GROUP BY o.month ORDER BY o.month`
  ).all(...p.args);
  res.json(rows.map((r) => Object.assign({}, r, {
    revenue: round(r.revenue), cost: round(r.cost), freight: round(r.freight), profit: round(r.profit),
    margin: num(r.revenue) > 0 ? round(r.profit / r.revenue, 6) : 0,
  })));
}));

/** 交期追蹤：工廠交期 vs 客戶交期 vs 實際出貨 */
router.get('/delivery', wrap(async (req, res) => {
  const q = req.query || {};
  const cond = ['1=1'];
  const args = [];
  if (!includeTest(q)) cond.push(TEST_FILTER);
  if (q.customer_id) { cond.push('o.customer_id = ?'); args.push(Number(q.customer_id)); }
  if (q.date_from) { cond.push('o.order_date >= ?'); args.push(q.date_from); }
  if (q.date_to) { cond.push('o.order_date <= ?'); args.push(q.date_to); }
  if (q.only_open === '1') cond.push("o.status IN ('draft','confirmed')");
  const rows = await db.prepare(
    `SELECT o.id, o.order_no, o.order_date, o.factory_eta, o.customer_eta, o.ship_date, o.status,
            c.name AS customer_name, u.name AS sales_name
       ${BASE_JOIN} WHERE ${cond.join(' AND ')}
      ORDER BY o.customer_eta, o.id DESC LIMIT 500`
  ).all(...args);
  const today = toDateStr(new Date());
  res.json(rows.map((r) => {
    let delay = null;
    if (r.ship_date && r.customer_eta) {
      delay = Math.round((new Date(r.ship_date).getTime() - new Date(r.customer_eta).getTime()) / 86400000);
    } else if (!r.ship_date && r.customer_eta) {
      delay = Math.round((new Date(today).getTime() - new Date(r.customer_eta).getTime()) / 86400000);
    }
    return Object.assign({}, r, {
      delay_days: delay,
      risk: delay === null ? '' : (delay > 0 ? 'delay' : (delay > -3 ? 'warning' : 'ok')),
    });
  }));
}));

/** Excel 匯出：type=orders|customer|sales|product|month|receivable|delivery */
const EXPORT_DEFS = {
  orders: {
    title: '訂單明細',
    headers: {
      order_no: '訂單編號', order_date: '訂單日期', month: '月份', customer_name: '客戶',
      sales_name: '業務', currency: '幣別', exchange_rate: '匯率',
      part_no: '料號', qty: '數量', unit: '單位', unit_price: '單價',
      amount: '應收貨款', tax_rate: '稅率', tax_amount: '稅額', total: '應收總額(原幣)', total_base: '應收總額(本位幣)',
      cost_unit: '台幣單價成本', other_fee: '其他費用', cost_total: '成本總金額',
      freight_cn: '運費(大陸)', freight_tw: '運費(台灣)', freight_pct: '運費%',
      profit: '利潤', margin: '毛利', status: '狀態',
    },
    query: async (p) => await db.prepare(
      `SELECT o.order_no, o.order_date, o.month, c.name AS customer_name, u.name AS sales_name,
              o.currency, o.exchange_rate, i.part_no, i.qty, i.unit, i.unit_price, i.amount, i.tax_rate,
              i.tax_amount, i.total, i.total_base, i.cost_unit, i.other_fee, i.cost_total,
              i.freight_cn, i.freight_tw, i.freight_pct, i.profit, i.margin, o.status
         ${BASE_JOIN} JOIN order_items i ON i.order_id = o.id ${p.where}
        ORDER BY o.order_date DESC, o.id DESC, i.sort_order`
    ).all(...p.args),
  },
  receivable: {
    title: '應收帳款',
    headers: {
      receivable_no: '應收單號', order_no: '訂單編號', customer_name: '客戶',
      billing_month: '結帳月份', receivable_month: '應收月份', due_date: '兌現日', payment_date: '付款日',
      currency: '幣別', amount: '應收(原幣)', amount_base: '應收(本位幣)',
      received_amount: '已收', outstanding: '未收', confirmed: '確認付款', status: '狀態', aging: '帳齡',
    },
    query: async (p) => await db.prepare(
      `SELECT r.receivable_no, o.order_no, c.name AS customer_name, r.billing_month, r.receivable_month,
              r.due_date, r.payment_date, r.currency, r.amount, r.amount_base, r.received_amount,
              r.confirmed, r.status
         FROM receivables r JOIN orders o ON o.id = r.order_id LEFT JOIN customers c ON c.id = r.customer_id
        WHERE (${(p || {}).where || '1=1'}) AND (r.legacy IS NULL OR r.legacy = 0)
        ORDER BY r.due_date`
    ).all(...((p || {}).args || [])).map((r) => Object.assign({}, r, {
      outstanding: round(num(r.amount_base) - num(r.received_amount)),
      confirmed: r.confirmed ? '是' : '否',
      aging: r.status === 'received' ? '已結清' : agingBucket(r.due_date),
      status: { pending: '未收', partial: '部分收款', received: '已收' }[r.status] || r.status,
    })),
  },
  delivery: {
    title: '交期追蹤',
    headers: {
      order_no: '訂單編號', order_date: '訂單日期', customer_name: '客戶', sales_name: '業務',
      factory_eta: '工廠交期', customer_eta: '客戶交期', ship_date: '實際出貨', delay_days: '差異天數', status: '狀態',
    },
    query: async () => await db.prepare(
      `SELECT o.order_no, o.order_date, c.name AS customer_name, u.name AS sales_name,
              o.factory_eta, o.customer_eta, o.ship_date, o.status
         ${BASE_JOIN} ORDER BY o.customer_eta`
    ).all().map((r) => Object.assign({}, r, {
      delay_days: r.ship_date && r.customer_eta
        ? Math.round((new Date(r.ship_date).getTime() - new Date(r.customer_eta).getTime()) / 86400000)
        : '',
    })),
  },
};

router.get('/export', wrap(async (req, res) => {
  const type = str(req.query.type, 'orders');
  const def = EXPORT_DEFS[type];
  if (!def) return res.status(400).json({ error: '不支援的匯出類型：' + type });
  const rows = def.query(type === 'receivable' ? arWhere(req.query) : periodWhere(req.query));
  const buf = exportx.fromObjects(rows, def.headers, def.title);
  const fname = `${def.title}_${toDateStr(new Date())}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.end(buf);
}));

module.exports = router;
