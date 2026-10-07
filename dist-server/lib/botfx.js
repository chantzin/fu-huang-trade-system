// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureTodayFetched = ensureTodayFetched;
exports.listDaily = listDaily;
exports.status = status;
/**
 * 台灣銀行牌告匯率串接（每日擷取 USD / CNY，保留 N 天）
 *
 * 資料來源：https://rate.bot.com.tw/xrt?Lang=zh-TW
 *   頁面為「牌告匯率」表格，每個幣別以 td[data-table="本行現金買入/賣出/即期買入/即期賣出"] 標示。
 *   一個幣別會同時出現在「現金」與「即期」兩個欄群，故解析時取前 4 個 data-table 值即可。
 *
 * 儲存：fx_daily（每幣別每日一筆，upsert on fx_date+currency）
 * 保留：每次擷取後自動刪除超過 config.fx.bank_tw.retentionDays 天前的資料
 *
 * 🔒 硬規則：本系統為獨立系統，此模組僅抓取公開牌告匯率，不與其他系統串接。
 */
const { db } = require('./db');
const { cfg } = require('./config');
const { toDateStr } = require('./util');
const FX_URL = 'https://rate.bot.com.tw/xrt?Lang=zh-TW';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
/** 讀取設定（config.json → fx.bank_tw，缺欄位用預設） */
function getConf() {
    const fx = (cfg.fx && cfg.fx.bank_tw) || {};
    return {
        enabled: fx.enabled !== false,
        currencies: Array.isArray(fx.currencies) && fx.currencies.length ? fx.currencies : ['USD', 'CNY'],
        retentionDays: Number(fx.retentionDays) > 0 ? Number(fx.retentionDays) : 60,
        fetchHour: Number(fx.fetchHour) >= 0 ? Number(fx.fetchHour) : 8,
    };
}
/**
 * 從台銀 HTML 解析匯率
 * @param {string} html
 * @returns {Array<{currency, cash_buy, cash_sell, spot_buy, spot_sell, mid_rate}>}
 */
function parseHtml(html) {
    const conf = getConf();
    const out = [];
    for (const code of conf.currencies) {
        const i = html.indexOf('(' + code + ')');
        if (i < 0)
            continue;
        const seg = html.slice(i, i + 2600);
        const kv = {};
        const re = /data-table="([^"]+)"[^>]*>\s*([\d.]+)\s*</g;
        let m;
        let seq = 0;
        while ((m = re.exec(seg)) !== null) {
            if (seq >= 4)
                break; // 只取「現金買/賣、即期買/賣」前 4 個，跳過重複
            switch (m[1]) {
                case '本行現金買入':
                    kv.cash_buy = Number(m[2]);
                    break;
                case '本行現金賣出':
                    kv.cash_sell = Number(m[2]);
                    break;
                case '本行即期買入':
                    kv.spot_buy = Number(m[2]);
                    break;
                case '本行即期賣出':
                    kv.spot_sell = Number(m[2]);
                    break;
            }
            seq++;
        }
        if (kv.spot_buy && kv.spot_sell) {
            kv.currency = code;
            kv.mid_rate = Math.round(((kv.spot_buy + kv.spot_sell) / 2) * 1000000) / 1000000;
            out.push(kv);
        }
    }
    return out;
}
/** 擷取台銀牌告匯率（只抓不寫庫） */
async function fetchBotRates() {
    const res = await fetch(FX_URL, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' },
        redirect: 'follow',
    });
    if (!res.ok)
        throw new Error('台銀網頁回應 ' + res.status);
    const html = await res.text();
    const rates = parseHtml(html);
    if (!rates.length)
        throw new Error('解析不到匯率資料（來源可能改版）');
    return rates;
}
/**
 * 將匯率寫入 fx_daily（upsert on fx_date+currency）
 * @returns {{date:string, count:number}}
 */
function ingestDaily(rates, fxDate) {
    const date = fxDate || toDateStr(new Date());
    const stmt = db.prepare(`
    INSERT INTO fx_daily (fx_date, currency, cash_buy, cash_sell, spot_buy, spot_sell, mid_rate, source)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(fx_date, currency) DO UPDATE SET
      cash_buy=excluded.cash_buy, cash_sell=excluded.cash_sell,
      spot_buy=excluded.spot_buy, spot_sell=excluded.spot_sell,
      mid_rate=excluded.mid_rate, fetched_at=datetime('now','localtime')
  `);
    const tx = db.transaction(() => {
        for (const r of rates)
            stmt.run(date, r.currency, r.cash_buy, r.cash_sell, r.spot_buy, r.spot_sell, r.mid_rate, 'bank_tw');
    });
    tx();
    return { date, count: rates.length };
}
/** 清除超過保留天數的資料，回傳刪除筆數 */
function purgeOld() {
    const conf = getConf();
    const cutoff = toDateStr(new Date(Date.now() - conf.retentionDays * 86400000));
    return db.prepare('DELETE FROM fx_daily WHERE fx_date < ?').run(cutoff).changes;
}
/**
 * 確認今日資料已擷取（沒有才抓）— 供開機 + 定時呼叫；force 強制重抓
 */
async function ensureTodayFetched({ force = false } = {}) {
    const conf = getConf();
    if (!conf.enabled)
        return { skipped: true, reason: 'disabled' };
    const today = toDateStr(new Date());
    if (!force) {
        const existing = db.prepare('SELECT COUNT(*) AS n FROM fx_daily WHERE fx_date=?').get(today);
        if (existing && existing.n > 0)
            return { skipped: true, reason: 'already_today', date: today };
    }
    const rates = await fetchBotRates();
    const ingested = ingestDaily(rates, today);
    const purged = purgeOld();
    return { date: ingested.date, count: ingested.count, purged };
}
/** 列出 fx_daily（依日期倒序） */
function listDaily(opts = {}) {
    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 200;
    return db.prepare('SELECT * FROM fx_daily ORDER BY fx_date DESC, currency ASC LIMIT ?').all(limit);
}
/** 彙總狀態（供前端顯示設定 / 上次抓取） */
function status() {
    const conf = getConf();
    const row = db
        .prepare('SELECT MAX(fx_date) AS last_date, COUNT(*) AS total, COUNT(DISTINCT fx_date) AS days FROM fx_daily')
        .get();
    return {
        config: conf,
        url: FX_URL,
        lastDate: row.last_date,
        totalRecords: row.total,
        totalDays: row.days,
    };
}
