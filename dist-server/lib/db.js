// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.DATA_DIR = exports.DB_FILE = exports.db = void 0;
exports.initSchema = initSchema;
/**
 * 資料庫連線與 Schema 初始化（better-sqlite3，同步 API）
 *
 * 核心模型：orders（訂單主檔） + order_items（訂單明細，一單多料號）
 * 所有金額欄位：原幣存於 order_items.amount/total，本位幣金額存 *_base（利潤以本位幣計算）
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
// 應用根：編譯後本檔位於 <app>/dist-server/lib/db.js，應用根為往上兩層；
// 開發期（<src>/dist-server/lib/db.js）亦同。用來解析 config 中的相對 db.path。
const APP_ROOT = path.join(__dirname, '..', '..');
// 資料目錄：<app>/data（備份 backups/、上傳 _uploads/ 的生產實績落點）
const DATA_DIR = path.join(APP_ROOT, 'data');
exports.DATA_DIR = DATA_DIR;
// 🔧 DB 路徑解析優先級（與 ETL 一致，修復「排程看門狗未帶 APP_DB → 誤用空庫」的回歸）：
//   1) 環境變數 APP_DB（手動 / 隔離測試用，最高優先）
//   2) config.json 的 db.path（相對 app root，預設指向 app/data/trade.sqlite）
//   3) 預設 <app>/data/trade.sqlite
function resolveDbFile() {
    if (process.env.APP_DB)
        return process.env.APP_DB;
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config.json'), 'utf8'));
        if (cfg && cfg.db && cfg.db.path)
            return path.resolve(APP_ROOT, cfg.db.path);
    }
    catch (e) { /* config 讀取失敗則退回預設 */ }
    return path.join(DATA_DIR, 'trade.sqlite');
}
const DB_FILE = resolveDbFile();
exports.DB_FILE = DB_FILE;
if (!fs.existsSync(DATA_DIR))
    fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_FILE);
exports.db = db;
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const SCHEMA = `
/* ========== 使用者（🔒 識別一律工號 emp_id） ========== */
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  emp_id        TEXT UNIQUE,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'sales' CHECK(role IN ('admin','manager','accounting','sales')),
  title         TEXT,
  phone         TEXT,
  email         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now','localtime')),
  updated_at    TEXT DEFAULT (datetime('now','localtime')),
  mfa_secret          TEXT,
  mfa_pending_secret  TEXT,
  mfa_enabled         INTEGER NOT NULL DEFAULT 0
);

/* ========== 登入 Token ========== */
CREATE TABLE IF NOT EXISTS tokens (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  expires_at TEXT
);

/* ========== 登入失敗鎖定（B3，2026-09-26） ==========
   key        = IP|帳號（empId 大寫）
   fails      = 連續失敗次數
   locked_until = 鎖定到期時間（ISO，NULL 表示未鎖定）            */
CREATE TABLE IF NOT EXISTS login_failures (
  key          TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at   TEXT DEFAULT (datetime('now','localtime'))
);

/* ========== 客戶主檔 ========== */
CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_no   TEXT UNIQUE,
  name          TEXT NOT NULL,
  short_name    TEXT,
  tax_id        TEXT,
  invoice_title TEXT,
  contact_name  TEXT,
  phone         TEXT,
  fax           TEXT,
  email         TEXT,
  address       TEXT,
  invoice_addr  TEXT,
  currency      TEXT DEFAULT 'TWD',
  payment_terms TEXT DEFAULT '月結60天',
  terms_days    INTEGER DEFAULT 60,
  tax_rate      REAL DEFAULT 0.05,
  ar_terms_id   INTEGER REFERENCES ar_terms(id) ON DELETE SET NULL,
  owner_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note          TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  is_test       INTEGER NOT NULL DEFAULT 0,  -- 測試／平行驗證客戶：報表預設排除（可用 ?include_test=1 納入）
  created_at    TEXT DEFAULT (datetime('now','localtime')),
  updated_at    TEXT DEFAULT (datetime('now','localtime'))
);

/* ========== 產品（料號）主檔 ========== */
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  part_no     TEXT UNIQUE,
  name        TEXT NOT NULL,
  spec        TEXT,
  version     TEXT,
  unit        TEXT DEFAULT 'PCS',
  stock_qty   REAL DEFAULT 0,
  cost_unit   REAL DEFAULT 0,
  price       REAL DEFAULT 0,
  currency    TEXT DEFAULT 'TWD',
  supplier_id INTEGER,
  note        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now','localtime')),
  updated_at  TEXT DEFAULT (datetime('now','localtime'))
);

/* ========== 供應商／大陸工廠主檔 ========== */
CREATE TABLE IF NOT EXISTS suppliers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT UNIQUE,
  name          TEXT NOT NULL,
  contact_name  TEXT,
  phone         TEXT,
  email         TEXT,
  country       TEXT DEFAULT '中國',
  lead_time_days INTEGER DEFAULT 30,
  payment_terms TEXT,
  currency      TEXT DEFAULT 'RMB',
  note          TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now','localtime')),
  updated_at    TEXT DEFAULT (datetime('now','localtime'))
);

/* ========== 訂單主檔 ========== */
CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no      TEXT UNIQUE,
  order_date    TEXT,
  month         TEXT,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  sales_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  supplier_id   INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  currency      TEXT DEFAULT 'TWD',
  exchange_rate REAL DEFAULT 1,
  payment_terms TEXT DEFAULT '月結60天',
  terms_days    INTEGER DEFAULT 60,
  factory_eta   TEXT,
  customer_eta  TEXT,
  ship_date     TEXT,
  customer_po_no TEXT,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK(status IN ('draft','confirmed','shipped','billed','paid','closed','cancelled')),
  note          TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT DEFAULT (datetime('now','localtime')),
  updated_at    TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_orders_date  ON orders(order_date);
CREATE INDEX IF NOT EXISTS idx_orders_month ON orders(month);
CREATE INDEX IF NOT EXISTS idx_orders_cust  ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_sales ON orders(sales_id);

/* ========== 訂單明細（核心計算層） ========== */
CREATE TABLE IF NOT EXISTS order_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL,
  part_no      TEXT,
  qty          REAL DEFAULT 0,
  unit         TEXT DEFAULT 'PCS',
  unit_price   REAL DEFAULT 0,
  amount       REAL DEFAULT 0,
  tax_rate     REAL DEFAULT 0.05,
  tax_amount   REAL DEFAULT 0,
  total        REAL DEFAULT 0,
  total_base   REAL DEFAULT 0,
  cost_unit    REAL DEFAULT 0,
  other_fee    REAL DEFAULT 0,
  cost_total   REAL DEFAULT 0,
  freight_cn   REAL DEFAULT 0,
  freight_tw   REAL DEFAULT 0,
  freight_pct  REAL DEFAULT 0,
  profit       REAL DEFAULT 0,
  margin       REAL DEFAULT 0,
  note         TEXT,
  sort_order   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

/* ========== 出貨與單據 ========== */
CREATE TABLE IF NOT EXISTS shipments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_no    TEXT,
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  ship_date      TEXT,
  qty            REAL DEFAULT 0,
  declaration_no TEXT,
  invoice_no     TEXT,
  invoice_date   TEXT,
  file_path      TEXT,
  note           TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ship_order ON shipments(order_id);

/* ========== 應收帳款 ========== */
/* A2（2026-09-24）：顆粒度由「訂單」改為「出貨批次 shipment」。
   - 取消 order_id UNIQUE（允許一單多筆 AR）
   - 新增 shipment_id 為 AR 自然鍵（UNIQUE，允許多個 NULL＝舊整單 AR）
   - 新增 legacy 旗標（=1 表示已被分批 AR 取代、報表排除，避免雙重計入） */
CREATE TABLE IF NOT EXISTS receivables (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  receivable_no    TEXT,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shipment_id      INTEGER REFERENCES shipments(id) ON DELETE SET NULL,
  customer_id      INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  billing_month    TEXT,
  receivable_month TEXT,
  due_date         TEXT,
  payment_date     TEXT,
  currency         TEXT DEFAULT 'TWD',
  amount           REAL DEFAULT 0,
  amount_base      REAL DEFAULT 0,
  received_amount  REAL DEFAULT 0,
  confirmed        INTEGER NOT NULL DEFAULT 0,
  received_date    TEXT,
  bank_note        TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','partial','received')),
  note             TEXT,
  legacy           INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT DEFAULT (datetime('now','localtime')),
  updated_at       TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(shipment_id)
);
CREATE INDEX IF NOT EXISTS idx_ar_due ON receivables(due_date);
CREATE INDEX IF NOT EXISTS idx_ar_cust ON receivables(customer_id);
CREATE INDEX IF NOT EXISTS idx_ar_ship ON receivables(shipment_id);
CREATE INDEX IF NOT EXISTS idx_ar_order ON receivables(order_id);

/* ========== 匯率歷程（多幣別） ========== */
CREATE TABLE IF NOT EXISTS exchange_rates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  currency       TEXT NOT NULL,
  rate           REAL NOT NULL,
  effective_date TEXT NOT NULL,
  note           TEXT,
  created_at     TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_fx_cur_date ON exchange_rates(currency, effective_date);

/* ========== 台灣銀行牌告匯率（每日擷取，保留 N 天） ========== */
CREATE TABLE IF NOT EXISTS fx_daily (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  fx_date    TEXT NOT NULL,
  currency   TEXT NOT NULL,
  cash_buy   REAL,
  cash_sell  REAL,
  spot_buy   REAL,
  spot_sell  REAL,
  mid_rate   REAL,
  source     TEXT DEFAULT 'bank_tw',
  fetched_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(fx_date, currency)
);
CREATE INDEX IF NOT EXISTS idx_fx_daily_date ON fx_daily(fx_date);

/* ========== 系統參數 ========== */
CREATE TABLE IF NOT EXISTS parameters (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  label      TEXT,
  group_name TEXT DEFAULT 'general',
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

/* ========== 帳期規則（多樣式管理，每筆有唯一 ID） ========== */
CREATE TABLE IF NOT EXISTS ar_terms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  basis       TEXT NOT NULL DEFAULT 'month_end',  /* month_end / next_month_start / cash / prepaid */
  days        INTEGER NOT NULL DEFAULT 0,          /* 月結天數，cash/prepaid 為 0 */
  description TEXT,
  is_system   INTEGER NOT NULL DEFAULT 0,          /* 1=系統預設不可刪除，0=自訂可刪除 */
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now','localtime')),
  updated_at  TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ar_terms_active ON ar_terms(is_active);

/* ========== 操作日誌 ========== */
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  emp_id     TEXT,
  action     TEXT,
  entity     TEXT,
  entity_id  TEXT,
  detail     TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

/* ========== MFA 挑戰（TOTP 二階段登入，2026-09-26） ==========
   token      = 登入第一階段發出的短期挑戰碼（5 分鐘有效）
   user_id    = 關聯使用者
   expires_at = 到期時間                                          */
CREATE TABLE IF NOT EXISTS mfa_challenges (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

/* ========== MFA 強制綁定挑戰（登入時角色需 MFA 但尚未啟用，2026-09-26） ==========
   token      = 強制綁定短期挑戰碼（10 分鐘有效，無 session）
   user_id    = 關聯使用者
   expires_at = 到期時間                                                          */
CREATE TABLE IF NOT EXISTS mfa_setup_challenges (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

/* ========== 客戶對帳單（Customer Statement，R7 補齊：原 SCHEMA 漏建） ========== */
CREATE TABLE IF NOT EXISTS customer_statements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_no TEXT,
  customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  period_start TEXT,
  period_end   TEXT,
  subtotal     REAL DEFAULT 0,
  tax_amount   REAL DEFAULT 0,
  grand_total  REAL DEFAULT 0,
  payment_terms TEXT,
  note         TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_cs_cust ON customer_statements(customer_id);

CREATE TABLE IF NOT EXISTS customer_statement_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id INTEGER NOT NULL REFERENCES customer_statements(id) ON DELETE CASCADE,
  po_no        TEXT,
  part_no      TEXT,
  qty          REAL DEFAULT 0,
  unit_price   REAL DEFAULT 0,
  amount       REAL DEFAULT 0,
  tax_amount   REAL DEFAULT 0,
  total        REAL DEFAULT 0,
  invoice_no   TEXT,
  ship_date    TEXT,
  note         TEXT,
  sort_order   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_csi_stmt ON customer_statement_items(statement_id);

/* ========== 客戶報價單（報價單主檔 + 明細；金額由計算引擎重算） ========== */
CREATE TABLE IF NOT EXISTS quotations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_no    TEXT UNIQUE,
  quotation_date  TEXT,
  valid_until     TEXT,
  customer_id     INTEGER,
  sales_id        INTEGER,
  currency        TEXT DEFAULT 'TWD',
  exchange_rate   REAL DEFAULT 1,
  tax_rate        REAL DEFAULT 0.05,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK(status IN ('draft','confirmed','expired','cancelled')),
  note            TEXT,
  created_by      INTEGER,
  created_at      TEXT DEFAULT (datetime('now','localtime')),
  updated_at      TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS quotation_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  quotation_id  INTEGER NOT NULL,
  product_id    INTEGER,
  part_no       TEXT,
  description   TEXT,
  qty           REAL DEFAULT 0,
  unit          TEXT DEFAULT 'PCS',
  unit_price    REAL DEFAULT 0,
  amount        REAL DEFAULT 0,
  tax_rate      REAL DEFAULT 0.05,
  tax_amount    REAL DEFAULT 0,
  total         REAL DEFAULT 0,
  sort_order    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_qitems_quote ON quotation_items(quotation_id);

/* ========== 表單編輯（文件模板＋文件實例） ========== */
CREATE TABLE IF NOT EXISTS doc_templates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  doc_type       TEXT NOT NULL DEFAULT 'custom',
  company_header INTEGER NOT NULL DEFAULT 1,
  content        TEXT NOT NULL DEFAULT '',
  remark         TEXT,
  is_system      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT DEFAULT (datetime('now','localtime')),
  updated_at     TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_doc_templates_code ON doc_templates(code);

CREATE TABLE IF NOT EXISTS documents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no      TEXT UNIQUE NOT NULL,
  template_id INTEGER NOT NULL REFERENCES doc_templates(id) ON DELETE RESTRICT,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  ref_data    TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'draft',
  remark      TEXT,
  created_by  TEXT,
  created_at  TEXT DEFAULT (datetime('now','localtime')),
  updated_at  TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_documents_template ON documents(template_id);

/* ========== 系統備份設定（系統備份模組） ========== */
CREATE TABLE IF NOT EXISTS backup_config (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  enabled       INTEGER NOT NULL DEFAULT 0,
  interval_days INTEGER NOT NULL DEFAULT 1,
  last_run      TEXT,
  next_run      TEXT
);
CREATE TABLE IF NOT EXISTS backup_cleanup_config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  enabled         INTEGER NOT NULL DEFAULT 0,
  retention_days  INTEGER NOT NULL DEFAULT 30,
  retention_count INTEGER NOT NULL DEFAULT 0,
  last_run        TEXT,
  next_run        TEXT
);
CREATE TABLE IF NOT EXISTS offsite_backup_config (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled    INTEGER NOT NULL DEFAULT 0,
  path       TEXT NOT NULL DEFAULT '',
  auto_sync  INTEGER NOT NULL DEFAULT 0,
  keep_count INTEGER NOT NULL DEFAULT 0,
  last_run   TEXT,
  last_status TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT ''
);

/* ========== 雲端／異地備份目標清單（P0 解耦 OneDrive 寫死，參考 Joplin 設定模式） ========== */
CREATE TABLE IF NOT EXISTS cloud_targets (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,            -- localfolder | googledrive | onedrive | webdav | s3
  name         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 0,
  remote_path  TEXT,                     -- 本機路徑 / 雲端資料夾路徑
  keep_count   INTEGER NOT NULL DEFAULT 0, -- 0 = 全部保留
  options_json TEXT,                     -- 非機密：folderId / bucket / region / url / username ...
  auth_json    TEXT,                     -- 機密：OAuth token / 密碼（AES-256-GCM 加密後存放）
  last_run     TEXT,
  last_status  TEXT,                     -- ok | error | unconfigured
  last_error   TEXT,
  created_at   TEXT DEFAULT (datetime('now','localtime')),
  updated_at   TEXT DEFAULT (datetime('now','localtime'))
);

/* ========== 供應商報價單（供應鏈） ========== */
CREATE TABLE IF NOT EXISTS supplier_quotes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_no    TEXT,
  supplier_id INTEGER NOT NULL,
  quote_date  TEXT,
  valid_until TEXT,
  tax_rate    REAL DEFAULT 0.05,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','quoted','expired','void')),
  note        TEXT,
  created_by  INTEGER,
  created_at  TEXT DEFAULT (datetime('now','localtime')),
  updated_at  TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sq_supplier ON supplier_quotes(supplier_id);

CREATE TABLE IF NOT EXISTS supplier_quote_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id      INTEGER NOT NULL,
  product_id    INTEGER,
  part_no       TEXT,
  description   TEXT,
  qty           REAL DEFAULT 0,
  unit          TEXT DEFAULT 'PCS',
  unit_price    REAL DEFAULT 0,
  amount        REAL DEFAULT 0,
  tax_rate      REAL DEFAULT 0.05,
  tax_amount    REAL DEFAULT 0,
  total         REAL DEFAULT 0,
  sort_order    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sqi_quote ON supplier_quote_items(quote_id);

/* ========== 供應商訂單（採購單，供應鏈） ========== */
CREATE TABLE IF NOT EXISTS supplier_orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no    TEXT,
  supplier_id INTEGER NOT NULL,
  order_date  TEXT,
  due_date    TEXT,
  tax_rate    REAL DEFAULT 0.05,
  currency    TEXT DEFAULT 'TWD',
  exchange_rate REAL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','partial','received','cancelled')),
  note        TEXT,
  created_by  INTEGER,
  created_at  TEXT DEFAULT (datetime('now','localtime')),
  updated_at  TEXT DEFAULT (datetime('now','localtime')),
  approval_status TEXT NOT NULL DEFAULT 'none' CHECK(approval_status IN ('none','pending','approved','rejected','returned')),
  current_step    INTEGER DEFAULT 0,
  submitter_id    INTEGER,
  submitted_at    TEXT,
  acted_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_so_supplier ON supplier_orders(supplier_id);

CREATE TABLE IF NOT EXISTS supplier_order_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL,
  product_id    INTEGER,
  part_no       TEXT,
  description   TEXT,
  qty           REAL DEFAULT 0,
  unit          TEXT DEFAULT 'PCS',
  unit_price    REAL DEFAULT 0,
  amount        REAL DEFAULT 0,
  unit_price_base REAL DEFAULT 0,
  total_base    REAL DEFAULT 0,
  tax_rate      REAL DEFAULT 0.05,
  tax_amount    REAL DEFAULT 0,
  total         REAL DEFAULT 0,
  note          TEXT,
  sort_order    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_soi_order ON supplier_order_items(order_id);

/* ========== 供應商出貨與單據（進貨單，供應鏈） ========== */
CREATE TABLE IF NOT EXISTS supplier_shipments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_no  TEXT,
  supplier_id  INTEGER NOT NULL,
  order_id     INTEGER,
  ship_date    TEXT,
  qty          REAL DEFAULT 0,
  invoice_no   TEXT,
  invoice_date TEXT,
  file_path    TEXT,
  note         TEXT,
  created_by   INTEGER,
  created_at   TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ssh_supplier ON supplier_shipments(supplier_id);
CREATE INDEX IF NOT EXISTS idx_ssh_order ON supplier_shipments(order_id);

/* ========== 應付帳款（供應鏈） ========== */
CREATE TABLE IF NOT EXISTS payables (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  payable_no   TEXT,
  supplier_id  INTEGER NOT NULL,
  invoice_no   TEXT,
  invoice_date TEXT,
  billing_month TEXT,
  payable_month TEXT,
  amount       REAL DEFAULT 0,
  due_date     TEXT,
  paid_amount  REAL DEFAULT 0,
  paid_date    TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','partial','paid')),
  note         TEXT,
  created_by   INTEGER,
  created_at   TEXT DEFAULT (datetime('now','localtime')),
  updated_at   TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pay_supplier ON payables(supplier_id);
CREATE INDEX IF NOT EXISTS idx_pay_due ON payables(due_date);

/* ========== 電子簽核（2026-09-08 新增） ========== */
CREATE TABLE IF NOT EXISTS approval_flows (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type   TEXT NOT NULL,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_af_doc ON approval_flows(doc_type);

CREATE TABLE IF NOT EXISTS approval_flow_steps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id      INTEGER NOT NULL,
  step_no      INTEGER NOT NULL DEFAULT 1,
  step_name    TEXT,
  approver_ids TEXT NOT NULL DEFAULT '',
  created_at   TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_afs_flow ON approval_flow_steps(flow_id);

CREATE TABLE IF NOT EXISTS approval_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type      TEXT NOT NULL,
  doc_id        INTEGER NOT NULL,
  doc_no        TEXT,
  step_no       INTEGER DEFAULT 0,
  step_name     TEXT,
  action        TEXT NOT NULL CHECK(action IN ('submit','pending','approve','reject','return')),
  status_label  TEXT,
  actor_id      INTEGER,
  actor_name    TEXT,
  delegate_name TEXT,
  comment       TEXT,
  notified_at   TEXT,
  finished_at   TEXT,
  created_at    TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_al_doc ON approval_logs(doc_type, doc_id);

/* ========== 文件指紋（文件防偽查驗，2026-09-22 新增） ==========
   fp         = HMAC-SHA256(密鑰, 單據關鍵欄位)[0..16]，內容指紋（同一單據恆定）
   pdf_sha256 = 產出 PDF 檔案的 SHA-256（每次列印不同，含列印時間），可驗證檔案未被竄改
   secret_fp  = 當時使用的密鑰指紋（前 8 碼），供日後判定「密鑰是否已輪替」          */
CREATE TABLE IF NOT EXISTS doc_fingerprints (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  fp                TEXT NOT NULL,
  doc_type          TEXT NOT NULL,
  doc_id            INTEGER,
  doc_no            TEXT,
  pdf_sha256        TEXT,
  pdf_bytes         INTEGER,
  pages             INTEGER,
  secret_fp         TEXT,
  generated_at      TEXT,
  generated_by      INTEGER,
  generated_by_name TEXT,
  source            TEXT DEFAULT 'single',
  created_at        TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_docfp_fp ON doc_fingerprints(fp);
CREATE INDEX IF NOT EXISTS idx_docfp_sha ON doc_fingerprints(pdf_sha256);
CREATE INDEX IF NOT EXISTS idx_docfp_doc ON doc_fingerprints(doc_type, doc_id);
CREATE INDEX IF NOT EXISTS idx_docfp_time ON doc_fingerprints(created_at);

/* ========== 庫存異動日記帳（P1，2026-09-23） ==========
   direction: +1 入庫 / -1 出庫 / 0 調整
   balance_qty / balance_cost：異動後產品結餘量與加權平均成本（稽核用）       */
CREATE TABLE IF NOT EXISTS stock_transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  doc_type    TEXT NOT NULL,            -- 'receipt' | 'shipment' | 'adjust' | 'stocktake' | 'transfer'
  doc_id      INTEGER,
  doc_no      TEXT,
  direction   INTEGER NOT NULL,
  qty         REAL NOT NULL,
  unit_cost   REAL DEFAULT 0,
  balance_qty REAL DEFAULT 0,
  balance_cost REAL DEFAULT 0,
  lot_id      INTEGER,
  serial_ids  TEXT,                     -- 關聯 stock_serials.id 清單（JSON 陣列）
  note        TEXT,
  operator    TEXT,
  created_at  TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_stx_prod ON stock_transactions(product_id);
CREATE INDEX IF NOT EXISTS idx_stx_doc  ON stock_transactions(doc_type, doc_id);
CREATE TABLE IF NOT EXISTS stock_transaction_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES stock_transactions(id) ON DELETE CASCADE,
  lot_id INTEGER REFERENCES stock_lots(id),
  qty REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_stxl_tx ON stock_transaction_lots(transaction_id);

/* ========== 批號 / 序號（P4，2026-09-23） ========== */
CREATE TABLE IF NOT EXISTS stock_lots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  batch_no        TEXT,
  qty             REAL NOT NULL DEFAULT 0,
  unit_cost       REAL DEFAULT 0,
  mfg_date        TEXT,
  exp_date        TEXT,
  received_doc_id   INTEGER,
  received_doc_no  TEXT,
  created_at      TEXT DEFAULT (datetime('now','localtime')),
  updated_at      TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_lot_prod  ON stock_lots(product_id);
CREATE INDEX IF NOT EXISTS idx_lot_batch ON stock_lots(product_id, batch_no);

CREATE TABLE IF NOT EXISTS stock_serials (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  lot_id        INTEGER,
  serial_no     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'in' CHECK(status IN ('in','out')),
  outbound_doc_id   INTEGER,
  outbound_doc_no  TEXT,
  created_at    TEXT DEFAULT (datetime('now','localtime')),
  updated_at    TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_serial_prod ON stock_serials(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_serial_no ON stock_serials(serial_no);

/* ========== 盤點（P5，2026-09-23） ========== */
CREATE TABLE IF NOT EXISTS stocktakes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stocktake_no TEXT,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed')),
  counted_by   INTEGER,
  counted_at   TEXT,
  note         TEXT,
  created_at   TEXT DEFAULT (datetime('now','localtime')),
  updated_at   TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS stocktake_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  stocktake_id INTEGER NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  system_qty   REAL DEFAULT 0,
  counted_qty  REAL DEFAULT 0,
  diff         REAL DEFAULT 0,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_stk_st ON stocktake_items(stocktake_id);
`;
/** 內建文件模板（表單編輯，不可刪除可修改） */
function seedDocTemplates() {
    const defs = [
        ['shipment_form', '出貨單', 'builtin',
            '<h3 style="text-align:center;">出 貨 單</h3><p>出貨單號：{{出貨單號}}　出貨日期：{{出貨日期}}　客戶：{{出貨客戶}}</p><table border="1" cellpadding="4" style="width:100%;border-collapse:collapse;"><tr><th>料號</th><th>品名規格</th><th>數量</th><th>單位</th></tr><tr><td>{{產品料號}}</td><td>{{產品規格}}</td><td>{{產品數量}}</td><td>PCS</td></tr></table><p style="margin-top:12px;">備註：<br/><br/></p><p style="text-align:right;">經辦：__________　簽收：__________</p>'],
        ['order_confirm', '訂單確認單', 'builtin',
            '<h3 style="text-align:center;">訂 單 確 認 單</h3><p>訂單單號：{{訂單單號}}　訂單日期：{{訂單日期}}　客戶：{{訂單客戶}}</p><table border="1" cellpadding="4" style="width:100%;border-collapse:collapse;"><tr><th>料號</th><th>品名規格</th><th>數量</th><th>單價</th><th>金額</th></tr><tr><td>{{產品料號}}</td><td>{{產品規格}}</td><td>{{產品數量}}</td><td>{{產品單價}}</td><td>{{產品金額}}</td></tr></table><p style="margin-top:12px;">付款條件：＿＿＿＿＿＿＿＿</p><p style="text-align:right;">經辦：__________　客戶確認：__________</p>'],
        ['quotation_form', '報價單', 'builtin',
            '<h3 style="text-align:center;">報 價 單</h3><p>報價單號：{{報價單號}}　報價日期：{{報價日期}}　有效日期：{{報價有效日}}　客戶：{{報價客戶}}</p><table border="1" cellpadding="4" style="width:100%;border-collapse:collapse;"><tr><th>料號</th><th>品名規格</th><th>數量</th><th>單價</th><th>金額</th></tr><tr><td>{{產品料號}}</td><td>{{產品規格}}</td><td>{{產品數量}}</td><td>{{產品單價}}</td><td>{{產品金額}}</td></tr></table><p style="margin-top:12px;">以上報價有效期限至 {{報價有效日}} 止。</p><p style="text-align:right;">經辦：__________</p>'],
    ];
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM doc_templates').get().c;
    if (cnt === 0) {
        const tx = db.transaction(() => {
            const stmt = db.prepare(`INSERT INTO doc_templates (code, name, doc_type, company_header, content, is_system)
     VALUES (?,?,?,1,?,1)`);
            for (const d of defs)
                stmt.run(...d);
        });
        tx();
    }
}
/** 系統備份設定預置（id=1 單列） */
function seedBackupConfigs() {
    const ins = (t, defs) => {
        const c = db.prepare('SELECT COUNT(*) AS c FROM ' + t).get().c;
        if (c === 0) {
            const cols = Object.keys(defs);
            db.prepare('INSERT INTO ' + t + ' (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')').run(...cols.map((k) => defs[k]));
        }
    };
    ins('backup_config', { id: 1, enabled: 0, interval_days: 1 });
    ins('backup_cleanup_config', { id: 1, enabled: 0, retention_days: 30, retention_count: 0 });
    ins('offsite_backup_config', { id: 1, enabled: 0, path: '', auto_sync: 0, keep_count: 0 });
}
/**
 * 預設簽核流程（供應商訂單／出貨單／客戶報價單）
 *   - 表格驅動：日後新增文件類型只要在 DEFAULTS 加一列
 *   - 只補「不存在」的流程，絕不覆蓋使用者已設定好的流程與核決人
 *   - 核決人：優先帶入主管（manager），系統尚無主管時帶入管理員（admin），確保安裝完即可用
 */
function seedApprovalFlows() {
    const DEFAULTS = [
        { doc_type: 'supplier-order', name: '供應商訂單簽核' },
        { doc_type: 'shipment', name: '出貨單簽核' },
        { doc_type: 'quote', name: '客戶報價單簽核' },
    ];
    const mgr = db.prepare("SELECT id FROM users WHERE role IN ('manager','admin') AND active=1 " +
        "ORDER BY CASE role WHEN 'manager' THEN 0 ELSE 1 END, id LIMIT 1").get();
    for (const f of DEFAULTS) {
        const exists = db.prepare('SELECT COUNT(*) AS c FROM approval_flows WHERE doc_type=?').get(f.doc_type).c;
        if (exists > 0)
            continue;
        const flowId = db.prepare('INSERT INTO approval_flows (doc_type, name, active) VALUES (?,?,1)').run(f.doc_type, f.name).lastInsertRowid;
        db.prepare('INSERT INTO approval_flow_steps (flow_id, step_no, step_name, approver_ids) VALUES (?,?,?,?)')
            .run(flowId, 1, '主管核決', mgr ? String(mgr.id) : '');
    }
}
function initSchema() {
    db.exec(SCHEMA);
    seedParameters();
    seedArTerms();
    seedDocTemplates();
    seedBackupConfigs();
    seedApprovalFlows();
    migrate();
}
/** 預設帳期規則（5 筆系統預設，不可刪除但可修改） */
function seedArTerms() {
    const defs = [
        ['月結 30 天', 'month_end', 30, '當月月底 + 30 天', 1],
        ['月結 60 天', 'month_end', 60, '當月月底 + 60 天', 1],
        ['次月 1 日 + 29 天', 'next_month_start', 30, '次月 1 日 + (30-1) 天', 1],
        ['現金款', 'cash', 0, '當天收款，兌現日＝基準日', 1],
        ['預付款', 'prepaid', 0, '訂單時預收，兌現日＝基準日', 1],
    ];
    const stmt = db.prepare(`INSERT INTO ar_terms (name, basis, days, description, is_system)
     VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
    // 僅在表為空時植入預設資料（避免重複）
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM ar_terms').get().c;
    if (cnt === 0) {
        const tx = db.transaction(() => { for (const d of defs)
            stmt.run(...d); });
        tx();
    }
}
/** 預設參數（稅率 / 運費% / 匯率 / 編號規則 / 帳期規則） */
function seedParameters() {
    const defs = [
        ['tax_rate', '0.05', '預設營業稅率', 'tax'],
        ['freight_pct_default', '0', '預設運費佔應收比例(%)', 'freight'],
        ['order_no_prefix', 'SO', '訂單編號前綴', 'numbering'],
        ['order_no_seq', '0', '訂單編號目前序號', 'numbering'],
        ['shipment_no_prefix', 'SH', '出貨單號前綴', 'numbering'],
        ['shipment_no_seq', '0', '出貨單號目前序號', 'numbering'],
        ['receivable_no_prefix', 'AR', '應收單號前綴', 'numbering'],
        ['receivable_no_seq', '0', '應收單號目前序號', 'numbering'],
        ['doc_no_prefix', 'FD', '文件號前綴（表單編輯）', 'numbering'],
        ['doc_no_seq', '0', '文件號目前序號', 'numbering'],
        ['supplier_quote_no_prefix', 'SPQ', '供應商報價單號前綴', 'numbering'],
        ['supplier_quote_no_seq', '0', '供應商報價單號目前序號', 'numbering'],
        ['supplier_order_no_prefix', 'SPO', '供應商訂單號前綴', 'numbering'],
        ['supplier_order_no_seq', '0', '供應商訂單號目前序號', 'numbering'],
        ['supplier_shipment_no_prefix', 'SPS', '供應商出貨單號前綴', 'numbering'],
        ['supplier_shipment_no_seq', '0', '供應商出貨單號目前序號', 'numbering'],
        ['payable_no_prefix', 'AP', '應付單號前綴', 'numbering'],
        ['payable_no_seq', '0', '應付單號目前序號', 'numbering'],
    ];
    const stmt = db.prepare("INSERT INTO parameters (key, value, label, group_name) VALUES (?,?,?,?) ON CONFLICT(key) DO NOTHING");
    const tx = db.transaction(() => { for (const d of defs)
        stmt.run(...d); });
    tx();
}
/** 遞增遷移：既有 DB 缺欄位時自動補（冪等） */
/**
 * A2（2026-09-24）：重建 receivables 表以移除 order_id UNIQUE 約束。
 * SQLite 不支援 ALTER TABLE DROP CONSTRAINT，故用 temp 表重建並保留資料。
 * 安全網：若發現重複 shipment_id（理論上不會，因 A1 每單僅一筆 AR），放棄重建交由遷移腳本處理。
 */
function rebuildReceivablesTable(db) {
    const dup = db.prepare("SELECT shipment_id FROM receivables WHERE shipment_id IS NOT NULL GROUP BY shipment_id HAVING COUNT(*) > 1").all();
    if (dup.length) {
        console.warn('[db] A2 rebuild 跳過：發現重複 shipment_id，請先執行 scripts/migrate-ar-to-shipment.mjs');
        return;
    }
    const cols = [
        'id', 'receivable_no', 'order_id', 'shipment_id', 'customer_id', 'billing_month',
        'receivable_month', 'due_date', 'payment_date', 'currency', 'amount', 'amount_base',
        'received_amount', 'confirmed', 'received_date', 'bank_note', 'status', 'note',
        'created_at', 'updated_at',
    ].join(', ');
    const tx = db.transaction(() => {
        db.exec(`
      CREATE TABLE receivables_new (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        receivable_no    TEXT,
        order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        shipment_id      INTEGER REFERENCES shipments(id) ON DELETE SET NULL,
        customer_id      INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        billing_month    TEXT,
        receivable_month TEXT,
        due_date         TEXT,
        payment_date     TEXT,
        currency         TEXT DEFAULT 'TWD',
        amount           REAL DEFAULT 0,
        amount_base      REAL DEFAULT 0,
        received_amount  REAL DEFAULT 0,
        confirmed        INTEGER NOT NULL DEFAULT 0,
        received_date    TEXT,
        bank_note        TEXT,
        status           TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','partial','received')),
        note             TEXT,
        legacy           INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT DEFAULT (datetime('now','localtime')),
        updated_at       TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(shipment_id)
      )
    `);
        db.exec(`INSERT INTO receivables_new (${cols}) SELECT ${cols} FROM receivables`);
        db.exec('DROP TABLE receivables');
        db.exec('ALTER TABLE receivables_new RENAME TO receivables');
        db.exec('CREATE INDEX IF NOT EXISTS idx_ar_due ON receivables(due_date)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_ar_cust ON receivables(customer_id)');
    });
    tx();
    console.log('[db] A2：receivables 表已重建（取消 order_id UNIQUE，改 UNIQUE(shipment_id) + legacy 旗標）');
}
function migrate() {
    const addCol = (table, col, ddl) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        if (!cols.includes(col)) {
            try {
                db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
            }
            catch (e) {
                console.warn(`[db] 遷移 ${table}.${col} 失敗：${e.message}`);
            }
        }
    };
    addCol('orders', 'exchange_rate', 'REAL DEFAULT 1');
    addCol('stock_transactions', 'reversed_by', 'INTEGER');
    addCol('orders', 'terms_days', 'INTEGER DEFAULT 60');
    addCol('orders', 'ship_date', 'TEXT');
    addCol('orders', 'supplier_id', 'INTEGER');
    addCol('order_items', 'total_base', 'REAL DEFAULT 0');
    addCol('order_items', 'freight_pct', 'REAL DEFAULT 0');
    addCol('order_items', 'unit', "TEXT DEFAULT 'PCS'");
    addCol('receivables', 'amount_base', 'REAL DEFAULT 0');
    addCol('receivables', 'currency', "TEXT DEFAULT 'TWD'");
    addCol('products', 'currency', "TEXT DEFAULT 'TWD'");
    addCol('customers', 'ar_terms_id', 'INTEGER REFERENCES ar_terms(id) ON DELETE SET NULL');
    // 2026-09-24：A1 出貨自動產生應收 + P1 應收↔出貨單直接 FK（shipment_id 指向觸發產生的出貨單）
    addCol('receivables', 'shipment_id', 'INTEGER REFERENCES shipments(id) ON DELETE SET NULL');
    // 2026-09-24：A2 分批出貨/分批請款 —— 取消 order_id UNIQUE，改以 shipment 為 AR 自然鍵
    // 既有 DB：若尚無 legacy 欄位，表示仍是「整單 Unique」舊結構 → 重建 receivables 表
    {
        const arCols = db.prepare(`PRAGMA table_info(receivables)`).all().map((c) => c.name);
        if (!arCols.includes('legacy'))
            rebuildReceivablesTable(db);
        addCol('receivables', 'legacy', 'INTEGER DEFAULT 0'); // 安全冪等（rebuild 已含；若跳過 rebuild 仍補）
    }
    // shipment_items 細項表（一筆 shipment 可含多訂單明細行，精確金額分攤）
    db.exec(`
    CREATE TABLE IF NOT EXISTS shipment_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id   INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
      order_item_id INTEGER REFERENCES order_items(id) ON DELETE SET NULL,
      product_id    INTEGER,
      qty           REAL DEFAULT 0,
      unit_price    REAL DEFAULT 0,
      amount        REAL DEFAULT 0,
      amount_base   REAL DEFAULT 0
    )
  `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_ar_ship ON receivables(shipment_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ar_order ON receivables(order_id)');
    // 2026-09-11：對齊客戶報表欄位（燿申科技應收/應付明細表）
    addCol('orders', 'customer_po_no', 'TEXT');
    addCol('supplier_orders', 'approval_status', "TEXT NOT NULL DEFAULT 'none'");
    addCol('supplier_orders', 'current_step', 'INTEGER DEFAULT 0');
    addCol('supplier_orders', 'submitter_id', 'INTEGER');
    addCol('supplier_orders', 'submitted_at', 'TEXT');
    addCol('supplier_orders', 'acted_at', 'TEXT');
    addCol('supplier_orders', 'currency', "TEXT DEFAULT 'TWD'");
    addCol('supplier_orders', 'exchange_rate', 'REAL DEFAULT 1');
    addCol('supplier_order_items', 'unit_price_base', 'REAL DEFAULT 0');
    addCol('supplier_order_items', 'total_base', 'REAL DEFAULT 0');
    addCol('supplier_order_items', 'note', 'TEXT');
    addCol('payables', 'invoice_date', 'TEXT');
    addCol('payables', 'billing_month', 'TEXT');
    addCol('payables', 'payable_month', 'TEXT');
    // 出貨單電子簽核
    addCol('shipments', 'approval_status', "TEXT NOT NULL DEFAULT 'none'");
    addCol('shipments', 'current_step', 'INTEGER DEFAULT 0');
    addCol('shipments', 'submitter_id', 'INTEGER');
    addCol('shipments', 'submitted_at', 'TEXT');
    addCol('shipments', 'acted_at', 'TEXT');
    // 客戶報價單電子簽核（欄位與出貨單一致）
    addCol('quotations', 'approval_status', "TEXT NOT NULL DEFAULT 'none'");
    addCol('quotations', 'current_step', 'INTEGER DEFAULT 0');
    addCol('quotations', 'submitter_id', 'INTEGER');
    addCol('quotations', 'submitted_at', 'TEXT');
    addCol('quotations', 'acted_at', 'TEXT');
    // 工號補齊（舊資料）
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    if (cols.includes('emp_id')) {
        const missing = db.prepare("SELECT id, username FROM users WHERE emp_id IS NULL OR TRIM(emp_id)=''").all();
        if (missing.length) {
            const up = db.prepare('UPDATE users SET emp_id=? WHERE id=?');
            const tx = db.transaction(() => {
                for (const m of missing) {
                    let v = String(m.username || '').toUpperCase();
                    let n = 1;
                    while (db.prepare('SELECT id FROM users WHERE emp_id=? AND id<>?').get(v, m.id)) {
                        n++;
                        v = `${m.username}-${n}`.toUpperCase();
                    }
                    up.run(v, m.id);
                }
            });
            tx();
        }
    }
    // 2026-09-12 對齊 LIVE：is_test 欄位補齊（平行驗證客戶標記）
    addCol('customers', 'is_test', 'INTEGER NOT NULL DEFAULT 0');
    // 一次性標記：客戶編號為 ETL 平行驗證用（C-ETL-*）且尚未被人工調整過
    {
        try {
            const r = db.prepare("UPDATE customers SET is_test=1 WHERE is_test=0 AND UPPER(COALESCE(customer_no,'')) LIKE 'C-ETL-%'").run();
            if (r.changes)
                console.log(`[db] 已標記 ${r.changes} 家平行驗證客戶為測試客戶（is_test=1，報表預設排除）`);
        }
        catch (e) {
            console.warn(`[db] 測試客戶標記失敗：${e.message}`);
        }
    }
    // 簽核索引（欄位補齊後才建立）
    try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_so_approval ON supplier_orders(approval_status, current_step)');
    }
    catch (e) {
        console.warn(`[db] 簽核索引建立失敗：${e.message}`);
    }
    // 外鍵欄位補索引（JOIN/級聯刪除效能）
    {
        const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
        const addIdx = (name, table, col) => {
            if (!hasCol(table, col)) {
                console.warn(`[db] 略過索引 ${name}（${table}.${col} 不存在）`);
                return;
            }
            try {
                db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${col})`);
            }
            catch (e) {
                console.warn(`[db] 索引 ${name} 建立失敗：${e.message}`);
            }
        };
        addIdx('idx_tokens_user', 'tokens', 'user_id');
        addIdx('idx_customers_ar_terms', 'customers', 'ar_terms_id');
        addIdx('idx_customers_owner', 'customers', 'owner_id');
        addIdx('idx_orders_created_by', 'orders', 'created_by');
        addIdx('idx_orders_supplier', 'orders', 'supplier_id');
        addIdx('idx_items_product', 'order_items', 'product_id');
        addIdx('idx_ship_created_by', 'shipments', 'created_by');
        // 2026-09-23 體檢 P2：補 3 個外鍵欄位索引（JOIN/級聯刪除效能，健檢發現缺索引）
        addIdx('idx_approval_steps_approval', 'approval_steps', 'approval_id');
        addIdx('idx_stxl_lot', 'stock_transaction_lots', 'lot_id');
        addIdx('idx_stk_prod', 'stocktake_items', 'product_id');
    }
    // 2026-09-23 庫存強化（P1/P2/P4/P5）：收貨/出貨綁定產品驅動庫存 + 安全庫存
    addCol('products', 'safety_stock', 'REAL DEFAULT 0');
    addCol('supplier_shipments', 'product_id', 'INTEGER');
    addCol('supplier_shipments', 'unit_cost', 'REAL DEFAULT 0');
    addCol('supplier_shipments', 'batch_no', 'TEXT');
    addCol('supplier_shipments', 'serials', 'TEXT');
    // 2026-09-23 供應商至應付端到端控制。
    addCol('supplier_shipments', 'order_item_id', 'INTEGER');
    try {
        const legacyReceipts = db.prepare("SELECT id,order_id,product_id FROM supplier_shipments WHERE order_id IS NOT NULL AND order_item_id IS NULL AND product_id IS NOT NULL").all();
        const setReceiptItem = db.prepare('UPDATE supplier_shipments SET order_item_id=? WHERE id=?');
        const tx = db.transaction(() => {
            for (const r of legacyReceipts) {
                const matches = db.prepare('SELECT id FROM supplier_order_items WHERE order_id=? AND product_id=?').all(r.order_id, r.product_id);
                if (matches.length === 1)
                    setReceiptItem.run(matches[0].id, r.id);
            }
        });
        tx();
    }
    catch (e) {
        console.warn(`[db] 舊進貨採購明細關聯略過，需人工核對：${e.message}`);
    }
    addCol('supplier_orders', 'source_quote_id', 'INTEGER');
    addCol('payables', 'currency', "TEXT DEFAULT 'TWD'");
    addCol('payables', 'exchange_rate', 'REAL DEFAULT 1');
    addCol('payables', 'amount_base', 'REAL DEFAULT 0');
    addCol('payables', 'invoice_key', 'TEXT');
    try {
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_invoice_key ON payables(supplier_id, invoice_key) WHERE invoice_key IS NOT NULL');
    }
    catch (e) {
        console.warn(`[db] 應付發票唯一索引略過（既有重複資料需先盤點）：${e.message}`);
    }
    try {
        const rows = db.prepare("SELECT id,supplier_id,invoice_no FROM payables WHERE invoice_key IS NULL AND TRIM(COALESCE(invoice_no,''))<>''").all();
        const groups = new Map();
        for (const r of rows) {
            const k = `${r.supplier_id}:${String(r.invoice_no).trim().toUpperCase()}`;
            groups.set(k, [...(groups.get(k) || []), r]);
        }
        const setKey = db.prepare('UPDATE payables SET invoice_key=? WHERE id=?');
        const tx = db.transaction(() => { for (const [k, list] of groups)
            if (list.length === 1)
                setKey.run(k.slice(k.indexOf(':') + 1), list[0].id); });
        tx();
    }
    catch (e) {
        console.warn(`[db] 應付發票鍵回填略過：${e.message}`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS payable_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, payable_id INTEGER NOT NULL, payment_date TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0), currency TEXT NOT NULL DEFAULT 'TWD', exchange_rate REAL NOT NULL DEFAULT 1,
    amount_base REAL NOT NULL DEFAULT 0, method TEXT, reference_no TEXT, note TEXT, created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')), reversed_payment_id INTEGER, idempotency_key TEXT
  )`);
    addCol('payable_payments', 'idempotency_key', 'TEXT');
    try {
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_idempotency ON payable_payments(idempotency_key) WHERE idempotency_key IS NOT NULL');
    }
    catch (_) { /* idempotent */ }
    // 將舊版累計已付款遷成可追溯的期初付款，確保升級前後餘額一致。
    try {
        const oldPaid = db.prepare("SELECT id, paid_amount, paid_date, currency, exchange_rate FROM payables WHERE COALESCE(paid_amount,0)>0 AND NOT EXISTS (SELECT 1 FROM payable_payments pp WHERE pp.payable_id=payables.id)").all();
        const ins = db.prepare("INSERT INTO payable_payments (payable_id,payment_date,amount,currency,exchange_rate,amount_base,method,note) VALUES (?,?,?,?,?,?,?,?)");
        const tx = db.transaction(() => oldPaid.forEach((p) => ins.run(p.id, p.paid_date || new Date().toISOString().slice(0, 10), p.paid_amount, p.currency || 'TWD', p.exchange_rate || 1, Number(p.paid_amount) * Number(p.exchange_rate || 1), 'legacy_migration', '系統升級轉入既有累計付款')));
        tx();
    }
    catch (e) {
        console.warn(`[db] 舊付款遷移略過：${e.message}`);
    }
    // F5 付款超額資料庫層防護：任何付款插入若使累計超過應付金額即 ABORT，與 routes/payables.js 應用層檢查互補，防止並發超付。
    // 建立於舊付款遷移之後，故升級轉入的期初付款不受本觸發器影響。
    try {
        db.exec(`CREATE TRIGGER IF NOT EXISTS trg_payable_payment_overage
      BEFORE INSERT ON payable_payments
      FOR EACH ROW
      BEGIN
        SELECT CASE
          WHEN (SELECT COALESCE(SUM(amount),0) FROM payable_payments WHERE payable_id = NEW.payable_id AND reversed_payment_id IS NULL) + NEW.amount
               > (SELECT amount FROM payables WHERE id = NEW.payable_id) + 0.000000001
          THEN RAISE(ABORT, '付款總額超過應付金額')
        END;
      END;`);
    }
    catch (e) {
        console.warn(`[db] 付款超額觸發器略過：${e.message}`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS payable_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT, payable_id INTEGER NOT NULL, shipment_id INTEGER NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
    db.exec(`CREATE TABLE IF NOT EXISTS accounting_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT, module TEXT NOT NULL DEFAULT 'payables', period_month TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', closed_at TEXT, closed_by INTEGER, reopened_at TEXT, reopened_by INTEGER,
    close_reason TEXT, snapshot_amount REAL, snapshot_paid REAL, UNIQUE(module, period_month)
  )`);
    try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_payments_payable ON payable_payments(payable_id, payment_date)');
    }
    catch (_) { /* idempotent */ }
    addCol('shipments', 'product_id', 'INTEGER');
    addCol('shipments', 'batch_no', 'TEXT');
    addCol('shipments', 'serials', 'TEXT');
    // 2026-09-26 B2：首次登入強制改密旗標（預設 0＝不需改；bootstrap/新建帳號設 1）
    addCol('users', 'must_change_pwd', 'INTEGER DEFAULT 0');
    // 2026-09-26 MFA：TOTP 二階段驗證欄位
    addCol('users', 'mfa_secret', 'TEXT');
    addCol('users', 'mfa_pending_secret', 'TEXT');
    addCol('users', 'mfa_enabled', 'INTEGER DEFAULT 0');
    // 2026-09-26 效能審計 P1/P2：status / approval_status / 次要單號索引缺口補齊
    // 全部 idempotent（CREATE INDEX IF NOT EXISTS）且先檢查欄位存在，防 schema 漂移誤建。
    // 註：P1 原報告列 9 條含 idx_shipments_status ON shipments(status)，
    //     但 shipments 表無 status 欄位（僅 approval_status），故改列 8 條（剔除無效者）。
    {
        const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
        const addIdx = (name, table, col) => {
            if (!hasCol(table, col)) {
                console.warn(`[db] 略過索引 ${name}（${table}.${col} 不存在）`);
                return;
            }
            try {
                db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${col})`);
            }
            catch (e) {
                console.warn(`[db] 索引 ${name} 建立失敗：${e.message}`);
            }
        };
        // ── P1（8 條）：status / approval_status（列表查詢、簽核過濾熱路徑）──
        addIdx('idx_orders_status', 'orders', 'status');
        addIdx('idx_quotations_status', 'quotations', 'status');
        addIdx('idx_quotations_appr', 'quotations', 'approval_status');
        addIdx('idx_shipments_appr', 'shipments', 'approval_status'); // 取代無效的 shipments(status)
        addIdx('idx_supplier_quotes_status', 'supplier_quotes', 'status');
        addIdx('idx_supplier_orders_status', 'supplier_orders', 'status');
        addIdx('idx_payables_status', 'payables', 'status');
        addIdx('idx_receivables_status', 'receivables', 'status');
        // ── P2（5 條）：次要單號索引（依單號查詢 / 去重 / JOIN 效能）──
        addIdx('idx_shipments_shipno', 'shipments', 'shipment_no');
        addIdx('idx_receivables_no', 'receivables', 'receivable_no');
        addIdx('idx_statements_no', 'customer_statements', 'statement_no');
        addIdx('idx_payables_no', 'payables', 'payable_no');
        addIdx('idx_payables_invoice', 'payables', 'invoice_no');
        console.log('[db] 效能審計 P1/P2：status/approval_status/次要單號索引建置完成（共 13 條，idempotent）');
    }
    // 2026-09-26 體檢 P2-1：補 3 個外鍵欄位索引（健檢發現 mfa_challenges.user_id、shipment_items 兩欄缺索引）
    // 外鍵欄位無索引會拖慢 JOIN 與 ON DELETE CASCADE 級聯刪除；全部 idempotent（CREATE INDEX IF NOT EXISTS）。
    {
        const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
        const addIdx = (name, table, col) => {
            if (!hasCol(table, col)) {
                console.warn(`[db] 略過索引 ${name}（${table}.${col} 不存在）`);
                return;
            }
            try {
                db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${col})`);
            }
            catch (e) {
                console.warn(`[db] 索引 ${name} 建立失敗：${e.message}`);
            }
        };
        addIdx('idx_mfa_challenges_user', 'mfa_challenges', 'user_id');
        addIdx('idx_shipment_items_shipment', 'shipment_items', 'shipment_id');
        addIdx('idx_shipment_items_order_item', 'shipment_items', 'order_item_id');
        console.log('[db] 體檢 P2-1：mfa_challenges/shipment_items 外鍵索引建置完成（3 條，idempotent）');
    }
    // 2026-09-26 雲端異地備份 P0：從舊設定冪等遷移為一筆 localfolder 目標
    // 來源優先序：offsite_backup_config.path（系統備份模組）→ config.backup.offsiteDir（3-2-1 熱備份）
    // 兩者皆在「cloud_targets 為空」時才遷移一次，向後相容且不重複插入。
    {
        const ctCount = db.prepare('SELECT COUNT(*) AS c FROM cloud_targets').get().c;
        if (ctCount === 0) {
            try {
                let srcPath = '', srcEnabled = false, srcKeep = 0, srcName = '';
                const legacy = db.prepare('SELECT path, enabled, keep_count FROM offsite_backup_config WHERE id = 1').get();
                if (legacy && legacy.path && String(legacy.path).trim()) {
                    srcPath = String(legacy.path).trim();
                    srcEnabled = !!legacy.enabled;
                    srcKeep = legacy.keep_count || 0;
                    srcName = '舊異地備份路徑';
                }
                else {
                    try {
                        const cfg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'config.json'), 'utf8'));
                        if (cfg && cfg.backup && cfg.backup.offsiteDir && String(cfg.backup.offsiteDir).trim()) {
                            srcPath = String(cfg.backup.offsiteDir).trim();
                            srcEnabled = !!cfg.backup.offsiteEnabled;
                            srcKeep = Number(cfg.backup.offsiteKeep || 0);
                            srcName = '舊異地備份目錄（config 遷移）';
                        }
                    }
                    catch (_) { /* config 讀取失敗則略過 */ }
                }
                if (srcPath) {
                    const id = crypto.randomUUID();
                    db.prepare(`INSERT INTO cloud_targets (id, type, name, enabled, remote_path, keep_count, options_json, auth_json)
             VALUES (?, 'localfolder', ?, ?, ?, ?, NULL, NULL)`).run(id, srcName, srcEnabled ? 1 : 0, srcPath, srcKeep);
                    console.log(`[db] 雲端備份 P0：已遷移一筆 localfolder 目標（${srcPath}）`);
                }
            }
            catch (e) {
                console.warn(`[db] 雲端備份 P0 遷移失敗（可忽略）：${e.message}`);
            }
        }
    }
    // 2026-09-27 MFA 強化 A：將 users 表中「明文」mfa_secret / mfa_pending_secret 重新加密
    // 冪等：僅對「非 v1: 前綴」且非空的值呼叫 lib/crypto.encrypt；已加密者原樣保留。
    // 每次啟動執行一次，自動遷移現有已綁定帳號（ADMIN/D001/93081/D002 等）的明文密鑰；
    // 遷移完成後 SQL 將撈不到任何明文，故後續啟動會直接走到 idempotent 分支。
    {
        let migrated = 0;
        try {
            const cryptoUtil = require('./crypto');
            const PREFIX = 'v1:';
            const rows = db.prepare(`SELECT id, mfa_secret, mfa_pending_secret FROM users
         WHERE (mfa_secret IS NOT NULL AND mfa_secret <> '' AND mfa_secret NOT LIKE ?)
            OR (mfa_pending_secret IS NOT NULL AND mfa_pending_secret <> '' AND mfa_pending_secret NOT LIKE ?)`).all(PREFIX + '%', PREFIX + '%');
            if (rows.length > 0) {
                const upd = db.prepare('UPDATE users SET mfa_secret = ?, mfa_pending_secret = ? WHERE id = ?');
                const tx = db.transaction((list) => {
                    for (const u of list) {
                        const encSecret = (u.mfa_secret && u.mfa_secret !== '' && !u.mfa_secret.startsWith(PREFIX))
                            ? cryptoUtil.encrypt(u.mfa_secret) : u.mfa_secret;
                        const encPending = (u.mfa_pending_secret && u.mfa_pending_secret !== '' && !u.mfa_pending_secret.startsWith(PREFIX))
                            ? cryptoUtil.encrypt(u.mfa_pending_secret) : u.mfa_pending_secret;
                        upd.run(encSecret, encPending, u.id);
                        migrated++;
                    }
                });
                tx(rows);
            }
            if (migrated > 0)
                console.log(`[db] MFA 強化 A：已將 ${migrated} 筆帳號的明文 MFA 密鑰重新加密`);
            else
                console.log('[db] MFA 強化 A：無明文 MFA 密鑰需遷移（idempotent）');
        }
        catch (e) {
            console.warn(`[db] MFA 強化 A 遷移失敗（可忽略，下次啟動重試）：${e.message}`);
        }
    }
}
