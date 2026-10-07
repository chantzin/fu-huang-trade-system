-- P1-P5 inventory journal and lot/serial support for the MySQL mirror.
-- Additive only; this migration does not truncate or rewrite existing records.
CREATE TABLE IF NOT EXISTS stock_lots (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  batch_no VARCHAR(255) NULL,
  qty DOUBLE NOT NULL DEFAULT 0,
  unit_cost DOUBLE NULL DEFAULT 0,
  mfg_date VARCHAR(32) NULL,
  exp_date VARCHAR(32) NULL,
  received_doc_id INT NULL,
  received_doc_no VARCHAR(255) NULL,
  created_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NULL,
  KEY idx_lot_prod (product_id),
  KEY idx_lot_batch (product_id, batch_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_serials (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  lot_id INT NULL,
  serial_no VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'in',
  outbound_doc_id INT NULL,
  outbound_doc_no VARCHAR(255) NULL,
  created_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NULL,
  KEY idx_serial_prod (product_id),
  UNIQUE KEY idx_serial_no (serial_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_transactions (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  doc_type VARCHAR(64) NOT NULL,
  doc_id INT NULL,
  doc_no VARCHAR(255) NULL,
  direction INT NOT NULL,
  qty DOUBLE NOT NULL,
  unit_cost DOUBLE NULL DEFAULT 0,
  balance_qty DOUBLE NULL DEFAULT 0,
  balance_cost DOUBLE NULL DEFAULT 0,
  lot_id INT NULL,
  serial_ids TEXT NULL,
  note TEXT NULL,
  operator VARCHAR(255) NULL,
  created_at VARCHAR(32) NULL,
  reversed_by INT NULL,
  KEY idx_stx_prod (product_id),
  KEY idx_stx_doc (doc_type, doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_transaction_lots (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  transaction_id INT NOT NULL,
  lot_id INT NULL,
  qty DOUBLE NOT NULL,
  created_at VARCHAR(32) NULL,
  KEY idx_stxl_tx (transaction_id),
  KEY idx_stxl_lot (lot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stocktakes (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  stocktake_no VARCHAR(255) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  counted_by INT NULL,
  counted_at VARCHAR(32) NULL,
  note TEXT NULL,
  created_at VARCHAR(32) NULL,
  updated_at VARCHAR(32) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stocktake_items (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  stocktake_id INT NOT NULL,
  product_id INT NOT NULL,
  system_qty DOUBLE NULL DEFAULT 0,
  counted_qty DOUBLE NULL DEFAULT 0,
  diff DOUBLE NULL DEFAULT 0,
  note TEXT NULL,
  KEY idx_stk_st (stocktake_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
