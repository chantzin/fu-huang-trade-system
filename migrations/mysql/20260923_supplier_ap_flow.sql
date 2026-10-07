-- 2026-09-23 supplier → payable hardening (MariaDB 10.x / MySQL 8)
-- Additive only: preserves existing records and does not rebuild/drop tables.
ALTER TABLE products ADD COLUMN IF NOT EXISTS safety_stock DOUBLE NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS product_id INT NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS batch_no TEXT NULL;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS serials TEXT NULL;
ALTER TABLE supplier_shipments ADD COLUMN IF NOT EXISTS product_id INT NULL;
ALTER TABLE supplier_shipments ADD COLUMN IF NOT EXISTS unit_cost DOUBLE NULL;
ALTER TABLE supplier_shipments ADD COLUMN IF NOT EXISTS batch_no TEXT NULL;
ALTER TABLE supplier_shipments ADD COLUMN IF NOT EXISTS serials TEXT NULL;
ALTER TABLE supplier_shipments ADD COLUMN IF NOT EXISTS order_item_id INT NULL;
ALTER TABLE supplier_orders ADD COLUMN IF NOT EXISTS source_quote_id INT NULL;
ALTER TABLE payables ADD COLUMN IF NOT EXISTS currency VARCHAR(16) NOT NULL DEFAULT 'TWD';
ALTER TABLE payables ADD COLUMN IF NOT EXISTS exchange_rate DOUBLE NOT NULL DEFAULT 1;
ALTER TABLE payables ADD COLUMN IF NOT EXISTS amount_base DOUBLE NOT NULL DEFAULT 0;
ALTER TABLE payables ADD COLUMN IF NOT EXISTS invoice_key VARCHAR(512) NULL;

CREATE TABLE IF NOT EXISTS payable_payments (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  payable_id INT NOT NULL,
  payment_date VARCHAR(32) NOT NULL,
  amount DOUBLE NOT NULL,
  currency VARCHAR(16) NOT NULL DEFAULT 'TWD',
  exchange_rate DOUBLE NOT NULL DEFAULT 1,
  amount_base DOUBLE NOT NULL DEFAULT 0,
  method TEXT NULL,
  reference_no TEXT NULL,
  note TEXT NULL,
  created_by INT NULL,
  created_at VARCHAR(32) NULL,
  reversed_payment_id INT NULL,
  idempotency_key VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE payable_payments ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255) NULL;

CREATE TABLE IF NOT EXISTS payable_sources (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  payable_id INT NOT NULL,
  shipment_id INT NOT NULL,
  created_at VARCHAR(32) NULL,
  UNIQUE KEY uq_payable_source_shipment(shipment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS accounting_periods (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  module VARCHAR(32) NOT NULL DEFAULT 'payables',
  period_month VARCHAR(7) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  closed_at VARCHAR(32) NULL,
  closed_by INT NULL,
  reopened_at VARCHAR(32) NULL,
  reopened_by INT NULL,
  close_reason TEXT NULL,
  snapshot_amount DOUBLE NULL,
  snapshot_paid DOUBLE NULL,
  UNIQUE KEY uq_accounting_period(module,period_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Optional indexes may be added once after confirming they are not already present.
-- Preserve historical paid totals as opening ledger entries (safe to rerun).
INSERT INTO payable_payments (payable_id,payment_date,amount,currency,exchange_rate,amount_base,method,note)
SELECT p.id, COALESCE(NULLIF(p.paid_date,''),DATE_FORMAT(CURRENT_DATE,'%Y-%m-%d')), p.paid_amount,
       COALESCE(NULLIF(p.currency,''),'TWD'), COALESCE(NULLIF(p.exchange_rate,0),1),
       p.paid_amount*COALESCE(NULLIF(p.exchange_rate,0),1), 'legacy_migration', '系統升級轉入既有累計付款'
FROM payables p
WHERE COALESCE(p.paid_amount,0)>0
  AND NOT EXISTS (SELECT 1 FROM payable_payments x WHERE x.payable_id=p.id);

