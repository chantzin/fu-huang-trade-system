// @ts-nocheck
'use strict';
/** 通用工具：數值／字串／日期處理 */

/** 轉數字。⚠️ def 預設為 0；若欄位可為 NULL（例如 FK），務必傳 null 當預設值 */
function num(v, def = 0) {
  if (v === null || v === undefined || v === '') return def;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : def;
}

function str(v, def = '') {
  if (v === null || v === undefined) return def;
  return String(v).trim();
}

/** 四捨五入到小數第 d 位 */
function round(v, d = 2) {
  const p = Math.pow(10, d);
  return Math.round((num(v) + Number.EPSILON) * p) / p;
}

/** 全系統金額小數點位數（讀 parameters.money_decimals，預設 0＝整數） */
let _moneyDigits = null;
function getMoneyDigits(force = false) {
  if (_moneyDigits !== null && !force) return _moneyDigits;
  try {
    const { db } = require('./db');
    const r = db.prepare("SELECT value FROM parameters WHERE key='money_decimals'").get();
    const n = parseInt(r ? r.value : '0', 10);
    _moneyDigits = Number.isFinite(n) && n >= 0 && n <= 6 ? n : 0;
  } catch { _moneyDigits = 0; }
  return _moneyDigits;
}
function invalidateMoneyDigits() { _moneyDigits = null; }
/** 金額四捨五入（依系統參數 money_decimals，預設整數） */
function moneyRound(v, d) { return round(v, d === undefined ? getMoneyDigits() : d); }
/** 本位幣（系統預設 TWD）。台幣金額取整數元，外幣取到分。 */
const BASE_CURRENCY = 'TWD';
function isBaseCurrency(cur: any) {
  return cur == null || String(cur).toUpperCase() === BASE_CURRENCY;
}
/** 依幣別決定金額小數位數：台幣＝0（整數元，符合營業稅「到元」規範），外幣＝2（到分） */
function decimalsFor(cur: any) {
  return isBaseCurrency(cur) ? 0 : 2;
}
/** 依幣別四捨五入（取代寫死的 round(v, 2)） */
function roundMoney(v: any, cur: any) {
  return round(v, decimalsFor(cur));
}

function today(d = new Date()) {
  return toDateStr(d);
}

function toDateStr(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/** 'YYYY-MM' */
function toMonthStr(d) {
  const s = toDateStr(d);
  return s ? s.slice(0, 7) : '';
}

/** 解析 'YYYY-MM-DD' → Date（本機時間 00:00） */
function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** 該月份最後一天 */
function endOfMonth(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + Number(n || 0));
  return x;
}

function addMonths(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth() + Number(n || 0), 1);
  return x;
}

/** 月結天數解析：'月結60天' / 'T/T 60' / '60' → 60 */
function parseTermsDays(terms, def = 60) {
  const s = String(terms || '');
  const m = s.match(/(\d{1,3})\s*天/) || s.match(/(\d{1,3})/);
  if (m) return Number(m[1]);
  return def;
}

/** 依前綴 + 序號產生單號：PREFIX + YYYYMM + 序號(4 位) */
function nextSerial(prefixKey, seqKey, prefixDef) {
  const { db } = require('./db');
  const getP = db.prepare('SELECT value FROM parameters WHERE key=?');
  const row = (k, def) => {
    const r = getP.get(k);
    return r ? r.value : def;
  };
  const setP = db.prepare("INSERT INTO parameters (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now','localtime')");
  const prefix = row(prefixKey, prefixDef);
  let seq = Number(row(seqKey, '0')) + 1;
  setP.run(seqKey, String(seq));
  const d = new Date();
  const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `${prefix}${ym}${String(seq).padStart(4, '0')}`;
}

export {
  num, str, round, today, toDateStr, toMonthStr, parseDate,
  endOfMonth, addDays, addMonths, parseTermsDays, nextSerial,
  getMoneyDigits, invalidateMoneyDigits, moneyRound,
  isBaseCurrency, decimalsFor, roundMoney,
};
