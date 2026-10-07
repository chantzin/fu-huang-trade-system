// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.BASE = void 0;
exports.getParam = getParam;
exports.getRate = getRate;
exports.calcItem = calcItem;
exports.calcOrderTotals = calcOrderTotals;
exports.deriveAR = deriveAR;
exports.agingBucket = agingBucket;
exports.arTermsBasis = arTermsBasis;
exports.orderTermsBasis = orderTermsBasis;
/**
 * 計算引擎（本系統的核心價值：取代人工 Key 算）
 *
 * 多幣別模型：
 *   - 訂單單價／應收金額以「原幣」計算（amount / tax_amount / total）
 *   - 依匯率轉「本位幣」（total_base）後，才與成本、運費一起算利潤
 *   - 成本（台幣單價成本、其他費用）與運費（大陸／台灣）一律為本位幣 TWD
 *
 * 公式（與建議書一致）：
 *   應收貨款 amount      = 數量 × 單價
 *   稅額     tax_amount  = amount × 稅率
 *   應收總額 total       = amount + tax_amount         （原幣）
 *   本位幣總額 total_base= total × 匯率
 *   成本總額 cost_total  = 台幣單價成本 × 數量 + 其他費用
 *   運費     freight     = 運費(大陸) + 運費(台灣)
 *   運費%    freight_pct = freight ÷ amount(本位幣) × 100
 *   利潤     profit      = total_base − cost_total − freight
 *   毛利%    margin      = profit ÷ total_base
 */
const { db } = require('./db');
const { cfg } = require('./config');
const { num, round, moneyRound, parseDate, endOfMonth, addDays, addMonths, toMonthStr, toDateStr, parseTermsDays, decimalsFor } = require('./util');
const BASE = (cfg.currency && cfg.currency.base) || 'TWD';
exports.BASE = BASE;
function getParam(key, def = null) {
    const r = db.prepare('SELECT value FROM parameters WHERE key=?').get(key);
    return r ? r.value : def;
}
/**
 * 取得匯率（1 單位 currency = ? 本位幣）
 * 優先序：當日（或指定日）之前最新的匯率歷程 → config.currency.rates → 1
 */
function getRate(currency, dateStr) {
    const cur = String(currency || BASE).toUpperCase();
    if (cur === BASE)
        return 1;
    const d = dateStr || toDateStr(new Date());
    const row = db
        .prepare('SELECT rate FROM exchange_rates WHERE currency=? AND effective_date<=? ORDER BY effective_date DESC, id DESC LIMIT 1')
        .get(cur, d);
    if (row && Number(row.rate) > 0)
        return Number(row.rate);
    const fallback = cfg.currency && cfg.currency.rates ? cfg.currency.rates[cur] : null;
    if (fallback && Number(fallback) > 0)
        return Number(fallback);
    return 1;
}
/**
 * 重算單筆訂單明細的所有衍生欄位
 * @param {object} it 明細欄位（qty / unit_price / tax_rate / cost_unit / other_fee / freight_cn / freight_tw）
 * @param {object} ctx { exchange_rate, currency }
 * @returns {object} 含全部計算結果（回寫用）
 */
function calcItem(it, ctx = {}) {
    const rate = ctx.exchange_rate !== undefined && ctx.exchange_rate !== null
        ? num(ctx.exchange_rate, 1)
        : getRate(ctx.currency, ctx.order_date);
    const qty = num(it.qty);
    const unitPrice = num(it.unit_price);
    const taxRate = num(it.tax_rate, num(getParam('tax_rate', 0.05)));
    // 台幣（本位幣）取整數元、外幣到分——與 routes/*.js saveItems / 前端 calcRow 一致
    const dec = decimalsFor(ctx.currency);
    const amount = round(qty * unitPrice, dec);
    const taxAmount = round(amount * taxRate, dec);
    const total = round(amount + taxAmount, dec);
    const totalBase = moneyRound(total * rate);
    const costUnit = num(it.cost_unit);
    const otherFee = num(it.other_fee);
    const costTotal = moneyRound(costUnit * qty + otherFee);
    const freightCn = num(it.freight_cn);
    const freightTw = num(it.freight_tw);
    const freight = moneyRound(freightCn + freightTw);
    const profit = moneyRound(totalBase - costTotal - freight);
    const margin = totalBase > 0 ? round(profit / totalBase, 6) : 0;
    const freightPct = totalBase > 0 ? round((freight / totalBase) * 100, 4) : 0;
    return {
        qty,
        unit_price: unitPrice,
        amount,
        tax_rate: taxRate,
        tax_amount: taxAmount,
        total,
        total_base: totalBase,
        cost_unit: costUnit,
        other_fee: otherFee,
        cost_total: costTotal,
        freight_cn: freightCn,
        freight_tw: freightTw,
        freight: freight,
        freight_pct: freightPct,
        profit,
        margin,
        exchange_rate: rate,
    };
}
/** 整張訂單的合計（原幣／本位幣分開加總） */
function calcOrderTotals(items) {
    const t = {
        qty: 0, amount: 0, tax_amount: 0, total: 0, total_base: 0,
        cost_total: 0, freight_cn: 0, freight_tw: 0, freight: 0,
        other_fee: 0, profit: 0, margin: 0, freight_pct: 0,
    };
    for (const it of items || []) {
        t.qty += num(it.qty);
        t.amount += num(it.amount);
        t.tax_amount += num(it.tax_amount);
        t.total += num(it.total);
        t.total_base += num(it.total_base);
        t.cost_total += num(it.cost_total);
        t.freight_cn += num(it.freight_cn);
        t.freight_tw += num(it.freight_tw);
        t.freight += num(it.freight_cn) + num(it.freight_tw);
        t.other_fee += num(it.other_fee);
        t.profit += num(it.profit);
    }
    t.amount = round(t.amount, 2);
    t.tax_amount = round(t.tax_amount, 2);
    t.total = round(t.total, 2);
    t.total_base = moneyRound(t.total_base);
    t.cost_total = moneyRound(t.cost_total);
    t.freight = moneyRound(t.freight);
    t.profit = moneyRound(t.profit);
    t.margin = t.total_base > 0 ? round(t.profit / t.total_base, 6) : 0;
    t.freight_pct = t.total_base > 0 ? round((t.freight / t.total_base) * 100, 4) : 0;
    return t;
}
/**
 * 依「客戶」解析其帳期規則的 basis（month_end / next_month_start / cash / prepaid）
 * 【2026-09-10 健檢 N4】現金款／預付款客戶若沿用全域 month_end，到期日會被算成「月底 + N 天」而整個錯掉。
 * 只回傳 basis，不回傳 days —— days 仍以訂單上的 terms_days 為準（避免 ar_terms.days 與
 * customers.terms_days 語意不一致造成既有資料變動）。
 * @param {number|string} customerId
 * @returns {string|null} 解析不到則回傳 null（呼叫端退回全域設定）
 */
function arTermsBasis(customerId) {
    if (!customerId)
        return null;
    try {
        const c = db.prepare('SELECT ar_terms_id, payment_terms FROM customers WHERE id=?').get(customerId);
        if (!c)
            return null;
        if (c.ar_terms_id) {
            const t = db.prepare('SELECT basis FROM ar_terms WHERE id=?').get(c.ar_terms_id);
            if (t && t.basis)
                return String(t.basis);
        }
        if (c.payment_terms) {
            const t2 = db.prepare('SELECT basis FROM ar_terms WHERE name=?').get(String(c.payment_terms).trim());
            if (t2 && t2.basis)
                return String(t2.basis);
        }
    }
    catch { /* 表不存在／查不到 → 退回全域設定 */ }
    return null;
}
/**
 * 依「訂單」解析帳期 basis（訂單 → 客戶 → ar_terms），供到期日推導使用。
 */
function orderTermsBasis(order) {
    if (!order)
        return {};
    const basis = arTermsBasis(order.customer_id);
    return basis ? { basis } : {};
}
/**
 * 應收帳款日期推導（月結條件）
 * @param {string} baseDate  基準日（優先出貨日，沒出貨則用訂單日）
 * @param {number|string} termsDaysOrText 月結天數或交易條件文字
 * @returns {{billing_month:string, receivable_month:string, due_date:string, payment_date:string}}
 *
 * 規則（可用 config.ar.basis 切換）：
 *   month_end        → 結帳月份 = 基準日月；兌現日 = 該月月底 + N 天
 *   next_month_start → 結帳月份 = 基準日月；兌現日 = 次月 1 日 + (N-1) 天
 */
function deriveAR(baseDate, termsDaysOrText, options = {}) {
    // 優先從 options（ar_terms 規則）讀取 basis/days，其次從 parameters 表，最後用 config.json
    let basis = options.basis || (cfg.ar && cfg.ar.basis) || 'month_end';
    if (!options.basis) {
        try {
            const row = db.prepare("SELECT value FROM parameters WHERE key='ar_basis'").get();
            if (row && row.value && ['month_end', 'next_month_start', 'cash', 'prepaid'].includes(row.value))
                basis = row.value;
        }
        catch { /* 參數表不存在時用 config.json */ }
    }
    const defDays = num(cfg.ar && cfg.ar.defaultTermsDays, 60);
    // options.days 優先（ar_terms 規則的天數），其次從 termsDaysOrText 解析
    const days = options.days !== undefined
        ? num(options.days, 0)
        : (/^\d+$/.test(String(termsDaysOrText))
            ? Number(termsDaysOrText)
            : parseTermsDays(termsDaysOrText, defDays));
    const d = parseDate(baseDate) || new Date();
    const billingMonth = toMonthStr(d);
    let due;
    if (basis === 'cash' || basis === 'prepaid') {
        // 現金款／預付款：兌現日＝基準日（當天）
        due = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
    else if (basis === 'next_month_start') {
        due = addDays(new Date(d.getFullYear(), d.getMonth() + 1, 1), Math.max(0, days - 1));
    }
    else {
        const eom = endOfMonth(toDateStr(d));
        due = addDays(eom, days);
    }
    const dueStr = toDateStr(due);
    return {
        billing_month: billingMonth,
        receivable_month: toMonthStr(due),
        due_date: dueStr,
        payment_date: dueStr,
        terms_days: days,
        basis,
    };
}
/** 帳齡分級（以今天 vs 兌現日） */
function agingBucket(dueDate, todayStr) {
    const due = parseDate(dueDate);
    const now = parseDate(todayStr || toDateStr(new Date()));
    if (!due || !now)
        return 'unknown';
    const diff = Math.floor((now.getTime() - due.getTime()) / 86400000);
    if (diff < 0)
        return '未到期';
    if (diff <= 30)
        return '逾期1-30天';
    if (diff <= 60)
        return '逾期31-60天';
    if (diff <= 90)
        return '逾期61-90天';
    return '逾期90天以上';
}
