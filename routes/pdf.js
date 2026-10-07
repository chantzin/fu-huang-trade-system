'use strict';
/**
 * PDF 單據輸出 — 4 種單據共用此路由
 *   GET  /api/pdf/orders/:id               訂單確認單
 *   GET  /api/pdf/shipments/:id            出貨單
 *   GET  /api/pdf/customers/:id/statement  對帳單（?month=YYYY-MM）
 *   GET  /api/pdf/receivables/summary      應收帳款彙總表（?month=YYYY-MM）
 *   POST /api/pdf/batch                    批次合併列印（多單合一）
 *
 * 全部走同一個 PDF 工具（lib/pdf.js），可直接瀏覽器下載 / 列印。
 */
const express = require('express');
const path = require('node:path');
const crypto = require('node:crypto');
const { db } = require('../lib/db-dual');
const { fmtMoney, fmtPct, createDoc, drawTable, drawSignatureBox, addPageFooter, documentFingerprint, fingerprintSecretId, ensureSpace, clipText } = require('../lib/pdf');
const { deriveAR, agingBucket } = require('../lib/calc');
const { toMonthStr, toDateStr, endOfMonth, addDays } = require('../lib/util');
const { requireAuth } = require('../lib/auth');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();

// =================================================================
// 文件指紋紀錄（B）＋ PDF 檔案雜湊（C）
//   - A：指紋已改為「不含列印時間」→ 同一張單據的指紋恆定，可核對
//   - B：每次列印寫入 doc_fingerprints（fp／單號／時間／列印人）
//   - C：對產出的 PDF 位元組算 SHA-256 存表 → 可驗證檔案本體未被竄改
// =================================================================

/**
 * 組出查驗頁網址（供頁尾 QR 使用）
 *   有 HTTP 請求時 → 以 Host header 組出（內網 / 區網皆可）
 *   無請求時（如 email 附件）→ 讀系統參數 public_base_url；未設定則回 null（不畫 QR）
 */
function verifyUrlFor(req, fp) {
  let base = '';
  if (req) {
    try {
      const host = req.get('host');
      if (host) base = `${req.protocol === 'https' ? 'https' : 'http'}://${host}`;
    } catch { /* ignore */ }
  }
  if (!base) {
    try {
      const r = db.prepare('SELECT value FROM parameters WHERE key=?').get('public_base_url');
      if (r && r.value) base = String(r.value).replace(/\/+$/, '');
    } catch { /* ignore */ }
  }
  if (!base) return null;
  return `${base}/#/doc-verify?q=${encodeURIComponent(fp)}`;
}

/** 寫入 doc_fingerprints（任何失敗都不得影響列印流程） */
function recordFingerprint(row) {
  try {
    db.prepare(`INSERT INTO doc_fingerprints
      (fp, doc_type, doc_id, doc_no, pdf_sha256, pdf_bytes, pages, secret_fp, generated_at, generated_by, generated_by_name, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.fp, row.doc_type, row.doc_id == null ? null : row.doc_id, row.doc_no || null,
      row.pdf_sha256 || null, row.pdf_bytes || null, row.pages || null,
      row.secret_fp || null, row.generated_at || null,
      row.generated_by == null ? null : row.generated_by, row.generated_by_name || null,
      row.source || 'single');
  } catch (e) { console.warn('[pdf] 指紋紀錄寫入失敗：', e.message); }
}

/**
 * 是否為「自動化探測」請求（健檢 / 監控腳本）。
 * 這些請求會實際 GET 列印端點，但**不該產生 doc_fingerprints 紀錄**，
 * 否則每日多次健檢會灌入幽靈列印紀錄、污染查驗清單。
 * 由腳本端帶 `X-MJ-Probe: 1` 標記（見 tests/_healthcheck-api.cjs）。
 */
function isProbe(req) {
  try { return !!(req && req.get && req.get('x-mj-probe') === '1'); } catch { return false; }
}

/**
 * 把畫好的 doc 收成 Buffer（**不直接 pipe**）→ 算 PDF 本體 SHA-256 → 寫入 doc_fingerprints。
 * 這是 C 的實作核心；email 附件與 HTTP 下載共用，確保兩條路徑都有紀錄。
 * @param {PDFDocument} doc 已畫好內容（含 footer）的文件
 * @param {object} meta { fp, doc_type, doc_id, doc_no, source, generated_by, generated_by_name, record }
 *        meta.record === false 時仍產出 PDF 與 SHA，但**不寫紀錄**（用於自動化探測）
 * @returns {Promise<{buf: Buffer, sha: string}>}
 */
function finishDoc(doc, meta) {
  return new Promise((resolve, reject) => {
    let pages = null;
    try { pages = doc.bufferedPageRange().count; } catch { /* ignore */ }
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        if (meta.record !== false) {
          recordFingerprint({
            ...meta,
            pdf_sha256: sha,
            pdf_bytes: buf.length,
            pages,
            secret_fp: fingerprintSecretId(),
            generated_at: meta.generated_at || new Date().toISOString().slice(0, 19),
            source: meta.source || 'single',
          });
        }
        resolve({ buf, sha });
      } catch (e) { reject(e); }
    });
    doc.end();
  });
}

/**
 * 送出 PDF 下載回應（內容同 finishDoc，並附上指紋／雜湊 header 供前端與查驗工具核對）
 * @param {object} req
 * @param {object} res
 * @param {PDFDocument} doc
 * @param {object} meta { fp, doc_type, doc_id, doc_no, source }
 * @param {string} filename
 */
function sendPdf(req, res, doc, meta, filename) {
  const u = req.user || {};
  // 自動化探測（健檢/監控）不寫入紀錄，避免污染查驗清單
  finishDoc(doc, { ...meta, generated_by: u.id, generated_by_name: u.name, record: !isProbe(req) })
    .then(({ buf, sha }) => {
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `${meta.attachment ? 'attachment' : 'inline'}; filename="${filename}"`);
        res.setHeader('X-Doc-Fingerprint', meta.fp || '');
        res.setHeader('X-Doc-Sha256', sha);
        res.setHeader('Access-Control-Expose-Headers', 'X-Doc-Fingerprint, X-Doc-Sha256');
      }
      res.end(buf);
    })
    .catch((e) => {
      console.warn('[pdf] 文件產生失敗：', e.message);
      if (!res.headersSent) res.status(500).json({ error: 'PDF 產生失敗：' + e.message });
      else try { res.end(); } catch { /* ignore */ }
    });
}

// ========== 共用：抓訂單完整資料（含 items） ==========
async function loadOrder(id) {
  const o = await db.prepare(`
    SELECT o.*, c.name AS customer_name, c.customer_no, c.tax_id AS cust_tax_id,
           c.address AS cust_address, c.phone AS cust_phone, c.contact_name,
           s.name AS supplier_name, u.name AS sales_name, u.name AS created_by_name
    FROM orders o
    LEFT JOIN customers c ON c.id=o.customer_id
    LEFT JOIN suppliers s ON s.id=o.supplier_id
    LEFT JOIN users u ON u.id=o.sales_id
    WHERE o.id=?`).get(id);
  if (!o) return null;
  o.items = await db.prepare(`SELECT * FROM order_items WHERE order_id=? ORDER BY sort_order, id`).all(id);
  return o;
}

// ========== 共用：抓出貨完整資料 ==========
async function loadShipment(id) {
  const sh = await db.prepare(`
    SELECT sh.*, o.order_no, o.order_date, o.currency, o.exchange_rate,
           c.name AS customer_name, c.customer_no, c.tax_id AS cust_tax_id,
           c.address AS cust_address, c.phone AS cust_phone
    FROM shipments sh
    JOIN orders o ON o.id=sh.order_id
    LEFT JOIN customers c ON c.id=o.customer_id
    WHERE sh.id=?`).get(id);
  if (!sh) return null;
  sh.items = await db.prepare(`
    SELECT i.*, p.name AS product_name
    FROM order_items i LEFT JOIN products p ON p.id=i.product_id
    WHERE i.order_id=? ORDER BY i.sort_order, i.id`).all(sh.order_id);
  // 抓各關簽核人名+日期（已核准的）
  try {
    sh.approved_logs = await db.prepare(`
      SELECT al.step_name, u.name AS actor_name, al.finished_at
      FROM approval_logs al LEFT JOIN users u ON u.id=al.actor_id
      WHERE al.doc_type='shipment' AND al.doc_id=? AND al.action='approve'
      ORDER BY al.id`).all(sh.id);
  } catch { sh.approved_logs = []; }
  return sh;
}

// ========== 抽出的繪圖函式（給單張 / 批次共用） ==========

/**
 * 把訂單確認單的所有內容畫到指定 doc 上（不含 footer）。
 * 回傳文件指紋（讓呼叫端決定 footer 寫在哪裡）。
 */
function drawOrderToDoc(doc, order) {
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;
  const topY = 110;

  doc.font('zh').fontSize(10).fillColor('#000000');
  const leftLines = [
    ['訂單編號', order.order_no || `#${order.id}`],
    ['訂單日期', order.order_date || '-'],
    ['客戶訂單', order.note ? `(備註) ${order.note}` : '-'],
    ['業務人員', order.sales_name || '-'],
    ['供應商', order.supplier_name || '-'],
    ['交易條件', `${order.payment_terms} (${order.terms_days} 天)`],
  ];
  let yy = topY;
  for (const [k, v] of leftLines) {
    doc.fillColor('#666666').text(`${k}：`, left, yy, { width: 80 });
    doc.fillColor('#000000').text(String(v), left + 80, yy, { width: width / 2 - 80 });
    yy += 18;
  }

  let ry = topY;
  const rx = left + width / 2 + 10;
  const rw = width / 2 - 10;
  const rightLines = [
    ['客戶編號', order.customer_no || '-'],
    ['客戶名稱', order.customer_name || '-'],
    ['統一編號', order.cust_tax_id || '-'],
    ['聯絡電話', order.cust_phone || '-'],
    ['聯絡人', order.contact_name || '-'],
    ['送貨地址', order.cust_address || '-'],
  ];
  for (const [k, v] of rightLines) {
    doc.fillColor('#666666').text(`${k}：`, rx, ry, { width: 80 });
    doc.fillColor('#000000').text(String(v), rx + 80, ry, { width: rw - 80 });
    ry += 18;
  }

  let ty = Math.max(yy, ry) + 10;
  doc.fillColor('#003366').font('zh').fontSize(11).text('■ 訂單明細', left, ty);
  ty += 18;

  const itemRows = (order.items || []).map((it) => [
    it.part_no || '-',
    it.qty ? Number(it.qty).toLocaleString() : '0',
    it.unit || 'PCS',
    fmtMoney(it.unit_price, order.currency),
    fmtMoney(it.amount, order.currency),
    fmtMoney(it.tax_amount, order.currency),
    fmtMoney(it.total, order.currency),
    fmtMoney(it.total_base, 'TWD'),
  ]);
  ty = drawTable(doc, {
    x: left, y: ty, colWidths: [70, 50, 35, 60, 70, 60, 70, 75],
    headers: ['料號', '數量', '單位', '單價', '應收未稅', '稅額', '合計', '本位幣'],
    rows: itemRows,
    aligns: ['left', 'right', 'center', 'right', 'right', 'right', 'right', 'right'],
  });
  ty = ensureSpace(doc, ty, 150);   // 保留合計列 / 簽核欄空間，避免被擠出紙張

  const totals = order.items.reduce((t, it) => ({
    qty: t.qty + Number(it.qty || 0),
    amount: t.amount + Number(it.amount || 0),
    tax: t.tax + Number(it.tax_amount || 0),
    total: t.total + Number(it.total || 0),
    total_base: t.total_base + Number(it.total_base || 0),
    profit: t.profit + Number(it.profit || 0),
    cost_total: t.cost_total + Number(it.cost_total || 0),
    freight: t.freight + Number(it.freight_cn || 0) + Number(it.freight_tw || 0),
  }), { qty: 0, amount: 0, tax: 0, total: 0, total_base: 0, profit: 0, cost_total: 0, freight: 0 });

  ty += 6;
  doc.fillColor('#000000').font('zh').fontSize(10);
  doc.text(`幣別 / 匯率：${order.currency} @ ${Number(order.exchange_rate || 1)}`, left, ty);
  doc.text(`原幣合計：${fmtMoney(totals.amount, order.currency)}  稅額：${fmtMoney(totals.tax, order.currency)}  含稅合計：${fmtMoney(totals.total, order.currency)}`,
    left, ty + 16, { width });
  doc.fillColor('#003366').font('zh').fontSize(11);
  doc.text(`本位幣（TWD）合計：${fmtMoney(totals.total_base)}`, left, ty + 34);
  doc.fillColor('#000000').font('zh').fontSize(9);
  doc.text(`成本總額：${fmtMoney(totals.cost_total)}  運費：${fmtMoney(totals.freight)}  利潤：${fmtMoney(totals.profit)}  毛利率：${fmtPct(totals.total_base > 0 ? totals.profit / totals.total_base : 0)}`,
    left, ty + 50, { width });

  drawApprovalSignatureRow(doc, ensureSpace(doc, ty + 80, 42), width, []);

  return documentFingerprint({
    type: 'order',
    id: order.id,
    order_no: order.order_no,
    customer_id: order.customer_id,
    total_base: Math.round(totals.total_base * 100) / 100,
    profit: Math.round(totals.profit * 100) / 100,
  });
}

/** 出貨單下方說明 3 段（繪製與高度估算共用，單一來源） */
function shipmentNotes(company) {
  return [
    '1.貨品規格、品質、發票如有問題請於七日內通知本公司處理，逾期請自行負責。',
    '2.本交易為附條件買賣，依動產交易法第三章之規定，在貨款未付清或票據未兌現償付之前，標的物之所有權仍歸屬本公司所有，買受人無異議同意本公司無須經法律程序隨時取回本貨品或代物清償。',
    '3.貨款支票請寄至' + (company.address || ''),
  ];
}

/**
 * 估算「出貨單單份區塊」的實際高度（供一式兩份 / 一頁一份的排版決策）
 * 一式兩份時，每份只有約 400pt 可用；明細過多就必須改成一頁一份。
 */
function shipmentCopyHeight(doc, sh, company, rowHeight) {
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;
  const rowH2 = rowHeight || 18;
  const items = sh.items || [];
  let h = 22;                                        // 公司名
  if (company.address) h += 12;                      // [2026-09-22] 14→12：壓縮以維持「一頁兩份」
  if (company.phone || company.fax) h += 14;         // 16→14
  h += 22;                                           // 「出貨單」標題（24→22）
  h += 14 * 3 + 4;                                   // 單頭 3 列（16×3+6 → 14×3+4）
  h += rowH2 * (Math.max(5, items.length) + 1);      // 表頭 + 明細列
  h += 4;                                            // 說明區塊（含外框，8→4）
  doc.font('zh').fontSize(9);
  for (const n of shipmentNotes(company)) h += doc.heightOfString(n, { width: width - 12 }) + 2;   // 段距 4→2
  h += 6 + 32;                                       // 簽核列（8+34 → 6+32）
  return h;
}

/**
 * 出貨單繪圖（預設一式兩份，對齊客戶提供的 Excel 格式）
 * 單份區塊：公司抬頭置中 → 標題 → 單頭 3 列 → 明細表（序/品名/數量/單位/單價/金額/備註）→ 說明 3 段 → 簽核列
 */
function drawShipmentOneCopy(doc, sh, company, offsetY, rowHeight, opts) {
  const paginate = !!(opts && opts.paginate);   // 明細超出一頁時：滿版換頁並重畫表頭
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;
  let y = offsetY;

  // 1) 公司抬頭（置中大字）
  if (company.name) {
    doc.font('zh').fontSize(18).fillColor('#000000').text(company.name, left, y, { width, align: 'center' });
  }
  y += 22;
  if (company.address) {
    doc.fontSize(10).fillColor('#000000').text(company.address, left, y, { width, align: 'center' });
    y += 12;
  }
  const contact = [company.phone ? `電話：${company.phone}` : '', company.fax ? `傳真：${company.fax}` : ''].filter(Boolean).join('   ');
  if (contact) {
    doc.fontSize(10).text(contact, left, y, { width, align: 'center' });
    y += 14;
  }

  // 2) 「出貨單」標題
  doc.fontSize(16).text('出      貨      單', left, y, { width, align: 'center' });
  y += 22;

  // 3) 單頭 3 列（左 label+值，右 label+值）
  doc.fontSize(10);
  const rowH = 14;          // [2026-09-22] 16→14：壓縮單頭，維持「一頁兩份」
  const leftColX = left;
  const leftValX = left + 70;
  const rightLabelX = left + width / 2;
  const rightValX = rightLabelX + 70;
  const valW = width / 2 - 75;

  const rows = [
    ['客戶名稱：', sh.customer_name || '', '出貨日期：', sh.ship_date || ''],
    ['送貨地址：', sh.cust_address || '', '訂單編號：', sh.order_no || ''],
    ['聯絡電話：', sh.cust_phone || '', '發票號碼：', sh.invoice_no || ''],
  ];
  for (const [lk, lv, rk, rv] of rows) {
    doc.fillColor('#000000').text(lk, leftColX, y, { width: 70 });
    doc.text(lv, leftValX, y, { width: valW });
    doc.text(rk, rightLabelX, y, { width: 70 });
    doc.text(rv, rightValX, y, { width: valW });
    y += rowH;
  }
  y += 4;                    // [2026-09-22] 6→4

  // 4) 明細表：序/品名/數量/單位/單價/金額/備註
  const cols = [
    { key: 'seq', label: '序', w: 25, align: 'center' },
    { key: 'name', label: '品　　　名', w: 200, align: 'left' },
    { key: 'qty', label: '數  量', w: 55, align: 'right' },
    { key: 'unit', label: '單  位', w: 40, align: 'center' },
    { key: 'price', label: '單  價', w: 60, align: 'right' },
    { key: 'amount', label: '金  額', w: 70, align: 'right' },
    { key: 'note', label: '備　註', w: width - 25 - 200 - 55 - 40 - 60 - 70, align: 'left' },
  ];
  const tableX = left;
  const rowH2 = rowHeight || 18;   // 明細多時會自動壓縮，確保單份塞得進可用高度
  const limit = doc.page.height - doc.page.margins.bottom;
  let cx = tableX;
  // header row（獨立成函式：分頁續頁時要重畫）
  const drawTableHead = () => {
    doc.rect(tableX, y, width, rowH2).lineWidth(0.5).strokeColor('#000000').stroke();
    cx = tableX;
    doc.fontSize(10);
    for (const c of cols) {
      doc.text(clipText(doc, c.label, c.w - 6), cx + 3, y + 4, { width: c.w - 6, align: c.align });
      doc.moveTo(cx + c.w, y).lineTo(cx + c.w, y + rowH2).lineWidth(0.5).stroke();
      cx += c.w;
    }
    y += rowH2;
  };
  drawTableHead();

  // data rows：實際明細 + 補到至少 5 列
  const items = sh.items || [];
  const rowCount = Math.max(5, items.length);
  for (let i = 0; i < rowCount; i++) {
    const it = items[i];
    if (paginate && y + rowH2 > limit) { doc.addPage(); y = 30; drawTableHead(); }
    doc.rect(tableX, y, width, rowH2).lineWidth(0.5).strokeColor('#000000').stroke();
    cx = tableX;
    const vals = [
      String(i + 1),
      it ? (it.part_no || it.product_name || '') : '',
      it && it.qty ? Number(it.qty).toLocaleString() : '',
      it ? (it.unit || 'PCS') : '',
      it && it.unit_price ? Number(it.unit_price).toLocaleString() : '',
      it && it.amount ? Number(it.amount).toLocaleString() : '',
      '',
    ];
    for (let j = 0; j < cols.length; j++) {
      doc.text(clipText(doc, vals[j], cols[j].w - 6), cx + 3, y + 4, { width: cols[j].w - 6, align: cols[j].align });
      if (j < cols.length - 1) {
        doc.moveTo(cx + cols[j].w, y).lineTo(cx + cols[j].w, y + rowH2).lineWidth(0.5).stroke();
      }
      cx += cols[j].w;
    }
    y += rowH2;
  }
  y += 4;                    // [2026-09-22] 8→4

  // 5) 說明 3 段（加外框）
  doc.fontSize(9);
  const notes = shipmentNotes(company);
  if (paginate) {
    let need = 12;
    for (const n of notes) need += doc.heightOfString(n, { width: width - 12 }) + 8;
    y = ensureSpace(doc, y, need + 30);   // 說明區塊 + 簽核列不要被擠出紙張
  }
  const noteTop = y;
  const noteX = left;
  for (const n of notes) {
    doc.text(n, noteX + 6, y, { width: width - 12 });
    y = doc.y + 2;           // [2026-09-22] 段距 4→2
  }
  const noteBottom = y;
  doc.rect(noteX, noteTop - 2, width, noteBottom - noteTop + 2).lineWidth(0.5).strokeColor('#000000').stroke();
  y += 6;                    // [2026-09-22] 8→6

  // 6) 簽核列：核決主管 / 會計 / 業務 / 客戶簽收（自動蓋簽核人姓名+日期）
  if (paginate) y = ensureSpace(doc, y, 36);
  return drawApprovalSignatureRow(doc, y, width, sh.approved_logs);
}

/**
 * 簽核列（全系統共用；四欄：核 准／會 計／業 務／客戶簽收）
 *   - logs：approval_logs 中 action='approve' 的紀錄（step_name / actor_name / finished_at）
 *   - 依步驟名稱關鍵字自動帶入簽核人姓名與日期；未簽核者留白
 *   - 第 4 欄（lastLabel）固定留白，由簽收方於紙本手簽；客戶側＝「客戶簽收」，供應商側＝「供應商簽收」
 */
function drawApprovalSignatureRow(doc, y, width, logs, lastLabel) {
  const cols = [
    { label: '核 准：', keys: ['核決主管', '主管核決', '核決', '主管', '核准'] },
    { label: '會 計：', keys: ['會計', '財務'] },
    { label: '業 務：', keys: ['業務', '承辦'] },
    { label: lastLabel || '客戶簽收：', keys: null },
  ];
  const list = logs || [];
  const gap = 14;                                  // 欄間留白（避免簽核人/日期與下一欄標題黏在一起）
  const colW = (width - gap * (cols.length - 1)) / cols.length;
  const left = doc.page.margins.left;
  const nameY = y + 13;                            // 簽核人+日期（標題下方一行）
  const lineY = y + 26;                            // 簽名線（未簽核處供手簽）

  for (let i = 0; i < cols.length; i++) {
    const sx = left + i * (colW + gap);
    // 1) 標題
    doc.font('zh').fontSize(10).fillColor('#333333').text(cols[i].label, sx, y, { width: colW, lineBreak: false });
    // 2) 簽名線（整欄寬，淺灰）
    doc.moveTo(sx, lineY).lineTo(sx + colW, lineY).lineWidth(0.4).strokeColor('#B0B0B0').stroke();

    // 3) 簽核人+日期：姓名靠左、日期靠右，兩者都鎖在本欄寬度內
    if (!cols[i].keys) continue;
    const hit = list.find((l) => l.step_name && cols[i].keys.some((k) => l.step_name.includes(k)));
    const name = hit ? String(hit.actor_name || '') : '';
    if (!name) continue;
    const dt = String(hit.finished_at || '').slice(0, 10);
    doc.font('zh').fontSize(9).fillColor('#1a4480');
    const stamp = dt ? `${name}  ${dt}` : name;   // 簽核人＋日期視為同一組，左對齊於標題下方
    doc.text(clipText(doc, stamp, colW - 2), sx, nameY, { width: colW - 2, lineBreak: false });
    doc.fillColor('#000000');
  }
  return y + 32;   // [2026-09-22] 34→32：簽名線在 y+26，回傳值＝下一區塊起點
}

async function drawShipmentToDoc(doc, sh) {
  const param = async (k) => { try { const r = await db.prepare('SELECT value FROM parameters WHERE key=?').get(k); return r ? r.value : ''; } catch { return ''; } };
  const company = {
    name: await param('company_name'),
    address: await param('company_address'),
    phone: await param('company_phone'),
    fax: await param('company_fax'),
  };
  // 一式兩份印同一張 A4：上下兩個區塊
  // 但明細過多、單份高度超過半頁時，硬塞會讓兩份互相重疊或整個超出紙面
  // → 自動改為「一頁一份」（第 1 頁第一份、第 2 頁第二份）
  //
  // [2026-09-22 修正] 原本以固定 SLOT_H=395 判定、第二份硬畫在 y=430：
  //   第二份的可書寫下緣只到 771.89pt(=841.89-70)，故單份真實上限僅 341.9pt，
  //   落在 342~395 之間的單據會被誤判「可兩份」，第二份溢出紙面 5~55pt
  //   → PDFKit 判定超出可書寫範圍而自動加頁，兩份排版整組壞掉。
  //   改法：① 用「兩份總高 ≤ 可書寫高度」判定 ② 第二份改動態位移（緊接第一份）。
  const TOP_Y = 30;                                              // 第一份起點
  const GAP_Y = 10;                                              // 兩份間隔（裁切線畫在中間）
  const BOTTOM_Y = doc.page.height - doc.page.margins.bottom;    // 可書寫下緣
  const FULL_H = BOTTOM_Y - TOP_Y;                               // 一頁一份時可用高度
  const MIN_ROW_H = 13;
  const LIMIT_TWO = (BOTTOM_Y - TOP_Y - GAP_Y) / 2;              // 一式兩份時「單份」上限
  // 先嘗試維持「一式兩份」→ 必要時逐步壓縮列高（13~18pt）
  let rowH2 = 0;
  for (let r = 18; r >= MIN_ROW_H; r--) {
    if (shipmentCopyHeight(doc, sh, company, r) <= LIMIT_TWO) { rowH2 = r; break; }
  }
  if (rowH2) {
    const h1 = shipmentCopyHeight(doc, sh, company, rowH2);
    const endY1 = drawShipmentOneCopy(doc, sh, company, TOP_Y, rowH2);
    // 第二份起點：以估算定位（保證不溢出紙面）；若實際繪製比估算高則以後者為準（保證不重疊）
    let startY2 = TOP_Y + h1 + GAP_Y;
    if (endY1 + GAP_Y > startY2) startY2 = endY1 + GAP_Y;
    drawShipmentOneCopy(doc, sh, company, startY2, rowH2);
    // 裁切虛線置於兩份之間（方便對切）
    const mLeft = doc.page.margins.left, mRight = doc.page.margins.right;
    const cutY = startY2 - GAP_Y / 2;
    doc.moveTo(mLeft, cutY).dash(4, 3).lineWidth(0.5).strokeColor('#999999')
       .lineTo(doc.page.width - mRight, cutY).stroke();
    doc.undash();
  } else {
    // 一份塞不進半頁 → 先試「一頁一份」（必要時壓縮列高）
    let fullH = 0;
    for (let r = 18; r >= MIN_ROW_H; r--) {
      if (shipmentCopyHeight(doc, sh, company, r) <= FULL_H) { fullH = r; break; }
    }
    if (fullH) {
      drawShipmentOneCopy(doc, sh, company, TOP_Y, fullH);
      doc.addPage();
      drawShipmentOneCopy(doc, sh, company, TOP_Y, fullH);
    } else {
      // 連整頁都放不下 → 單份自動分頁（明細續頁重畫表頭；需要兩份請列印兩次）
      drawShipmentOneCopy(doc, sh, company, TOP_Y, MIN_ROW_H, { paginate: true });
    }
  }

  return documentFingerprint({
    type: 'shipment',
    id: sh.id,
    shipment_no: sh.shipment_no,
    order_id: sh.order_id,
    customer_id: sh.customer_id,
    qty: Number(sh.qty || 0),
  });
}

// =================================================================
// 1) 訂單確認單 — GET /api/pdf/orders/:id
// =================================================================
router.get('/orders/:id', requireAuth, wrap(async (req, res) => {
  const order = await loadOrder(req.params.id);
  if (!order) return res.status(404).json({ error: '訂單不存在' });

  const doc = createDoc({ title: '訂 單 確 認 單' });
  const fingerprint = drawOrderToDoc(doc, order);
  addPageFooter(doc, undefined, fingerprint, verifyUrlFor(req, fingerprint));
  sendPdf(req, res, doc,
    { fp: fingerprint, doc_type: 'order', doc_id: order.id, doc_no: order.order_no },
    `order-${order.order_no || order.id}.pdf`);
}));

// =================================================================
// 2) 出貨單 — GET /api/pdf/shipments/:id
// =================================================================
router.get('/shipments/:id', requireAuth, wrap(async (req, res) => {
  const sh = await loadShipment(req.params.id);
  if (!sh) return res.status(404).json({ error: '出貨單不存在' });

  const doc = createDoc({ title: '', watermark: false });
  // 蓋掉 createDoc 自動畫的預設 header（出貨單用自己的置中格式）
  doc.rect(0, 0, doc.page.width, 100).fillColor('#ffffff').fill();
  const fingerprint = await drawShipmentToDoc(doc, sh);
  addPageFooter(doc, undefined, fingerprint, verifyUrlFor(req, fingerprint));
  sendPdf(req, res, doc,
    { fp: fingerprint, doc_type: 'shipment', doc_id: sh.id, doc_no: sh.shipment_no },
    `shipment-${sh.shipment_no || sh.id}.pdf`);
}));

// =================================================================
// 1.5) 客戶對帳單 — GET /api/pdf/customer-statements/:id
// =================================================================
function drawStatementToDoc(doc, st, company) {
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;
  let y = 40;

  // 公司名置中，加字距
  if (company.name) {
    doc.font('zh').fontSize(20).fillColor('#000000');
    doc.text(company.name.split('').join('  '), left, y, { width, align: 'center' });
    y += 30;
  }

  // 單頭：左右兩欄
  const colW = width / 2;
  const c1 = left, c2 = left + colW;
  doc.fontSize(10);
  const row = (x, lbl, val) => doc.text(`${lbl} ${val || ''}`, x, y, { width: colW - 10 });
  row(c1, '客戶名稱：', st.customer_name);
  row(c2, '業務人員：', '');
  y += 14;
  row(c1, '統一編號：', st.customer_tax_id);
  row(c2, '行動電話：', '');
  y += 14;
  row(c1, '公司電話：', st.customer_phone);
  row(c2, '公司電話：', company.phone || '');
  y += 14;
  row(c1, '公司傳真：', st.customer_fax);
  row(c2, '公司傳真：', company.fax || '');
  y += 14;
  row(c1, '公司地址：', st.customer_addr);
  row(c2, '公司地址：', company.address || '');
  y += 18;

  // 列帳日期（民國年）
  const toROC = (d) => { if (!d) return ''; const y = Number(d.slice(0, 4)); const m = d.slice(5, 7); const day = d.slice(8, 10); return `${y - 1911}年(${m}${day}`; };
  const p1 = st.period_start, p2 = st.period_end;
  const rocLabel = toROC(p1) + '~' + (p2 ? p2.slice(5, 7) + p2.slice(8, 10) + ')' : '');
  doc.fontSize(10).text(`列帳日期  ${rocLabel}`, left, y, { width });
  y += 18;

  // 明細表（11 欄，白底黑字）
  const headers = ['採購單號碼', '客戶品名', '數量', '單價', '金額', '營業稅金', '總計', '發票號碼', '月', '日', '備註'];
  const colWidths = [80, 80, 45, 45, 60, 50, 60, 80, 25, 25, 50];
  const totalW = colWidths.reduce((a, b) => a + b, 0);
  const scale = width / totalW;
  const cw = colWidths.map((w) => w * scale);
  const tableX = left;
  doc.fontSize(9);

  const headerTop = y;
  let cx = tableX;
  doc.fillColor('#000000');
  headers.forEach((h, i) => {
    doc.text(h, cx + 2, y + 5, { width: cw[i] - 2, align: 'center' });
    cx += cw[i];
  });
  // 表頭下方水平線
  doc.moveTo(tableX, y + 18).lineTo(tableX + width, y + 18).lineWidth(0.5).strokeColor('#000000').stroke();
  y += 18;

  const items = st.items || [];
  const rowH = 16;
  const totalRows = Math.max(items.length, 8); // 固定至少 8 列空行
  for (let r = 0; r < totalRows; r++) {
    const it = items[r] || {};
    cx = tableX;
    const dt = it.ship_date ? new Date(it.ship_date) : null;
    const vals = [
      it.po_no || '', it.part_no || '',
      it.qty ? Number(it.qty).toLocaleString() : '',
      it.unit_price ? Number(it.unit_price).toFixed(0) : '',
      it.amount ? Number(it.amount).toLocaleString() : '',
      it.tax_amount ? Number(it.tax_amount).toLocaleString() : '',
      it.total ? Number(it.total).toLocaleString() : '',
      it.invoice_no || '',
      dt ? dt.getMonth() + 1 : '',
      dt ? dt.getDate() : '',
      it.note || '',
    ];
    vals.forEach((v, i) => {
      doc.text(String(v || ''), cx + 3, y + 4, { width: cw[i] - 4, align: (i >= 2 && i <= 6) || i === 8 || i === 9 ? 'right' : 'left' });
      cx += cw[i];
    });
    doc.moveTo(tableX, y + rowH).lineTo(tableX + width, y + rowH).lineWidth(0.3).strokeColor('#000000').stroke();
    y += rowH;
  }
  const tableBottom = y;
  doc.rect(tableX, headerTop, width, tableBottom - headerTop).lineWidth(1.0).strokeColor('#000000').stroke();
  cx = tableX;
  for (let i = 1; i < cw.length; i++) {
    cx += cw[i - 1];
    doc.moveTo(cx, headerTop).lineTo(cx, tableBottom).lineWidth(0.3).strokeColor('#000000').stroke();
  }
  // 合計列（緊貼明細表底部，欄位對齊明細表）
  const sumTop = tableBottom; // 不留白，直接接在明細表下方
  const sumH = 24;
  doc.fontSize(11).fillColor('#000000').font('zh');
  // 左側文字：佔前 4 欄（採購單號/客戶品名/數量/單價 = cw[0..3]）
  const leftW = cw[0] + cw[1] + cw[2] + cw[3];
  doc.text(`付款條件: ${st.payment_terms || ''}，合計金額`, left + 6, sumTop + 8, { width: leftW - 6 });
  // 三個紅色數字，分別對齊「金額/營業稅金/總計」欄（index 4/5/6）
  const red = (x, w, v) => {
    doc.fillColor('#cc0000').font('zh').fontSize(12);
    doc.text(v, x + 2, sumTop + 7, { width: w - 4, align: 'center' });
    doc.fillColor('#000000').fontSize(10);
  };
  // 各欄 x 起點（對應明細表）
  const colX = [];
  let ax = tableX;
  for (let i = 0; i < cw.length; i++) { colX.push(ax); ax += cw[i]; }
  red(colX[4], cw[4], Number(st.subtotal || 0).toLocaleString());
  red(colX[5], cw[5], Number(st.tax_amount || 0).toLocaleString());
  red(colX[6], cw[6], Number(st.grand_total || 0).toLocaleString());
  // 右側：應收帳款標籤 + NT$ 數字，佔後 4 欄（發票號/月/日/備註 = cw[7..10]）
  const rightX = colX[7];
  const rightW = cw[7] + cw[8] + cw[9] + cw[10];
  doc.fillColor('#000000').font('zh').fontSize(11).text('應收帳款', rightX + 4, sumTop + 8, { width: rightW * 0.4, align: 'right' });
  doc.fillColor('#cc0000').font('zh').fontSize(12).text('NT$' + Number(st.grand_total || 0).toLocaleString(), rightX + rightW * 0.42, sumTop + 7, { width: rightW * 0.58 - 4, align: 'center' });
  doc.fillColor('#000000');
  // 外框
  doc.rect(left, sumTop, width, sumH).lineWidth(1.0).strokeColor('#000000').stroke();
  // 豎線：左側 cw[0..3] 合併為一格、右側 cw[7..10] 合併為一格；中間 cw[4..6] 三個紅色數字各自分隔
  [colX[4], colX[5], colX[6]].forEach((cx) => {
    doc.moveTo(cx, sumTop).lineTo(cx, sumTop + sumH).lineWidth(0.3).strokeColor('#000000').stroke();
  });
  y = sumTop + sumH;

  return documentFingerprint({
    type: 'customer-statement',
    id: st.id,
    statement_no: st.statement_no,
    customer_id: st.customer_id,
    grand_total: Number(st.grand_total || 0),
  });
}

router.get('/customer-statements/:id', requireAuth, wrap(async (req, res) => {
  const st = await db.prepare(`SELECT s.*, c.name AS customer_name, c.customer_no, c.tax_id AS customer_tax_id,
       c.phone AS customer_phone, c.fax AS customer_fax, c.address AS customer_addr
    FROM customer_statements s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?`).get(Number(req.params.id));
  if (!st) return res.status(404).json({ error: '對帳單不存在' });
  st.items = await db.prepare('SELECT * FROM customer_statement_items WHERE statement_id=? ORDER BY sort_order, id').all(st.id);
  const param = async (k) => { try { const r = await db.prepare('SELECT value FROM parameters WHERE key=?').get(k); return r ? r.value : ''; } catch { return ''; } };
  const company = {
    name: await param('company_name'),
    address: await param('company_address'),
    phone: await param('company_phone'),
    fax: await param('company_fax'),
  };
  const doc = createDoc({ title: '', watermark: false });
  doc.rect(0, 0, doc.page.width, 100).fillColor('#ffffff').fill();
  const fp = drawStatementToDoc(doc, st, company);
  addPageFooter(doc, undefined, fp, verifyUrlFor(req, fp));
  sendPdf(req, res, doc,
    { fp, doc_type: 'customer-statement', doc_id: st.id, doc_no: st.statement_no },
    `statement-${st.statement_no}.pdf`);
}));

// =================================================================
// 2.1) 報價單 — GET /api/pdf/quotes/:id
// =================================================================
router.get('/quotes/:id', requireAuth, wrap(async (req, res) => {
  const q = await loadQuote(req.params.id);
  if (!q) return res.status(404).json({ error: '報價單不存在' });

  const doc = createDoc({ title: '報 價 單' });
  const fingerprint = drawQuoteToDoc(doc, q);
  addPageFooter(doc, undefined, fingerprint, verifyUrlFor(req, fingerprint));
  sendPdf(req, res, doc,
    { fp: fingerprint, doc_type: 'quotation', doc_id: q.id, doc_no: q.quotation_no },
    `quotation-${q.quotation_no || q.id}.pdf`);
}));

// =================================================================
// 2.2) 供應商報價單 — GET /api/pdf/supplier-quotes/:id
// =================================================================
router.get('/supplier-quotes/:id', requireAuth, wrap(async (req, res) => {
  const q = await loadSupplierQuote(req.params.id);
  if (!q) return res.status(404).json({ error: '供應商報價單不存在' });

  const doc = createDoc({ title: '供 應 商 報 價 單' });
  const fingerprint = drawSupplierQuoteToDoc(doc, q);
  addPageFooter(doc, undefined, fingerprint, verifyUrlFor(req, fingerprint));
  sendPdf(req, res, doc,
    { fp: fingerprint, doc_type: 'supplier_quotation', doc_id: q.id, doc_no: q.quote_no },
    `supplier-quote-${q.quote_no || q.id}.pdf`);
}));

// =================================================================
// 2.3) 供應商訂單（採購單）— GET /api/pdf/supplier-orders/:id
// =================================================================
router.get('/supplier-orders/:id', requireAuth, wrap(async (req, res) => {
  const o = await loadSupplierOrder(req.params.id);
  if (!o) return res.status(404).json({ error: '供應商訂單不存在' });

  const doc = createDoc({ title: '採 購 單' });
  const fingerprint = drawSupplierOrderToDoc(doc, o);
  addPageFooter(doc, undefined, fingerprint, verifyUrlFor(req, fingerprint));
  sendPdf(req, res, doc,
    { fp: fingerprint, doc_type: 'supplier_order', doc_id: o.id, doc_no: o.order_no },
    `supplier-order-${o.order_no || o.id}.pdf`);
}));

// =================================================================
// 2.4) 供應商出貨（進貨單）— GET /api/pdf/supplier-shipments/:id
// =================================================================
router.get('/supplier-shipments/:id', requireAuth, wrap(async (req, res) => {
  const s = await loadSupplierShipment(req.params.id);
  if (!s) return res.status(404).json({ error: '進貨單不存在' });

  const doc = createDoc({ title: '進 貨 單' });
  const fingerprint = drawSupplierShipmentToDoc(doc, s);
  addPageFooter(doc, undefined, fingerprint, verifyUrlFor(req, fingerprint));
  sendPdf(req, res, doc,
    { fp: fingerprint, doc_type: 'supplier_shipment', doc_id: s.id, doc_no: s.shipment_no },
    `supplier-shipment-${s.shipment_no || s.id}.pdf`);
}));

// ========== 共用：抓報價單完整資料（含 items 與合計） ==========
async function loadQuote(id) {
  const q = await db.prepare(`
    SELECT q.*, c.name AS customer_name, c.customer_no, c.tax_id AS cust_tax_id,
           c.address AS cust_address, c.phone AS cust_phone, c.contact_name,
           u.name AS sales_name
    FROM quotations q
    LEFT JOIN customers c ON c.id=q.customer_id
    LEFT JOIN users u ON u.id=q.sales_id
    WHERE q.id=?`).get(id);
  if (!q) return null;
  q.items = await db.prepare(`SELECT * FROM quotation_items WHERE quotation_id=? ORDER BY sort_order, id`).all(id);
  const subtotal = q.items.reduce((s, it) => s + Number(it.amount || 0), 0);
  const tax = q.items.reduce((s, it) => s + Number(it.tax_amount || 0), 0);
  const total = q.items.reduce((s, it) => s + Number(it.total || 0), 0);
  q.totals = { subtotal, tax, total };
  // 抓各關簽核人名+日期（已核准的）— 供 PDF 簽核列自動帶入（與出貨單一致）
  try {
    q.approved_logs = await db.prepare(`
      SELECT al.step_name, u.name AS actor_name, al.finished_at
      FROM approval_logs al LEFT JOIN users u ON u.id=al.actor_id
      WHERE al.doc_type='quote' AND al.doc_id=? AND al.action='approve'
      ORDER BY al.id`).all(q.id);
  } catch { q.approved_logs = []; }
  return q;
}

/**
 * 報價單繪圖
 */
function drawQuoteToDoc(doc, q) {
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;
  const topY = 110;
  const cur = q.currency || 'TWD';

  doc.font('zh').fontSize(10).fillColor('#000000');
  const leftLines = [
    ['報價單號', q.quotation_no || `#${q.id}`],
    ['報價日期', q.quotation_date || '-'],
    ['有效日期', q.valid_until || '-'],
    ['幣別 / 匯率', `${cur} @ ${Number(q.exchange_rate || 1)}`],
  ];
  let yy = topY;
  for (const [k, v] of leftLines) {
    doc.fillColor('#666666').text(`${k}：`, left, yy, { width: 80 });
    doc.fillColor('#000000').text(String(v), left + 80, yy, { width: width / 2 - 80 });
    yy += 18;
  }

  let ry = topY;
  const rx = left + width / 2 + 10;
  const rw = width / 2 - 10;
  const rightLines = [
    ['客戶編號', q.customer_no || '-'],
    ['客戶名稱', q.customer_name || '-'],
    ['統一編號', q.cust_tax_id || '-'],
    ['聯絡人', q.contact_name || '-'],
  ];
  for (const [k, v] of rightLines) {
    doc.fillColor('#666666').text(`${k}：`, rx, ry, { width: 80 });
    doc.fillColor('#000000').text(String(v), rx + 80, ry, { width: rw - 80 });
    ry += 18;
  }

  let ty = Math.max(yy, ry) + 10;
  doc.fillColor('#003366').font('zh').fontSize(11).text('■ 報價明細', left, ty);
  ty += 18;
  const itemRows = (q.items || []).map((it) => [
    it.part_no || '-',
    it.description || '-',
    Number(it.qty || 0).toLocaleString(),
    it.unit || 'PCS',
    fmtMoney(it.unit_price, cur),
    fmtMoney(it.amount, cur),
  ]);
  ty = drawTable(doc, {
    x: left, y: ty, colWidths: [80, 190, 60, 50, 85, 90],
    headers: ['料號', '品名規格', '數量', '單位', '單價', '金額'],
    rows: itemRows,
    aligns: ['left', 'left', 'right', 'center', 'right', 'right'],
  });
  ty = ensureSpace(doc, ty, 150);   // 保留合計列 / 簽核欄空間，避免被擠出紙張

  ty += 8;
  doc.fillColor('#000000').font('zh').fontSize(10);
  doc.text(`小計：${fmtMoney(q.totals.subtotal, cur)}`, left, ty, { width: width / 2 });
  doc.text(`稅額：${fmtMoney(q.totals.tax, cur)}`, left + width / 2, ty, { width: width / 2 });
  ty += 18;
  doc.text(`含稅合計：${fmtMoney(q.totals.total, cur)}`, left, ty, { width: width / 2 });

  if (q.note) {
    ty += 12;
    doc.fillColor('#666666').font('zh').fontSize(9).text(`備註：${q.note}`, left, ty, { width });
  }

  // 簽核列（與出貨單相同：核 准／會 計／業 務／客戶簽收，自動帶入簽核人與日期）
  drawApprovalSignatureRow(doc, ensureSpace(doc, ty + 20, 42), width, q.approved_logs);

  return documentFingerprint({
    type: 'quotation',
    id: q.id,
    quotation_no: q.quotation_no,
    customer_id: q.customer_id,
    customer_name: q.customer_name,
    total: Math.round(q.totals.total * 100) / 100,
  });
}

// ========== 供應商報價單 ==========
async function loadSupplierQuote(id) {
  const q = await db.prepare(`
    SELECT q.*, s.name AS supplier_name, s.code AS supplier_code, s.contact_name,
           s.phone AS supplier_phone, s.email AS supplier_email
    FROM supplier_quotes q
    LEFT JOIN suppliers s ON s.id=q.supplier_id
    WHERE q.id=?`).get(id);
  if (!q) return null;
  q.items = await db.prepare(`SELECT * FROM supplier_quote_items WHERE quote_id=? ORDER BY sort_order, id`).all(id);
  const subtotal = q.items.reduce((s, it) => s + Number(it.amount || 0), 0);
  const tax = q.items.reduce((s, it) => s + Number(it.tax_amount || 0), 0);
  const total = q.items.reduce((s, it) => s + Number(it.total || 0), 0);
  q.totals = { subtotal, tax, total };
  return q;
}

function drawSupplierQuoteToDoc(doc, q) {
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;
  const topY = 110;
  const cur = 'RMB';

  doc.font('zh').fontSize(10).fillColor('#000000');
  const leftLines = [
    ['報價單號', q.quote_no || `#${q.id}`],
    ['報價日期', q.quote_date || '-'],
    ['有效日期', q.valid_until || '-'],
  ];
  let yy = topY;
  for (const [k, v] of leftLines) {
    doc.fillColor('#666666').text(`${k}：`, left, yy, { width: 80 });
    doc.fillColor('#000000').text(String(v), left + 80, yy, { width: width / 2 - 80 });
    yy += 18;
  }

  let ry = topY;
  const rx = left + width / 2 + 10;
  const rw = width / 2 - 10;
  const rightLines = [
    ['供應商編號', q.supplier_code || '-'],
    ['供應商名稱', q.supplier_name || '-'],
    ['聯絡人', q.contact_name || '-'],
    ['電話', q.supplier_phone || '-'],
  ];
  for (const [k, v] of rightLines) {
    doc.fillColor('#666666').text(`${k}：`, rx, ry, { width: 80 });
    doc.fillColor('#000000').text(String(v), rx + 80, ry, { width: rw - 80 });
    ry += 18;
  }

  let ty = Math.max(yy, ry) + 10;
  doc.fillColor('#003366').font('zh').fontSize(11).text('■ 報價明細', left, ty);
  ty += 18;
  const itemRows = (q.items || []).map((it) => [
    it.part_no || '-',
    it.description || '-',
    Number(it.qty || 0).toLocaleString(),
    it.unit || 'PCS',
    fmtMoney(it.unit_price, cur),
    fmtMoney(it.amount, cur),
  ]);
  ty = drawTable(doc, {
    x: left, y: ty, colWidths: [80, 190, 60, 50, 85, 90],
    headers: ['料號', '品名規格', '數量', '單位', '單價', '金額'],
    rows: itemRows,
    aligns: ['left', 'left', 'right', 'center', 'right', 'right'],
  });
  ty = ensureSpace(doc, ty, 150);   // 保留合計列 / 簽核欄空間，避免被擠出紙張

  ty += 8;
  doc.fillColor('#000000').font('zh').fontSize(10);
  doc.text(`小計：${fmtMoney(q.totals.subtotal, cur)}`, left, ty, { width: width / 2 });
  doc.text(`稅額：${fmtMoney(q.totals.tax, cur)}`, left + width / 2, ty, { width: width / 2 });
  ty += 18;
  doc.text(`含稅合計：${fmtMoney(q.totals.total, cur)}`, left, ty, { width: width / 2 });

  if (q.note) {
    ty += 12;
    doc.fillColor('#666666').font('zh').fontSize(9).text(`備註：${q.note}`, left, ty, { width });
  }

  drawApprovalSignatureRow(doc, ensureSpace(doc, ty + 20, 42), width, [], '供應商簽收：');

  return documentFingerprint({
    type: 'supplier_quotation',
    id: q.id,
    quote_no: q.quote_no,
    supplier_id: q.supplier_id,
    supplier_name: q.supplier_name,
    total: Math.round(q.totals.total * 100) / 100,
  });
}

// ========== 供應商訂單（採購單） ==========
async function loadSupplierOrder(id) {
  const o = await db.prepare(`
    SELECT o.*, s.name AS supplier_name, s.code AS supplier_code, s.contact_name,
           s.phone AS supplier_phone, s.email AS supplier_email
    FROM supplier_orders o
    LEFT JOIN suppliers s ON s.id=o.supplier_id
    WHERE o.id=?`).get(id);
  if (!o) return null;
  o.items = await db.prepare(`SELECT * FROM supplier_order_items WHERE order_id=? ORDER BY sort_order, id`).all(id);
  const subtotal = o.items.reduce((s, it) => s + Number(it.amount || 0), 0);
  const tax = o.items.reduce((s, it) => s + Number(it.tax_amount || 0), 0);
  const total = o.items.reduce((s, it) => s + Number(it.total || 0), 0);
  o.totals = { subtotal, tax, total };
  // 電子簽核資訊（核決主管／承辦人／狀態／日期）
  o.approval = await buildApprovalInfo('supplier-order', o);
  // 抓各關簽核人名+日期（已核准的），供四欄簽核列自動蓋章
  try {
    o.approved_logs = await db.prepare(`
      SELECT al.step_name, u.name AS actor_name, al.finished_at
      FROM approval_logs al LEFT JOIN users u ON u.id=al.actor_id
      WHERE al.doc_type='supplier-order' AND al.doc_id=? AND al.action='approve'
      ORDER BY al.id`).all(o.id);
  } catch { o.approved_logs = []; }
  return o;
}

/** 簽核資訊彙整：從 approval_logs 取出送核人／核決人／動作／日期 */
async function buildApprovalInfo(docType, row) {
  const logs = await db.prepare('SELECT * FROM approval_logs WHERE doc_type=? AND doc_id=? ORDER BY id').all(docType, row.id);
  const submit = logs.find((l) => l.action === 'submit');
  const acts = logs.filter((l) => ['approve', 'reject', 'return'].includes(l.action));
  const lastAct = acts.length ? acts[acts.length - 1] : null;
  const subName = row.submitter_id
    ? ((await db.prepare('SELECT name FROM users WHERE id=?').get(row.submitter_id) || {}).name || null)
    : null;
  let approver = null, approverDate = null, approverAction = null;
  if (lastAct) {
    approver = lastAct.actor_name || null;
    approverDate = lastAct.created_at ? String(lastAct.created_at).slice(0, 10) : null;
    approverAction = lastAct.action;
  }
  return {
    status: row.approval_status || 'none',
    submitter: subName,
    approver,
    approverDate,
    approverAction,
  };
}

/** 供應商訂單 PDF 簽核欄（核決主管／承辦人，2 欄） */
function supplierApprovalSignature(opts) {
  const { approver, approverDate, approverAction, submitter, status } = opts;
  const approverVal = (() => {
    if (status === 'approved') return approver || '（簽名）';
    if (status === 'rejected') return `${approver || ''}（駁回）`;
    if (status === 'returned') return `${approver || ''}（退回）`;
    if (status === 'pending') return '（待簽核）';
    return '（簽名）';
  })();
  const submitterVal = submitter || '（簽名）';
  return {
    titles: ['核決主管', '承辦人'],
    values: [approverVal, submitterVal],
    dates: [
      approverDate ? `日期：${approverDate}` : '日期：____ / ____ / ____',
      submitter ? (status !== 'none' ? '送核：已送出' : '日期：____ / ____ / ____') : '日期：____ / ____ / ____',
    ],
  };
}

function drawSupplierOrderToDoc(doc, o) {
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;
  const topY = 110;
  const cur = 'RMB';

  doc.font('zh').fontSize(10).fillColor('#000000');
  const leftLines = [
    ['採購單號', o.order_no || `#${o.id}`],
    ['訂單日期', o.order_date || '-'],
    ['交期', o.due_date || '-'],
  ];
  let yy = topY;
  for (const [k, v] of leftLines) {
    doc.fillColor('#666666').text(`${k}：`, left, yy, { width: 80 });
    doc.fillColor('#000000').text(String(v), left + 80, yy, { width: width / 2 - 80 });
    yy += 18;
  }

  let ry = topY;
  const rx = left + width / 2 + 10;
  const rw = width / 2 - 10;
  const rightLines = [
    ['供應商編號', o.supplier_code || '-'],
    ['供應商名稱', o.supplier_name || '-'],
    ['聯絡人', o.contact_name || '-'],
    ['電話', o.supplier_phone || '-'],
  ];
  for (const [k, v] of rightLines) {
    doc.fillColor('#666666').text(`${k}：`, rx, ry, { width: 80 });
    doc.fillColor('#000000').text(String(v), rx + 80, ry, { width: rw - 80 });
    ry += 18;
  }

  let ty = Math.max(yy, ry) + 10;
  doc.fillColor('#003366').font('zh').fontSize(11).text('■ 採購明細', left, ty);
  ty += 18;
  const itemRows = (o.items || []).map((it) => [
    it.part_no || '-',
    it.description || '-',
    Number(it.qty || 0).toLocaleString(),
    it.unit || 'PCS',
    fmtMoney(it.unit_price, cur),
    fmtMoney(it.amount, cur),
  ]);
  ty = drawTable(doc, {
    x: left, y: ty, colWidths: [80, 190, 60, 50, 85, 90],
    headers: ['料號', '品名規格', '數量', '單位', '單價', '金額'],
    rows: itemRows,
    aligns: ['left', 'left', 'right', 'center', 'right', 'right'],
  });
  ty = ensureSpace(doc, ty, 150);   // 保留合計列 / 簽核欄空間，避免被擠出紙張

  ty += 8;
  doc.fillColor('#000000').font('zh').fontSize(10);
  doc.text(`小計：${fmtMoney(o.totals.subtotal, cur)}`, left, ty, { width: width / 2 });
  doc.text(`稅額：${fmtMoney(o.totals.tax, cur)}`, left + width / 2, ty, { width: width / 2 });
  ty += 18;
  doc.text(`含稅合計：${fmtMoney(o.totals.total, cur)}`, left, ty, { width: width / 2 });

  if (o.note) {
    ty += 12;
    doc.fillColor('#666666').font('zh').fontSize(9).text(`備註：${o.note}`, left, ty, { width });
  }

  drawApprovalSignatureRow(doc, ensureSpace(doc, ty + 20, 42), width, o.approved_logs, '供應商簽收：');

  return documentFingerprint({
    type: 'supplier_order',
    id: o.id,
    order_no: o.order_no,
    supplier_id: o.supplier_id,
    supplier_name: o.supplier_name,
    total: Math.round(o.totals.total * 100) / 100,
  });
}

// ========== 供應商出貨（進貨單） ==========
async function loadSupplierShipment(id) {
  const s = await db.prepare(`
    SELECT s.*, su.name AS supplier_name, su.code AS supplier_code, su.contact_name,
           su.phone AS supplier_phone, so.order_no AS po_no
    FROM supplier_shipments s
    LEFT JOIN suppliers su ON su.id=s.supplier_id
    LEFT JOIN supplier_orders so ON so.id=s.order_id
    WHERE s.id=?`).get(id);
  return s || null;
}

function drawSupplierShipmentToDoc(doc, s) {
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;
  const topY = 110;

  doc.font('zh').fontSize(10).fillColor('#000000');
  const leftLines = [
    ['進貨單號', s.shipment_no || `#${s.id}`],
    ['進貨日期', s.ship_date || '-'],
    ['數量', Number(s.qty || 0).toLocaleString()],
  ];
  let yy = topY;
  for (const [k, v] of leftLines) {
    doc.fillColor('#666666').text(`${k}：`, left, yy, { width: 80 });
    doc.fillColor('#000000').text(String(v), left + 80, yy, { width: width / 2 - 80 });
    yy += 18;
  }

  let ry = topY;
  const rx = left + width / 2 + 10;
  const rw = width / 2 - 10;
  const rightLines = [
    ['供應商編號', s.supplier_code || '-'],
    ['供應商名稱', s.supplier_name || '-'],
    ['關聯採購單', s.po_no || '-'],
    ['發票號碼', s.invoice_no || '-'],
    ['發票日期', s.invoice_date || '-'],
  ];
  for (const [k, v] of rightLines) {
    doc.fillColor('#666666').text(`${k}：`, rx, ry, { width: 80 });
    doc.fillColor('#000000').text(String(v), rx + 80, ry, { width: rw - 80 });
    ry += 18;
  }

  let ty = Math.max(yy, ry) + 20;
  if (s.note) {
    doc.fillColor('#666666').font('zh').fontSize(9).text(`備註：${s.note}`, left, ty, { width });
    ty += 20;
  }

  drawApprovalSignatureRow(doc, ensureSpace(doc, ty + 10, 42), width, [], '供應商簽收：');

  return documentFingerprint({
    type: 'supplier_shipment',
    id: s.id,
    shipment_no: s.shipment_no,
    supplier_id: s.supplier_id,
    supplier_name: s.supplier_name,
  });
}

// =================================================================
// 3) 對帳單 — GET /api/pdf/customers/:id/statement?month=YYYY-MM
// =================================================================
router.get('/customers/:id/statement', requireAuth, wrap(async (req, res) => {
  const customerId = req.params.id;
  const month = req.query.month || toMonthStr(new Date());

  const customer = await db.prepare(`SELECT * FROM customers WHERE id=?`).get(customerId);
  if (!customer) return res.status(404).json({ error: '客戶不存在' });

  const orders = await db.prepare(`
    SELECT o.*, u.name AS sales_name
    FROM orders o
    LEFT JOIN users u ON u.id=o.sales_id
    WHERE o.customer_id=? AND strftime('%Y-%m', o.order_date)=?
    ORDER BY o.order_date, o.id`).all(customerId, month);

  const arList = await db.prepare(`
    SELECT ar.*, o.order_no, o.currency, o.exchange_rate
    FROM receivables ar
    JOIN orders o ON o.id=ar.order_id
    WHERE o.customer_id=? AND strftime('%Y-%m', ar.due_date)=? AND (ar.legacy IS NULL OR ar.legacy=0)
    ORDER BY ar.due_date, ar.id`).all(customerId, month);

  const doc = createDoc({ title: '客 戶 對 帳 單' });
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;
  const topY = 110;

  doc.font('zh').fontSize(11).fillColor('#003366').text(`對帳月份：${month}`, left, topY);
  doc.font('zh').fontSize(10).fillColor('#000000');
  doc.text(`客戶編號：${customer.customer_no || '-'}    客戶名稱：${customer.name}    統一編號：${customer.tax_id || '-'}`, left, topY + 22, { width });
  let ty = topY + 50;

  // 訂單明細
  doc.fillColor('#003366').font('zh').fontSize(11).text('■ 訂單明細', left, ty);
  ty += 18;
  const orderRows = orders.map((o) => [
    o.order_date,
    o.order_no,
    o.currency,
    fmtMoney(o.amount, o.currency),
    fmtMoney(o.tax_amount, o.currency),
    fmtMoney(o.total, o.currency),
    fmtMoney(o.total_base, 'TWD'),
  ]);
  ty = drawTable(doc, {
    x: left, y: ty, colWidths: [80, 100, 50, 75, 65, 80, 90],
    headers: ['日期', '訂單編號', '幣別', '原幣應收', '稅額', '合計', 'TWD'],
    rows: orderRows,
    aligns: ['center', 'left', 'center', 'right', 'right', 'right', 'right'],
  });
  ty = ensureSpace(doc, ty, 80);   // 保留下一段標題 / 表頭空間

  // 應收帳款
  ty += 12;
  doc.fillColor('#003366').font('zh').fontSize(11).text('■ 應收帳款', left, ty);
  ty += 18;
  const arRows = arList.map((ar) => [
    ar.ar_no,
    ar.due_date,
    fmtMoney(ar.amount, ar.currency),
    fmtMoney(ar.received_amount, ar.currency),
    ar.received_date || '-',
    ar.status,
  ]);
  ty = drawTable(doc, {
    x: left, y: ty, colWidths: [110, 90, 90, 90, 90, 80],
    headers: ['應收單號', '到期日', '應收金額', '已收金額', '收款日期', '狀態'],
    rows: arRows,
    aligns: ['left', 'center', 'right', 'right', 'center', 'center'],
  });
  ty = ensureSpace(doc, ty, 150);   // 保留月度彙總 / 簽核欄空間

  // 月度彙總
  const orderTotals = orders.reduce((t, o) => ({
    amount: t.amount + Number(o.amount || 0),
    tax: t.tax + Number(o.tax_amount || 0),
    total: t.total + Number(o.total || 0),
    total_base: t.total_base + Number(o.total_base || 0),
  }), { amount: 0, tax: 0, total: 0, total_base: 0 });

  const arTotals = arList.reduce((t, ar) => ({
    amount: t.amount + Number(ar.amount || 0),
    received: t.received + Number(ar.received_amount || 0),
    pending: t.pending + Number(ar.amount || 0) - Number(ar.received_amount || 0),
  }), { amount: 0, received: 0, pending: 0 });

  ty += 16;
  doc.fillColor('#003366').font('zh').fontSize(11);
  doc.text(`本月訂單（多幣別原幣合計：${fmtMoney(orderTotals.amount)} 稅額：${fmtMoney(orderTotals.tax)} 合計：${fmtMoney(orderTotals.total)} / TWD：${fmtMoney(orderTotals.total_base)}）`,
    left, ty, { width });
  ty += 18;
  doc.fillColor('#000000').font('zh').fontSize(10);
  doc.text(`本月應收 ${fmtMoney(arTotals.amount)} / 已收 ${fmtMoney(arTotals.received)} / 未收 ${fmtMoney(arTotals.pending)}`,
    left, ty, { width });

  drawApprovalSignatureRow(doc, ensureSpace(doc, ty + 30, 42), width, []);

  const fingerprint = documentFingerprint({
    type: 'statement',
    customer_id: customerId,
    month,
    order_count: orders.length,
    ar_count: arList.length,
    total_base: Math.round(orderTotals.total_base * 100) / 100,
  });
  addPageFooter(doc, undefined, fingerprint, verifyUrlFor(req, fingerprint));
  sendPdf(req, res, doc,
    { fp: fingerprint, doc_type: 'statement', doc_id: customerId, doc_no: `${customer.customer_no || customerId}-${month}` },
    `statement-${customer.customer_no || customerId}-${month}.pdf`);
}));

// =================================================================
// 4) 應收帳款彙總表 — GET /api/pdf/receivables/summary?month=YYYY-MM
// =================================================================
router.get('/receivables/summary', requireAuth, wrap(async (req, res) => {
  const month = req.query.month || toMonthStr(new Date());

  const arList = await db.prepare(`
    SELECT ar.*, o.order_no, o.currency, o.exchange_rate,
           c.name AS customer_name, c.customer_no
    FROM receivables ar
    JOIN orders o ON o.id=ar.order_id
    LEFT JOIN customers c ON c.id=o.customer_id
    WHERE strftime('%Y-%m', ar.due_date)=? AND (ar.legacy IS NULL OR ar.legacy=0)
    ORDER BY ar.due_date, ar.id`).all(month);

  const orders = await db.prepare(`
    SELECT * FROM orders WHERE strftime('%Y-%m', order_date)=? ORDER BY order_date, id`).all(month);

  const doc = createDoc({ title: '應 收 帳 款 彙 總 表' });
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;
  const topY = 110;

  doc.font('zh').fontSize(11).fillColor('#003366').text(`彙總月份：${month}`, left, topY);
  doc.fontSize(9).fillColor('#666666').text(`製表日期：${new Date().toISOString().slice(0, 10)}`, left, topY + 16);

  let ty = topY + 50;
  doc.fillColor('#003366').font('zh').fontSize(11).text('■ 訂單彙總', left, ty);
  ty += 18;
  const orderRows = orders.map((o) => [
    o.order_date,
    o.order_no,
    o.currency,
    fmtMoney(o.total, o.currency),
    fmtMoney(o.total_base, 'TWD'),
  ]);
  ty = drawTable(doc, {
    x: left, y: ty, colWidths: [80, 100, 50, 100, 110],
    headers: ['日期', '訂單編號', '幣別', '原幣合計', 'TWD'],
    rows: orderRows,
    aligns: ['center', 'left', 'center', 'right', 'right'],
  });
  ty = ensureSpace(doc, ty, 80);   // 保留下一段標題 / 表頭空間

  ty += 12;
  doc.fillColor('#003366').font('zh').fontSize(11).text('■ 應收彙總', left, ty);
  ty += 18;
  const arRows = arList.map((ar) => [
    ar.ar_no,
    ar.customer_no,
    ar.customer_name,
    ar.due_date,
    fmtMoney(ar.amount, ar.currency),
    fmtMoney(ar.received_amount, ar.currency),
    agingBucket(ar.due_date),
  ]);
  ty = drawTable(doc, {
    x: left, y: ty, colWidths: [100, 70, 110, 90, 80, 80, 60],
    headers: ['應收單號', '客戶編號', '客戶名稱', '到期日', '應收', '已收', '帳齡'],
    rows: arRows,
    aligns: ['left', 'center', 'left', 'center', 'right', 'right', 'center'],
  });
  ty = ensureSpace(doc, ty, 120);   // 保留全月總計 / 簽核欄空間

  const totalAmount = arList.reduce((t, ar) => t + Number(ar.amount || 0), 0);
  const totalReceived = arList.reduce((t, ar) => t + Number(ar.received_amount || 0), 0);
  const totalPending = totalAmount - totalReceived;

  ty += 16;
  doc.fillColor('#000000').font('zh').fontSize(11);
  doc.text(`全月總計：應收 ${fmtMoney(totalAmount)} / 已收 ${fmtMoney(totalReceived)} / 未收 ${fmtMoney(totalPending)}`,
    left, ty, { width });

  drawApprovalSignatureRow(doc, ensureSpace(doc, ty + 30, 42), width, []);

  const fingerprint = documentFingerprint({
    type: 'receivables_summary',
    month,
    order_count: orders.length,
    ar_count: arList.length,
    total_amount: Math.round(totalAmount * 100) / 100,
  });
  addPageFooter(doc, undefined, fingerprint, verifyUrlFor(req, fingerprint));
  sendPdf(req, res, doc,
    { fp: fingerprint, doc_type: 'receivables_summary', doc_id: null, doc_no: month },
    `receivables-${month}.pdf`);
}));

// =================================================================
// 5) 批次合併列印 — POST /api/pdf/batch
//    body: { type: 'orders'|'shipments', ids: [1,2,3] }
//    把多張單據合併成同一個 PDF，每頁是一張單據
// =================================================================
router.post('/batch', requireAuth, wrap(async (req, res) => {
  const { type, ids } = req.body || {};
  if (!type || !['orders', 'shipments', 'quotes', 'supplier-quotes', 'supplier-orders'].includes(type)) {
    return res.status(400).json({ error: 'type 必須是 orders、shipments、quotes、supplier-quotes 或 supplier-orders' });
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids 必須是非空陣列' });
  }
  if (ids.length > 50) {
    return res.status(400).json({ error: '批次最多 50 筆（避免單檔過大）' });
  }

  // 載入所有單據
  const docs = [];
  const missing = [];
  for (const id of ids) {
    if (type === 'orders') {
      const o = await loadOrder(id);
      if (!o) { missing.push(id); continue; }
      docs.push({ id: o.id, label: o.order_no || `#${o.id}`, draw: (d) => drawOrderToDoc(d, o) });
    } else if (type === 'shipments') {
      const sh = await loadShipment(id);
      if (!sh) { missing.push(id); continue; }
      docs.push({ id: sh.id, label: sh.shipment_no || `#${sh.id}`, draw: async (d) => await drawShipmentToDoc(d, sh) });
    } else if (type === 'quotes') {
      const q = await loadQuote(id);
      if (!q) { missing.push(id); continue; }
      docs.push({ id: q.id, label: q.quotation_no || `#${q.id}`, draw: (d) => drawQuoteToDoc(d, q) });
    } else if (type === 'supplier-quotes') {
      const sq = await loadSupplierQuote(id);
      if (!sq) { missing.push(id); continue; }
      docs.push({ id: sq.id, label: sq.quote_no || `#${sq.id}`, draw: (d) => drawSupplierQuoteToDoc(d, sq) });
    } else {
      const so = await loadSupplierOrder(id);
      if (!so) { missing.push(id); continue; }
      docs.push({ id: so.id, label: so.order_no || `#${so.id}`, draw: (d) => drawSupplierOrderToDoc(d, so) });
    }
  }

  if (docs.length === 0) {
    return res.status(404).json({ error: '所有 id 都查無資料', missing });
  }

  // 建立單一 PDF，第一頁用 createDoc（自動畫抬頭 + 浮水印），後續每張單據 addPage
  const titles = { orders: '訂 單 確 認 單 (批次)', shipments: '出 貨 單 (批次)', quotes: '報 價 單 (批次)', 'supplier-quotes': '供 應 商 報 價 單 (批次)', 'supplier-orders': '採 購 單 (批次)' };
  const doc = createDoc({ title: titles[type] });

  let fingerprints = [];
  for (let i = 0; i < docs.length; i++) {
    if (i > 0) doc.addPage(); // 從第二張開始換頁（第一張已經是 createDoc 開好的）
    const fp = docs[i].draw(doc);
    fingerprints.push(`${docs[i].label}=${fp}`);
  }

  // 批次用「彙總指紋」：所有單一指紋以 | 串接再 HMAC
  const batchFp = documentFingerprint({
    type: `batch_${type}`,
    count: docs.length,
    children: fingerprints.join('|'),
  });
  addPageFooter(doc, undefined, batchFp, verifyUrlFor(req, batchFp));

  const filename = `batch-${type}-${new Date().toISOString().slice(0, 10)}.pdf`;
  sendPdf(req, res, doc,
    { fp: batchFp, doc_type: `batch_${type}`, doc_id: null, doc_no: `${docs.length} 張`, source: 'batch' },
    filename);
}));

module.exports = router;
// 額外匯出（供 email.js 批次寄送附件用）
module.exports.loadQuote = loadQuote;
module.exports.drawQuoteToDoc = drawQuoteToDoc;
// 額外匯出（供 email.js / pdf-helpers.js 共用指紋紀錄、QR 網址與繪圖邏輯）
module.exports.recordFingerprint = recordFingerprint;
module.exports.verifyUrlFor = verifyUrlFor;
module.exports.finishDoc = finishDoc;
module.exports.loadOrder = loadOrder;
module.exports.drawOrderToDoc = drawOrderToDoc;
module.exports.loadShipment = loadShipment;
module.exports.drawShipmentToDoc = drawShipmentToDoc;
module.exports.loadSupplierQuote = loadSupplierQuote;
module.exports.drawSupplierQuoteToDoc = drawSupplierQuoteToDoc;
module.exports.loadSupplierOrder = loadSupplierOrder;
module.exports.drawSupplierOrderToDoc = drawSupplierOrderToDoc;
module.exports.loadSupplierShipment = loadSupplierShipment;
module.exports.drawSupplierShipmentToDoc = drawSupplierShipmentToDoc;
module.exports.loadStatement = async function loadStatement(id) {
  const st = await db.prepare(`SELECT s.*, c.name AS customer_name, c.customer_no, c.tax_id AS customer_tax_id,
       c.phone AS customer_phone, c.fax AS customer_fax, c.address AS customer_addr
    FROM customer_statements s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?`).get(Number(id));
  if (!st) return null;
  st.items = await db.prepare('SELECT * FROM customer_statement_items WHERE statement_id=? ORDER BY sort_order, id').all(st.id);
  return st;
};
module.exports.drawStatementToDoc = drawStatementToDoc;