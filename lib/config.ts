// @ts-nocheck
'use strict';
/**
 * 設定讀取層：config.json（不存在或缺欄位則自動補齊寫回）
 *
 * 🔒 硬規則（慈哥明示，永久有效）
 *   1. 本系統是「獨立系統」：可獨立安裝、獨立使用、自己的 DB / port / 安裝包，不依賴 HR。
 *   2. 但必須「保留 HR 串接、共用帳密」的能力，未來必要時才串接。
 *      做法 = auth.provider：
 *        'local'  → 用本機 users 表密碼驗證（預設，完全獨立）
 *        'shared' → 把 empId+password 代理到 HR /api/auth/login 驗證
 *      切換 provider 不需改動任何路由或 token 結構。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const EXAMPLE_PATH = path.join(__dirname, '..', 'config.json.example');

const DEFAULT_AUTH = {
  provider: 'local', // local | shared
  tokenTtlDays: 7,
  tokenSecret: '',
  // No built-in credential. Configure a one-time bootstrap account locally only when required.
  bootstrapAdmin: null as any,
  shared: { hrBaseUrl: 'http://localhost:3000', hrLoginPath: '/api/auth/login' },
  // 🔒 MFA 技術強制：列於此陣列的角色，登入時若尚未啟用 MFA，將被導向強制綁定流程（不發 session）。
  // 預設空陣列 = 關閉強制：新安裝僅需「帳號＋密碼」即可登入；使用者可於「安全設定」自行啟用 MFA（mfaEnabled 仍為 true，保留自願綁定能力）。
  // 可由 dist-server/config.json 的 auth.requireMfaRoles 覆寫（例如改為 ["admin","manager"] 恢復強制）。
  requireMfaRoles: [] as string[],
  // 🔒 MFA 全域開關：true=啟用 MFA（預設，功能完整）；false=暫時關閉「所有」MFA 挑戰，
  //    登入僅需帳號＋密碼（公司內部暫用）。可由 dist-server/config.json 的 auth.mfaEnabled 覆寫為 false。
  //    關閉時已綁定使用者的 mfa_enabled 狀態保留，未來改回 true 即自動恢復挑戰，無需重新綁定。
  mfaEnabled: true as boolean,
};

// HR 角色 → 本系統角色（本系統角色：admin / manager / accounting / sales）
const DEFAULT_ROLE_MAP = {
  admin: ['admin', 'super'],
  manager: ['manager'],
  accounting: ['accounting', 'finance', '會計'],
  sales: ['sales', 'member', 'user'],
};

const DEFAULT_CURRENCY = {
  base: 'TWD',
  supported: ['TWD', 'USD', 'RMB'],
  rates: { TWD: 1, USD: 31.5, RMB: 4.35 },
};

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function load() {
  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {}; } catch { raw = {}; }
  } else if (fs.existsSync(EXAMPLE_PATH)) {
    // 首次啟動：以範本為底（但不把 tokenSecret 之類的機密帶進來）
    try { raw = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf8')) || {}; } catch { raw = {}; }
  }
  delete raw._note;

  const auth = deepMerge(DEFAULT_AUTH, raw.auth || {});
  // CI/first-install override is process-local and never written back to config.json.
  if (process.env.BOOTSTRAP_ADMIN_PASSWORD) {
    auth.bootstrapAdmin = {
      empId: process.env.BOOTSTRAP_ADMIN_EMP_ID || 'ADMIN',
      name: process.env.BOOTSTRAP_ADMIN_NAME || '系統管理員',
      password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
    };
  }
  if (!auth.tokenSecret) auth.tokenSecret = crypto.randomBytes(32).toString('hex');

  const cfg = deepMerge(
    {
      port: 5200,
      host: '0.0.0.0',
      app_name: '輔凰商貿訂單暨應收帳款系統',
      auth,
      https: { enabled: false, port: 5443, certFile: '', keyFile: '' },
      security: { httpLocalOnly: true, allowedRemoteCidrs: [] },
      roleMap: DEFAULT_ROLE_MAP,
      currency: DEFAULT_CURRENCY,
      ar: { basis: 'month_end', defaultTermsDays: 60 },
      backup: { dir: '', keep: 30, maxDays: 90, autoDaily: true, hour: 3 },
      log: { dir: '', keepDays: 14 },
      // 郵件設定（預設 ethereal.email 測試模式，不會誤寄真實郵件）
      // 若要切真實 SMTP，在 config.json 加：
      //   "mail": { "from": "...", "smtp": { "host": "...", "port": 587, "user": "...", "pass": "..." } }
      mail: { from: '', smtp: null },
      // PDF 數位簽章密鑰（不設定則用預設；正式環境建議改為環境變數 APP_PDF_SIGN_SECRET）
      pdf: { signSecret: '' },
      // 台灣銀行牌告匯率（每日擷取 USD / CNY，保留 N 天）
      fx: {
        bank_tw: { enabled: true, currencies: ['USD', 'CNY'], retentionDays: 60, fetchHour: 8 },
      },
      // GC 排程（tokens / audit / fx）—— 每小時自動跑，符合條件才刪
      gc: {
        tokensEnabled: true,
        auditEnabled: true,
        fxEnabled: true,
        auditRetentionDays: 180, // 操作日誌保留半年
        // 2026-09-10 健檢 P2-4：同一使用者最多保留 N 筆未過期 token（0 或 null = 不限制）
        // 起因：admin 曾同時持有 252 筆有效 token，舊 GC 只清「已過期」，完全清不到。
        tokensKeepPerUser: 10,
      },
      // MySQL 平行驗證線定時對齊（與 cfg.parity.runHour 觸發）
      parity: {
        enabled: true,
        runHour: 7,           // 每日 7:00 觸發（避開 botfx 的 8:00 與 GC 排程）
        timeoutMs: 5 * 60 * 1000,
      },
      // P3-2 雙軌容錯：db 層 failover 選擇器（預設關閉；啟用後主庫 SQLite 故障自動切備庫 MySQL）
      db: {
        failover: {
          enabled: false,
          host: '127.0.0.1',
          port: 3306,
          user: 'root',
          password: '',            // 實際密碼放 config.json（不進版控）
          database: 'trade',
          connectionLimit: 5,
          healthIntervalMs: 15000, // 健康探測間隔
          connectTimeoutMs: 4000,
        },
      },
    },
    Object.assign({}, raw, { auth, roleMap: deepMerge(DEFAULT_ROLE_MAP, raw.roleMap || {}) })
  );

  // 🔒 host 永遠 0.0.0.0，避免又寫死成舊 LAN IP
  cfg.host = '0.0.0.0';

  try {
    const diskCfg = JSON.parse(JSON.stringify(cfg));
    // Do not persist a bootstrap password supplied through a process environment.
    if (process.env.BOOTSTRAP_ADMIN_PASSWORD && diskCfg.auth) diskCfg.auth.bootstrapAdmin = null;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(diskCfg, null, 2), 'utf8');
  } catch { /* 唯讀環境忽略 */ }
  return cfg;
}

const cfg = load();

/** HR 角色 → 本系統角色（對應不到則給最小權限 sales） */
function mapRole(hrRole) {
  const r = String(hrRole || '').toLowerCase();
  for (const [local, hrRoles] of Object.entries(cfg.roleMap)) {
    if ((hrRoles || []).map((x) => String(x).toLowerCase()).includes(r)) return local;
  }
  return 'sales';
}

export { cfg, mapRole };
