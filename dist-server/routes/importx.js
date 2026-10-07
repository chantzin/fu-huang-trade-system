'use strict';
/**
 * Excel 匯入／匯出骨架
 * 舊資料（現有 Excel 訂單總表）待提供後即可批次倒入；本模組已備好欄位對應與乾跑驗證。
 */
const express = require('express');
const multer = require('multer');
const { db } = require('../lib/db-dual');
const { requireAuth, requireManager } = require('../lib/auth');
const audit = require('../lib/audit');
const exportx = require('../lib/exportx');
const { num, str, toDateStr, toMonthStr, nextSerial } = require('../lib/util');
const { calcItem, getRate, getParam, deriveAR } = require('../lib/calc');
const inv = require('../lib/inventory');

const router = express.Router();
router.use(requireAuth);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/* ================= 範本下載 ================= */

const TEMPLATES = {
  customers: ['客戶編號', '公司名稱', '簡稱', '統一編號', '發票抬頭', '聯絡人', '電話', 'Email', '地址', '幣別', '交易條件', '月結天數', '稅率', '備註'],
  products: ['料號', '品名', '規格', '版本', '單位', '預設單價', '幣別', '備註'],
  suppliers: ['代號', '供應商名稱', '聯絡人', '電話', 'Email', '國家', '交期天數', '付款條件', '幣別', '備註'],
  orders: ['訂單編號', '訂單日期', '業務工號', '客戶編號', '幣別', '匯率', '料號', '數量', '單價', '稅率', '台幣單價成本', '其他費用', '運費(大陸)', '運費(台灣)', '工廠交期', '客戶交期', '出貨日期', '交易條件', '月結天數', '發票號碼', '進口報單', '備註'],
};

router.get('/template/:type', (req, res) => {
  const t = TEMPLATES[req.params.type];
  if (!t) return res.status(400).json({ error: '不支援的範本類型' });
  const buf = exportx.toWorkbook([t], req.params.type);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(req.params.type + '_import_template.xlsx')}`);
  res.end(buf);
});

/* ================= 匯入 ================= */

function pickCn(row, ...names) {
  for (const n of names) {
    for (const k of Object.keys(row)) {
      if (String(k).trim() === n) return row[k];
    }
  }
  return '';
}

/** 客戶匯入 */
function importCustomers(rows, dryRun) {
  const result = { total: rows.length, created: 0, updated: 0, errors: [] };
  const stmt = db.prepare(
    `INSERT INTO customers (customer_no, name, short_name, tax_id, invoice_title, contact_name, phone, email,
        address, currency, payment_terms, terms_days, tax_rate, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const upd = db.prepare(
    `UPDATE customers SET name=?, short_name=?, tax_id=?, invoice_title=?, contact_name=?, phone=?, email=?,
        address=?, currency=?, payment_terms=?, terms_days=?, tax_rate=?, note=?,
        updated_at=datetime('now','localtime') WHERE id=?`
  );
  rows.forEach((r, idx) => {
    const no = str(pickCn(r, '客戶編號', '客戶NO.', '客戶NO'));
    const name = str(pickCn(r, '公司名稱', '客戶名稱'));
    if (!name) { result.errors.push(`第 ${idx + 2} 列：公司名稱為空`); return; }
    const payload = [
      no || null, name, str(pickCn(r, '簡稱')), str(pickCn(r, '統一編號', '統編')),
      str(pickCn(r, '發票抬頭')), str(pickCn(r, '聯絡人')), str(pickCn(r, '電話')),
      str(pickCn(r, 'Email', 'email')), str(pickCn(r, '地址')),
      str(pickCn(r, '幣別'), 'TWD') || 'TWD',
      str(pickCn(r, '交易條件'), '月結60天') || '月結60天',
      num(pickCn(r, '月結天數'), 60), num(pickCn(r, '稅率'), 0.05), str(pickCn(r, '備註')),
    ];
    const exist = no ? db.prepare('SELECT id FROM customers WHERE customer_no=?').get(no) : null;
    if (exist) { if (!dryRun) upd.run(...payload.slice(1), exist.id); result.updated++; }
    else { if (!dryRun) stmt.run(...payload); result.created++; }
  });
  return result;
}

/** 產品匯入 */
async function importProducts(rows, dryRun, operator) {
  const result = { total: rows.length, created: 0, updated: 0, errors: [], warnings: [], openingPosted: 0 };
  const stmt = db.prepare(
    `INSERT INTO products (part_no, name, spec, version, unit, price, currency, note)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  const upd = db.prepare(
    `UPDATE products SET name=?, spec=?, version=?, unit=?, price=?, currency=?, note=?,
        updated_at=datetime('now','localtime') WHERE id=?`
  );
  for (const [r, idx] of rows.map((x, i) => [x, i])) {
    const partNo = str(pickCn(r, '料號'));
    const name = str(pickCn(r, '品名', '產品名稱'));
    if (!partNo) { result.errors.push(`第 ${idx + 2} 列：料號為空`); continue; }
    const importedQty = num(pickCn(r, '庫存量'));
    const importedCost = num(pickCn(r, '台幣單價成本', '成本', '單價成本'));
    const exist = db.prepare('SELECT id FROM products WHERE part_no=?').get(partNo);
    if (exist) {
      if (!dryRun) upd.run(name, str(pickCn(r, '規格')), str(pickCn(r, '版本')), str(pickCn(r, '單位'), 'PCS') || 'PCS',
        num(pickCn(r, '預設單價', '單價')), str(pickCn(r, '幣別'), 'TWD') || 'TWD', str(pickCn(r, '備註')), exist.id);
      result.updated++;
      if (importedQty !== 0 || importedCost !== 0) {
        result.warnings.push(`第 ${idx + 2} 列：${partNo} 已存在，庫存量／成本欄位不會由產品匯入修改（請用「庫存管理 → 期初建帳」調整）。`);
      }
      continue;
    }
    const payload = [
      partNo, name, str(pickCn(r, '規格')), str(pickCn(r, '版本')), str(pickCn(r, '單位'), 'PCS') || 'PCS',
      num(pickCn(r, '預設單價', '單價')), str(pickCn(r, '幣別'), 'TWD') || 'TWD', str(pickCn(r, '備註')),
    ];
    if (!dryRun) {
      const info = stmt.run(...payload);
      const newId = info.lastInsertRowid;
      // D1 防呆：匯入含期初庫存量 → 自動過帳為「期初建帳」（寫入 stock_transactions 日記帳），
      // 避免 Excel 直寫庫存繞過日記帳導致庫存真相與日記帳脫鉤。
      if (importedQty > 0) {
        try {
          await inv.initializeStock({ productId: Number(newId), qty: importedQty, unitCost: importedCost, operator, note: 'Excel 產品匯入自建期初' });
          result.openingPosted++;
        } catch (e) {
          result.warnings.push(`第 ${idx + 2} 列：${partNo} 期初建帳失敗（${e.message}）；請手動於庫存管理建立期初。`);
        }
      } else if (importedCost !== 0) {
        result.warnings.push(`第 ${idx + 2} 列：${partNo} 含成本但無數量，成本未過帳（請一併填寫庫存量）。`);
      }
    }
    result.created++;
  }
  return result;
}

/** 供應商匯入 */
function importSuppliers(rows, dryRun) {
  const result = { total: rows.length, created: 0, updated: 0, errors: [] };
  const stmt = db.prepare(
    `INSERT INTO suppliers (code, name, contact_name, phone, email, country, lead_time_days, payment_terms, currency, note)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  rows.forEach((r, idx) => {
    const name = str(pickCn(r, '供應商名稱', '公司名稱'));
    if (!name) { result.errors.push(`第 ${idx + 2} 列：供應商名稱為空`); return; }
    if (!dryRun) {
      stmt.run(
        str(pickCn(r, '代號')) || null, name, str(pickCn(r, '聯絡人')), str(pickCn(r, '電話')),
        str(pickCn(r, 'Email', 'email')), str(pickCn(r, '國家'), '中國') || '中國',
        num(pickCn(r, '交期天數'), 30), str(pickCn(r, '付款條件')),
        str(pickCn(r, '幣別'), 'RMB') || 'RMB', str(pickCn(r, '備註'))
      );
    }
    result.created++;
  });
  return result;
}

/**
 * 訂單匯入：一列 = 一筆明細；相同「訂單編號」歸戶成一張訂單多筆料號
 * 若未提供訂單編號，則一列一單（自動產生編號）
 */
function importOrders(rows, dryRun, userId) {
  const result = { total: rows.length, orders: 0, items: 0, errors: [], warnings: [] };
  const groups = new Map();
  rows.forEach((r, idx) => {
    const key = str(pickCn(r, '訂單編號')) || `__ROW_${idx}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row: r, idx });
  });

  for (const [key, list] of groups) {
    const head = list[0].row;
    const customerNo = str(pickCn(head, '客戶編號', '客戶NO.', '客戶NO'));
    const customerName = str(pickCn(head, '公司名稱', '客戶名稱'));
    let customer = customerNo
      ? db.prepare('SELECT * FROM customers WHERE customer_no=?').get(customerNo)
      : (customerName ? db.prepare('SELECT * FROM customers WHERE name=?').get(customerName) : null);
    if (!customer && customerName) customer = db.prepare('SELECT * FROM customers WHERE name LIKE ?').get(`%${customerName}%`);
    if (!customer) {
      result.errors.push(`訂單 ${key}：找不到客戶（${customerNo || customerName || '未填'}），請先匯入客戶主檔`);
      continue;
    }

    const salesEmp = str(pickCn(head, '業務工號', '業務'));
    let salesId = null;
    if (salesEmp) {
      const u = db.prepare('SELECT id FROM users WHERE emp_id=? OR username=?').get(salesEmp, salesEmp)
             || db.prepare('SELECT id FROM users WHERE name=?').get(salesEmp);
      if (u) salesId = u.id; else result.warnings.push(`訂單 ${key}：找不到業務「${salesEmp}」，歸屬留空`);
    }

    const orderDate = str(pickCn(head, '訂單日期')) || toDateStr(new Date());
    const currency = str(pickCn(head, '幣別')) || customer.currency || 'TWD';
    const rate = num(pickCn(head, '匯率'), 0) > 0 ? num(pickCn(head, '匯率')) : getRate(currency, orderDate);
    const orderNo = key.startsWith('__ROW_') ? nextSerial('order_no_prefix', 'order_no_seq', 'SO') : key;

    if (!key.startsWith('__ROW_') && db.prepare('SELECT id FROM orders WHERE order_no=?').get(orderNo)) {
      result.errors.push(`訂單 ${orderNo}：編號已存在，請先刪除或改用其他編號`);
      continue;
    }

    const items = list.map(({ row, idx }) => {
      const partNo = str(pickCn(row, '料號'));
      if (!partNo) result.warnings.push(`第 ${idx + 2} 列：料號為空，該筆明細略過`);
      const prod = partNo ? db.prepare('SELECT * FROM products WHERE part_no=?').get(partNo) : null;
      return {
        product_id: prod ? prod.id : null,
        part_no: partNo,
        qty: num(pickCn(row, '數量')),
        unit: 'PCS',
        unit_price: num(pickCn(row, '單價')),
        tax_rate: num(pickCn(row, '稅率', '稅(%)'), num(customer.tax_rate, num(getParam('tax_rate', 0.05)))),
        cost_unit: num(pickCn(row, '台幣單價成本', '成本'), prod ? prod.cost_unit : 0),
        other_fee: num(pickCn(row, '其他費用')),
        freight_cn: num(pickCn(row, '運費(大陸)', '運費(大陆)')),
        freight_tw: num(pickCn(row, '運費(台灣)', '運費(台灣)')),
        note: str(pickCn(row, '備註')),
      };
    }).filter((it) => it.part_no);

    if (!items.length) { result.errors.push(`訂單 ${key}：沒有有效明細`); continue; }

    if (!dryRun) {
      const termsText = str(pickCn(head, '交易條件')) || customer.payment_terms || '月結60天';
      const termsDays = num(pickCn(head, '月結天數'), customer.terms_days || 60);
      const info = db.prepare(
        `INSERT INTO orders (order_no, order_date, month, customer_id, sales_id, currency, exchange_rate,
            payment_terms, terms_days, factory_eta, customer_eta, ship_date, status, note, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        orderNo, orderDate, toMonthStr(orderDate), customer.id, salesId, currency, rate,
        termsText, termsDays,
        str(pickCn(head, '工廠交期')) || null, str(pickCn(head, '客戶交期')) || null,
        str(pickCn(head, '出貨日期')) || null, 'confirmed', str(pickCn(head, '備註')), userId
      );
      const oid = info.lastInsertRowid;
      const stmt = db.prepare(
        `INSERT INTO order_items (order_id, product_id, part_no, qty, unit, unit_price, amount, tax_rate, tax_amount,
            total, total_base, cost_unit, other_fee, cost_total, freight_cn, freight_tw, freight_pct, profit, margin, note, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      let i = 0;
      for (const raw of items) {
        const c = calcItem(raw, { exchange_rate: rate, currency, order_date: orderDate });
        stmt.run(oid, raw.product_id, raw.part_no, c.qty, 'PCS', c.unit_price, c.amount, c.tax_rate,
          c.tax_amount, c.total, c.total_base, c.cost_unit, c.other_fee, c.cost_total,
          c.freight_cn, c.freight_tw, c.freight_pct, c.profit, c.margin, raw.note, i++);
      }
      result.items += items.length;
      // 出貨單據：有出貨日或報單／發票號碼就建一筆
      const shipDate = str(pickCn(head, '出貨日期'));
      const declNo = str(pickCn(head, '進口報單'));
      const invNo = str(pickCn(head, '發票號碼'));
      if (shipDate || declNo || invNo) {
        db.prepare(
          `INSERT INTO shipments (shipment_no, order_id, ship_date, declaration_no, invoice_no, invoice_date, created_by)
           VALUES (?,?,?,?,?,?,?)`
        ).run(nextSerial('shipment_no_prefix', 'shipment_no_seq', 'SH'), oid, shipDate || null, declNo, invNo, null, userId);
      }
    } else {
      result.items += items.length;
    }
    result.orders++;
  }
  return result;
}

const IMPORTERS = { customers: importCustomers, products: importProducts, suppliers: importSuppliers, orders: importOrders };

/** 匯入（?dry_run=1 只驗證不寫入） */
router.post('/:type', requireManager, upload.single('file'), async (req, res, next) => {
  try {
    const type = req.params.type;
    const importer = IMPORTERS[type];
    if (!importer) return res.status(400).json({ error: '不支援的匯入類型：' + type });
    if (!req.file) return res.status(400).json({ error: '未收到檔案' });

    let rows;
    try {
      rows = exportx.readObjects(req.file.buffer);
    } catch (e) {
      return res.status(400).json({ error: 'Excel 讀取失敗：' + e.message });
    }
    if (!rows.length) return res.status(400).json({ error: 'Excel 沒有資料列' });

    const dryRun = req.query.dry_run === '1' || req.body.dry_run === '1';
    const result = await db.transaction(async () => importer(rows, dryRun, req.user.id))();
    if (!dryRun) audit.log(req, 'import', type, '', `${result.orders || result.created || 0} 筆`);
    res.json(Object.assign({ dryRun, type }, result));
  } catch (e) {
    res.status(500).json({ error: '匯入失敗：' + e.message });
  }
});

module.exports = router;
