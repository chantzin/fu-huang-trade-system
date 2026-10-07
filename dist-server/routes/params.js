'use strict';
/** 系統參數 + 匯率歷程（多幣別） */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireAdmin, requireManager } = require('../lib/auth');
const audit = require('../lib/audit');
const { num, str, toDateStr } = require('../lib/util');
const { cfg } = require('../lib/config');
const botfx = require('../lib/botfx');

const router = express.Router();
router.use(requireAuth);

const STATUS_LABEL = {
  draft: '草稿', confirmed: '已確認', shipped: '已出貨', billed: '已結帳',
  paid: '已收款', closed: '結案', cancelled: '作廢',
};

/** 前端下拉選單用的中繼資料 */
router.get('/meta', (req, res) => {
  res.json({
    base: (cfg.currency && cfg.currency.base) || 'TWD',
    currencies: (cfg.currency && cfg.currency.supported) || ['TWD', 'USD', 'RMB'],
    defaultRates: (cfg.currency && cfg.currency.rates) || {},
    statuses: STATUS_LABEL,
    roles: { admin: '管理者', manager: '主管', accounting: '會計', sales: '業務' },
    arBasis: (cfg.ar && cfg.ar.basis) || 'month_end',
    appName: cfg.app_name,
  });
});

router.get('/', (req, res) => {
  // 開放所有參數（含 numbering 前綴），但過濾：
  //  1. *_seq（自動序號，不應手動修改）
  //  2. 已有專屬功能區的參數（系統外觀、郵件設定、帳期規則各自管理，不重複顯示於參數設定）
  const HIDDEN_KEYS = [
    'company_name', 'company_address', 'company_phone', 'company_logo', 'system_background',
    'system_theme',
    'mail_from', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_secure', 'mail_footer',
    'ar_basis',
  ];
  const rows = db.prepare(
    "SELECT * FROM parameters WHERE key NOT LIKE '%_seq' ORDER BY group_name, key"
  ).all().filter((p) => !HIDDEN_KEYS.includes(p.key));
  res.json(rows);
});

/** 刪除參數（僅 manager 以上；保護系統關鍵參數） */
router.delete('/:key', requireManager, (req, res) => {
  const key = String(req.params.key);
  // 保護清單：不可刪除的系統關鍵參數
  const PROTECTED = ['tax_rate', 'ar_basis'];
  if (PROTECTED.includes(key)) {
    return res.status(403).json({ error: '此參數為系統關鍵參數，不可刪除（可修改值）' });
  }
  if (key.endsWith('_seq')) {
    return res.status(403).json({ error: '自動序號參數不可刪除' });
  }
  const r = db.prepare('SELECT * FROM parameters WHERE key=?').get(key);
  if (!r) return res.status(404).json({ error: '參數不存在' });
  db.prepare('DELETE FROM parameters WHERE key=?').run(key);
  audit.log(req, 'delete', 'parameters', key, r.value);
  res.json({ ok: true });
});

/** 整批更新參數（{ key: value }） */
router.put('/', requireManager, async (req, res, next) => {
  try {
    const b = req.body || {};
    const values = b.values || b;
    const stmt = db.prepare(
      `INSERT INTO parameters (key, value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now','localtime')`
    );
    const tx = db.transaction(async () => {
      for (const [k, v] of Object.entries(values)) {
        if (String(k).startsWith('_')) continue;
        await stmt.run(String(k), String(v));
      }
    });
    await tx();
    audit.log(req, 'update', 'parameters', '', Object.keys(values).join(','));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ================= 匯率歷程 ================= */

router.get('/rates', (req, res) => {
  const cur = str(req.query.currency);
  const sql = cur
    ? 'SELECT * FROM exchange_rates WHERE currency=? ORDER BY effective_date DESC, id DESC LIMIT 200'
    : 'SELECT * FROM exchange_rates ORDER BY effective_date DESC, id DESC LIMIT 200';
  res.json(cur ? db.prepare(sql).all(cur) : db.prepare(sql).all());
});

router.post('/rates', requireManager, (req, res) => {
  const b = req.body || {};
  const cur = str(b.currency).toUpperCase();
  const rate = num(b.rate, 0);
  if (!cur) return res.status(400).json({ error: '請選擇幣別' });
  if (rate <= 0) return res.status(400).json({ error: '匯率必須大於 0' });
  const info = db.prepare('INSERT INTO exchange_rates (currency, rate, effective_date, note) VALUES (?,?,?,?)')
    .run(cur, rate, str(b.effective_date) || toDateStr(new Date()), str(b.note));
  audit.log(req, 'create', 'exchange_rates', info.lastInsertRowid, `${cur}=${rate}`);
  res.json(db.prepare('SELECT * FROM exchange_rates WHERE id=?').get(info.lastInsertRowid));
});

router.delete('/rates/:id', requireManager, (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM exchange_rates WHERE id=?').get(id);
  if (!r) return res.status(404).json({ error: '匯率紀錄不存在' });
  db.prepare('DELETE FROM exchange_rates WHERE id=?').run(id);
  audit.log(req, 'delete', 'exchange_rates', id, r.currency);
  res.json({ ok: true });
});

/* ================= 台灣銀行牌告匯率（每日擷取） ================= */

/** 列出每日牌告匯率（依日期倒序） */
router.get('/fx', (req, res) => {
  res.json(botfx.listDaily({ limit: num(req.query.limit, 200) }));
});

/** 擷取狀態（設定 / 上次抓取 / 資料統計） */
router.get('/fx/status', (req, res) => {
  res.json(botfx.status());
});

/** 立即抓取台銀匯率（會寫入今日資料並清理超過保留天數的舊資料） */
router.post('/fx/refresh', requireManager, async (req, res) => {
  try {
    const r = await botfx.ensureTodayFetched({ force: true });
    audit.log(req, 'update', 'fx_daily', '', `台銀匯率擷取 (${r.date}, ${r.count || 0}筆, 清理${r.purged || 0})`);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(502).json({ ok: false, error: '擷取失敗：' + e.message });
  }
});

/* ================= 操作日誌 ================= */

router.get('/audit-logs', requireAdmin, (req, res) => {
  const q = req.query || {};
  const auditLib = require('../lib/audit');
  res.json(auditLib.list({
    limit: num(q.limit, 200),
    entity: str(q.entity),
    action: str(q.action),
    keyword: str(q.keyword),
  }));
});

/* ================= MySQL 平行驗證線：手動觸發 + 上次結果 ================= */
const parity = require('../lib/parity');
router.get('/parity/last', requireAdmin, (req, res) => {
  res.json(parity.lastResult());
});
router.post('/parity/run', requireAdmin, async (req, res) => {
  try {
    const r = await parity.runNow();
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
