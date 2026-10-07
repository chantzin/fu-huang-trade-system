// @ts-nocheck
'use strict';
/**
 * GC job：tokens 過期清理 / audit_logs 老化保留
 *
 * 行為：
 *   - cleanupExpiredTokens()   刪掉 expires_at < now 的所有 token
 *   - cleanupOldAudit({ retentionDays })   保留 N 天，砍更舊的（保留 cfg.gc.auditRetentionDays）
 *   - cleanupFxOld({ retentionDays })      砍 fx_daily 比保留天數舊的（與 lib/botfx.js 共用）
 *   - run({ force } = {})   跑一次完整 GC，回傳統計
 *   - startSched()          server.js 開機排程（預設每小時檢查；audit 滿足日切換時清；冪等）
 *
 * 🔒 不刪 business 資料（orders / order_items / shipments / receivables 等），
 *    只清理「流量軌跡」與「匯率快取」避免 DB 膨脹。
 */
const { db } = require('./db');
const { cfg } = require('./config');

/**
 * token 清理
 *   1. 刪掉已過期（expires_at < now）
 *   2. 【2026-09-10 健檢 P2-4】同一使用者只保留最近 N 筆未過期 token
 *      起因：admin 曾同時持有 252 筆有效 token，舊版只清「已過期」所以完全清不掉，
 *            tokens 表無限膨脹且增加簽章驗證的碰撞風險。
 *      cfg.gc.tokensKeepPerUser（預設 10；0 / null / 負數 = 不限制）
 */
function cleanupExpiredTokens() {
  const before = db.prepare('SELECT COUNT(*) AS c FROM tokens').get().c;
  db.prepare("DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < datetime('now','localtime')").run();
  const afterExpire = db.prepare('SELECT COUNT(*) AS c FROM tokens').get().c;

  // 同使用者保留最近 N 筆（以 expires_at 新→舊排序，同值時以 id 新→舊）
  let keep = Number(cfg.gc && cfg.gc.tokensKeepPerUser);
  let pruned = 0;
  if (Number.isFinite(keep) && keep > 0) {
    keep = Math.floor(keep);
    // 注意：tokens 的主鍵是 token（TEXT），沒有 id 欄位
    const r = db.prepare(`
      DELETE FROM tokens
       WHERE token IN (
         SELECT token FROM (
           SELECT token,
                  ROW_NUMBER() OVER (PARTITION BY user_id
                                     ORDER BY COALESCE(created_at, expires_at, '') DESC, token DESC) AS rn
             FROM tokens
         ) WHERE rn > ?
       )`).run(keep);
    pruned = r.changes;
  }
  const after = db.prepare('SELECT COUNT(*) AS c FROM tokens').get().c;
  return {
    tokens_removed: before - after,
    tokens_expired_removed: before - afterExpire,
    tokens_overflow_pruned: pruned,
    tokens_remaining: after,
    keep_per_user: Number.isFinite(keep) && keep > 0 ? keep : 'unlimited',
  };
}

function cleanupOldAudit({ retentionDays } = {}) {
  const days = Number(retentionDays || (cfg.gc && cfg.gc.auditRetentionDays) || 180);
  if (days < 30) return { audit_removed: 0, audit_remaining: db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c, reason: 'retention<30 跳過' };
  const before = db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c;
  db.prepare(
    "DELETE FROM audit_logs WHERE created_at IS NOT NULL AND created_at < datetime('now','localtime', ?)"
  ).run(`-${days} days`);
  const after = db.prepare('SELECT COUNT(*) AS c FROM audit_logs').get().c;
  return { audit_removed: before - after, audit_remaining: after, retention_days: days };
}

function cleanupFxOld({ retentionDays } = {}) {
  const days = Number(retentionDays || (cfg.fx && cfg.fx.bank_tw && cfg.fx.bank_tw.retentionDays) || 60);
  const before = db.prepare('SELECT COUNT(*) AS c FROM fx_daily').get().c;
  db.prepare(
    "DELETE FROM fx_daily WHERE fx_date IS NOT NULL AND fx_date < date('now','localtime', ?)"
  ).run(`-${days} days`);
  const after = db.prepare('SELECT COUNT(*) AS c FROM fx_daily').get().c;
  return { fx_removed: before - after, fx_remaining: after, retention_days: days };
}

/** 手動跑一次（管理員 API 用） */
function runNow({ force = false } = {}) {
  const tokensEnabled = (cfg.gc && cfg.gc.tokensEnabled !== false);
  const auditEnabled = (cfg.gc && cfg.gc.auditEnabled !== false);
  const fxEnabled = (cfg.gc && cfg.gc.fxEnabled !== false);

  const out = { at: new Date().toISOString(), tokensEnabled, auditEnabled, fxEnabled };
  try {
    if (tokensEnabled) out.tokens = cleanupExpiredTokens();
  } catch (e) { out.tokens_error = e.message; }
  try {
    if (auditEnabled) out.audit = cleanupOldAudit();
  } catch (e) { out.audit_error = e.message; }
  try {
    if (fxEnabled) out.fx = cleanupFxOld();
  } catch (e) { out.fx_error = e.message; }
  return out;
}

let schedInstalled = false;
/** server.js 開機呼叫：每小時檢查一次（cron 級的細節由 cfg.gc.runHour 控制 audit 砍日切換） */
function startSched() {
  if (schedInstalled) return;
  schedInstalled = true;
  const run = () => {
    try {
      const r = runNow();
      const dirty = (r.tokens && r.tokens.tokens_removed > 0) ||
                   (r.audit && r.audit.audit_removed > 0) ||
                   (r.fx && r.fx.fx_removed > 0);
      if (dirty) {
        const t = (r.tokens && r.tokens.tokens_removed) || 0;
        const a = (r.audit && r.audit.audit_removed) || 0;
        const f = (r.fx && r.fx.fx_removed) || 0;
        console.log(`[gc] 已清理 tokens=${t} audit=${a} fx=${f}`);
      }
    } catch (e) {
      console.warn('[gc] 排程失敗：' + e.message);
    }
  };
  setTimeout(run, 8000);              // 開機後 8 秒先跑一次
  setInterval(run, 60 * 60 * 1000);   // 之後每小時檢查
}

export {
  cleanupExpiredTokens,
  runNow,
  startSched,
};
