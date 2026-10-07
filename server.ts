/**
 * 輔凰商貿 — 貿易訂單暨應收應付管理系統（主程式，TypeScript 版）
 * 模組化架構：lib/（設定、DB、認證、計算引擎、稽核、匯出）+ routes/（各 API 模組）+ dist/（Vite + Preact 前端）
 *
 * 🔒 硬規則
 *   - 帳號識別一律「工號」emp_id；登入收 empId + password
 *   - auth.provider = local（獨立可安裝）／shared（預留 HR 串接），切換不改路由與 token 結構
 */
import './lib/logger'; // 必須最早掛載，才能捕到初始化錯誤
import { installGlobalHandlers } from './lib/logger';
installGlobalHandlers();

import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as net from 'net';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { db, initSchema } from './lib/db';
import { requireAuth, requireAdmin, bootstrapAdmin, cleanupExpiredTokens } from './lib/auth';
import { cfg } from './lib/config';
import * as license from './lib/license';

initSchema();
bootstrapAdmin(); // 確保至少一位管理員（工號來自 config.auth.bootstrapAdmin）
cleanupExpiredTokens().catch((e) => console.warn('[auth] token cleanup failed:', e.message));

// 授權檔：啟動時載入並記錄；無檔/簽章錯 => 開放模式（全開＋警告），不影響現有部署
const licState = license.loadState();
console.log(`[license] 授權模式=${licState.mode} 原因=${licState.reason}` + (licState.license ? ` 客戶=${licState.license.licensee} 模組=${licState.license.modules.join(',')} 席次=${licState.license.seats} 到期=${licState.license.expiresAt}` : ''));

const dbFailover = require('./lib/db-failover');
dbFailover.configure(cfg, db); // P3-2 雙軌容錯：啟用時建立備庫連線池與健康探測

const app = express();
app.locals.config = cfg;
// 🔒 路徑基準：編譯後本檔位於 <app>/dist-server/server.js，應用根為上一層
const APP_ROOT = path.join(__dirname, '..');
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

function ipv4InCidr(address: string, cidr: string): boolean {
  const normalized = String(address || '').replace(/^::ffff:/, '');
  const [network, prefixText] = String(cidr || '').split('/');
  if (net.isIP(normalized) !== 4 || net.isIP(network) !== 4) return false;
  const prefix = prefixText === undefined ? 32 : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const toInt = (ip: string) => ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (toInt(normalized) & mask) === (toInt(network) & mask);
}

// App-layer guard is retained even if the Windows firewall has a broad Node rule.
app.use((req: Request, res: Response, next: NextFunction) => {
  const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const encrypted = Boolean((req.socket as any).encrypted);
  const security = cfg.security || {};
  if (security.httpLocalOnly && !encrypted && remote !== '127.0.0.1' && remote !== '::1') {
    res.status(403).json({ error: '此 HTTP 入口僅供本機健康檢查，請改用 HTTPS' });
    return;
  }
  if (encrypted && remote !== '127.0.0.1' && remote !== '::1'
      && Array.isArray(security.allowedRemoteCidrs) && security.allowedRemoteCidrs.length
      && !security.allowedRemoteCidrs.some((cidr: string) => ipv4InCidr(remote, cidr))) {
    res.status(403).json({ error: '來源網段未獲授權' });
    return;
  }
  next();
});

// 內部系統：允許跨域以便前後端分離測試與行動裝置連線
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    app: cfg.app_name,
    port: cfg.port,
    time: new Date().toISOString(),
    db: path.basename((db as any).name || 'memory'),
    provider: cfg.auth.provider,
  });
});

// 全站 API 授權（登入、健康檢查、公司檔案讀取除外）
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const p = req.path;
  if (p === '/auth/login' || p === '/auth/verify-mfa' || p === '/auth/mfa/setup-start' || p === '/auth/mfa/setup-finish' || p === '/health' || p === '/version' || (p === '/company-profile' && req.method === 'GET')) { next(); return; }
  requireAuth(req, res, next);
});

// 授權模組映射：/api/<seg> → 模組鍵（與授權檔 modules[] 對照）
const MODULE_OF: Record<string, string> = {
  auth: 'auth', users: 'users', customers: 'crm', products: 'products',
  suppliers: 'crm', orders: 'orders', quotes: 'quotes', shipments: 'shipments',
  receivables: 'receivables', reports: 'reports', params: 'system', import: 'import',
  pdf: 'pdf', email: 'email', 'mail-config': 'email', 'mail-logs': 'email',
  manuals: 'manuals', 'ar-terms': 'receivables', 'supplier-quotes': 'supplier',
  'supplier-orders': 'supplier', 'supplier-shipments': 'supplier', payables: 'payables',
  forms: 'forms', 'system-settings': 'system', 'company-profile': 'system',
  backup: 'backup', approvals: 'approvals', 'customer-statements': 'receivables',
  fingerprints: 'pdf', 'system-update': 'system', inventory: 'inventory',
};

// 授權檔：模組 / 席次 / 期限 擋截（fail-closed：無授權檔或驗章失敗 = 試用受限模式 trial，期滿 = expired/403）
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const p = req.path;
  // 安全路由永遠放行（登入 / 健康 / 公司檔案讀取 / 授權狀態查詢 / 系統維運）
  if (p === '/auth/login' || p === '/health' || (p === '/company-profile' && req.method === 'GET') || p === '/license' || p.startsWith('/license/') || p === '/license-state' || p.startsWith('/system') || p.startsWith('/audit')) {
    return next();
  }
  const s = license.getState();
  if (s.mode === 'expired') {
    return res.status(403).json({ error: '授權已到期，請聯絡供應商續約。', license: s });
  }
  // trial / licensed：模組擋截（trial 為全模組開放，故僅 licensed 會被攔）
  const seg = p.split('/')[1] || '';
  const mod = MODULE_OF[seg] || seg;
  if (!license.isModuleEnabled(mod)) {
    return res.status(403).json({ error: `模組「${mod}」未授權（授權檔未含此模組），請聯絡供應商升級。`, license: { mode: s.mode, module: mod } });
  }
  // 席次擋截：建立使用者不得超過授權席次（seats=0 表示不限；trial 固定 2 席）
  if (p === '/users' && req.method === 'POST' && s.seats && s.seats > 0) {
    try {
      const row = (db as any).prepare('SELECT count(*) AS n FROM users').get();
      if (row && row.n >= s.seats) {
        return res.status(409).json({ error: `已達授權席次上限（${s.seats}），無法新增使用者。`, license: { mode: s.mode, seats: s.seats, used: row.n } });
      }
    } catch { /* 忽略，交給後續路由處理 */ }
  }
  next();
});

// 首次登入強制改密（B2）：must_change_pwd 期間，除少數安全路由外一律 403 阻擋
const MUST_CHANGE_ALLOW = new Set(['/auth/login', '/auth/logout', '/auth/me', '/auth/change-password', '/health', '/version', '/license-state']);
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return next();              // 未登入（login/health 等）直接放行
  if (!req.user.mustChangePwd) return next(); // 已改過密碼
  const p = req.path;
  if (p === '/company-profile' && req.method === 'GET') return next();
  if (MUST_CHANGE_ALLOW.has(p) || p.startsWith('/license') || p.startsWith('/auth/mfa')) return next();
  return res.status(403).json({ error: '請先修改登入密碼後再使用系統。', mustChangePwd: true });
});

// 授權狀態查詢 + 授權檔匯入（管理者/主管；負責驗章與續約）
app.use('/api/license', require('./routes/license-import'));

// 公開授權狀態（所有登入使用者可讀，供 sidebar 顯示授權方案/版本；非超級管理員亦可）
app.get('/api/license-state', (req: Request, res: Response) => {
  res.json(license.getState());
});

// 系統版本號（供 sidebar 顯示 Ver.；從根 version.json 即時讀取）
app.get('/api/version', (req: Request, res: Response) => {
  try {
    const vp = path.join(APP_ROOT, 'version.json');
    if (fs.existsSync(vp)) { res.json(JSON.parse(fs.readFileSync(vp, 'utf8'))); return; }
  } catch { /* ignore */ }
  res.json({ version: '', buildDate: '', edition: '', channel: '' });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/products', require('./routes/products'));
app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/quotes', require('./routes/quotes'));
app.use('/api/shipments', require('./routes/shipments'));
app.use('/api/receivables', require('./routes/receivables'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/params', require('./routes/params'));
app.use('/api/import', require('./routes/importx'));
app.use('/api/pdf', require('./routes/pdf'));
app.use('/api/email', require('./routes/email'));
app.use('/api/mail-config', require('./routes/mail-config'));
app.use('/api/mail-logs', require('./routes/mail-logs'));
app.use('/api/manuals', require('./routes/manuals'));
// 手冊圖片靜態路由（Markdown 經 API 渲染，圖片由此提供）
app.use('/manuals-img', express.static(path.join(APP_ROOT, 'docs', 'images')));
app.use('/api/ar-terms', require('./routes/ar-terms'));
app.use('/api/supplier-quotes', require('./routes/supplier-quotes'));
app.use('/api/supplier-orders', require('./routes/supplier-orders'));
app.use('/api/supplier-shipments', require('./routes/supplier-shipments'));
app.use('/api/payables', require('./routes/payables'));
app.use('/api/forms', require('./routes/forms'));
app.use('/api/system-settings', require('./routes/system-settings'));
app.use('/api/company-profile', require('./routes/company-profile'));
app.use('/api/backup', require('./routes/backup'));
app.use('/api/cloud-backup', require('./routes/cloud-backup'));
// P3-2 雙軌容錯：failover 選擇器狀態查詢（限 admin）
app.get('/api/system/db-failover', requireAdmin, (req: any, res: any) => res.json(dbFailover.getStatus()));
app.use('/api/approvals', require('./routes/approvals'));
app.use('/api/customer-statements', require('./routes/statements'));
// 文件指紋查驗（防偽：指紋查詢 + PDF 檔案雜湊驗證）
app.use('/api/fingerprints', require('./routes/fingerprints'));
// 系統更新（更新包）：就地套用 .mjupd，含備份/重啟/歷程
app.use('/api/system-update', require('./routes/system-update'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/audit', require('./routes/audit'));
// 管理者網路設定（自助設定內部 IP / 對外固定 IP / HTTPS / 憑證 / 允許網段，含待確認回滾防鎖死）
app.use('/api/network', require('./routes/network'));
// 系統維運端點（裝置識別 / 診斷包 / 還原演練 / VACUUM，H2/H3/H4/M2）
app.use('/api/system', require('./routes/system'));

// 上傳檔案靜態服務（Logo / 系統背景圖）
const uploadsDir = path.join(APP_ROOT, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Level B：服務 Vite 建置產出 dist/（單軌化，已移除舊 public/ 原生 SPA）
app.use(express.static(path.join(APP_ROOT, 'dist'), {
  // PWA：.webmanifest 需以 application/manifest+json 送出，否則瀏覽器拒絕安裝
  setHeaders: (res: any, filePath: string) => {
    if (filePath.endsWith('.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json');
    }
  }
}));
// SPA fallback：非 /api 的 GET 一律回傳 dist/index.html（hash router 下主要防直接深連）
app.get(/^\/(?!api\/).*/, (req: Request, res: Response) => {
  const idx = path.join(APP_ROOT, 'dist', 'index.html');
  if (fs.existsSync(idx)) { res.sendFile(idx); return; }
  res.status(200).send('<div style="font-family:sans-serif;padding:40px">前端建置中，請執行 <code>npm run build</code> 後重新整理。</div>');
});

app.use('/api', (req: Request, res: Response) => { res.status(404).json({ error: 'API 路徑不存在' }); });
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('[ERROR]', err);
  if (res.headersSent) { next(err); return; }
  res.status(500).json({ error: '伺服器內部錯誤：' + (err.message || '未知錯誤') });
});

const PORT = process.env.PORT || cfg.port;
const HOST = cfg.host;
app.listen(PORT, HOST, () => {
  console.log(`✅ ${cfg.app_name} 已啟動： http://${HOST}:${PORT}`);
});

// 可選 HTTPS 入口。正式環境的憑證檔放在 LIVE AppData 外層並以 ACL 限制讀取；
// 健康檢查保留 loopback HTTP，網路使用者透過 HTTPS 埠連線。
if (cfg.https?.enabled) {
  const certFile = String(cfg.https.certFile || '');
  const keyFile = String(cfg.https.keyFile || '');
  if (!certFile || !keyFile || !fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    throw new Error('HTTPS 已啟用，但憑證或私鑰檔案不存在');
  }
  const httpsPort = Number(cfg.https.port || 5443);
  https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, app)
    .listen(httpsPort, HOST, () => {
      console.log(`✅ ${cfg.app_name} HTTPS 已啟動： https://${HOST}:${httpsPort}`);
    });
}

/* ================= 台灣銀行牌告匯率：每日擷取排程 ================= */
import * as botfx from './lib/botfx';
function scheduleBotFx() {
  const run = async () => {
    try {
      const r = await botfx.ensureTodayFetched(); // 冪等：今日已有資料則跳過
      if (r.count) console.log(`[botfx] 已擷取台幣匯率 ${r.date}（${r.count} 筆，清理 ${r.purged || 0} 筆）`);
    } catch (e: any) {
      console.warn('[botfx] 每日匯率擷取失敗：', e.message);
    }
  };
  setTimeout(run, 6000);                    // 開機後 6 秒先抓一次
  setInterval(run, 60 * 60 * 1000);         // 每小時檢查一次（跨日 / 開機失敗自動補抓）
}
scheduleBotFx();

/* ================= GC：tokens / audit / fx 自動清理 ================= */
import * as gc from './lib/gc';
gc.startSched();

/* ================= MySQL 平行驗證線：每日對齊 ================= */
import * as parity from './lib/parity';
parity.startSched();

/* ================= 自動備份排程（將 config.backup 死設定變活） ================= */
import * as backup from './lib/backup';
backup.startSched(cfg, __dirname, console.log);

export default app;
