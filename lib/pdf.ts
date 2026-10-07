// @ts-nocheck
﻿'use strict';
/**
 * PDF 工具庫 — 共用底層（字型 / 抬頭 / 頁尾 / 簽核欄 / 中英數字格式）
 * 4 種單據共用此模組
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const PDFDocument = require('pdfkit');
const { db } = require('../lib/db');

// QR code（頁尾防偽查驗用）。未安裝時靜默略過，不影響 PDF 產生。
let QRCode = null;
try { QRCode = require('qrcode'); } catch (e) { console.warn('[pdf] 未安裝 qrcode 模組，頁尾將不繪製 QR'); }

// 字型路徑（Windows 內建中文字型）
const FONT_DIR = process.env.APP_FONT_DIR || 'C:/Windows/Fonts';
const FONT_REGULAR = path.join(FONT_DIR, 'NotoSansTC-VF.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'NotoSansTC-VF.ttf');  // VF 變數字型，自帶粗體 weight
const FONT_KAIU = path.join(FONT_DIR, 'kaiu.ttf');             // 標楷體，簽核欄用
let FONT_BOLD_VARIANT;
function getBoldFont() {
  if (!FONT_BOLD_VARIANT) {
    try { FONT_BOLD_VARIANT = require('fontkit').openSync(FONT_BOLD).getVariation('Bold'); }
    catch { FONT_BOLD_VARIANT = FONT_BOLD; }
  }
  return FONT_BOLD_VARIANT;
}

// 公司抬頭資料：從「系統外觀」參數讀取（名稱/英文名/統編/地址/電話/傳真），空白則對應欄位為空白
const getCompany = () => {
  const param = (k) => {
    try {
      const r = db.prepare('SELECT value FROM parameters WHERE key=?').get(k);
      return r ? r.value : '';
    } catch { return ''; }
  };
  return {
    name: param('company_name'),
    en: param('company_name_en'),
    tax_id: param('company_tax_id'),
    address: param('company_address'),
    phone: param('company_phone'),
    fax: param('company_fax'),
  };
};

/**
 * 建立 PDF 文件並套用預設字型
 */
function createDoc(opts = {}) {
  const company = getCompany();
  const doc = new PDFDocument({
    size: opts.size || 'A4',
    margins: opts.margins || { top: 110, bottom: 70, left: 50, right: 50 },
    info: opts.info || { Title: (company.name || '輔凰商貿系統') + ' 單據', Author: company.name || '輔凰商貿系統' },
    bufferPages: true,
  });
  // 註冊字型
  try { doc.registerFont('zh', FONT_REGULAR); } catch (e) { console.warn('[pdf] 中文字型註冊失敗：', e.message); }
  try { doc.registerFont('zh-bold', getBoldFont()); } catch (e) { console.warn('[pdf] 粗體中文字型註冊失敗：', e.message); }
  try { doc.registerFont('kaiu', FONT_KAIU); } catch (e) {}
  doc.font('zh');

  // 公司抬頭（第一頁 + 之後每次新增頁面）
  // pageAdded 只在這裡註冊一次；drawHeader 本身不再自我註冊（否則每新增一頁 handler 就倍增）
  drawHeader(doc, opts.title || '');
  doc.on('pageAdded', () => drawHeader(doc, opts.title || ''));

  // 浮水印（可選）：使用公司名稱，公司名稱空白時不畫水印
  if (opts.watermark !== false && (opts.watermarkText || company.name)) {
    drawWatermark(doc, opts.watermarkText || company.name, opts.watermarkOpacity || 0.08);
  }

  return doc;
}

/**
 * 浮水印：每頁背景半透明對角線大字
 * @param {PDFDocument} doc
 * @param {string} text 浮水印文字
 * @param {number} opacity 0~1，建議 0.05~0.15
 */
function drawWatermark(doc, text = '輔凰商貿', opacity = 0.08) {
  const drawOn = (pageDoc) => {
    pageDoc.save();
    pageDoc.fillColor('#888888');
    pageDoc.opacity(opacity);
    pageDoc.font('zh').fontSize(72);
    const cx = pageDoc.page.width / 2;
    const cy = pageDoc.page.height / 2;
    pageDoc.rotate(-30, { origin: [cx, cy] });
    pageDoc.text(text, cx - 200, cy - 36, { width: 400, align: 'center' });
    pageDoc.rotate(30, { origin: [cx, cy] });
    pageDoc.opacity(1);
    pageDoc.restore();
  };
  // 第一頁畫一次，之後每次 pageAdded 都畫
  doc.on('pageAdded', () => drawOn(doc));
}

/**
 * PDF 簽章密鑰（單一來源：資料庫 parameters.pdf_sign_secret）
 *
 * 優先序：參數 secret → 環境變數 APP_PDF_SIGN_SECRET → DB 參數 → 自動生成並寫入 DB
 * ⚠️ 2026-09-22 修正：舊版密鑰寫死公開預設值 'mj-default-sign-secret'，任何看過原始碼的人
 *    都能自行偽造「合法」指紋 → 等於毫無防偽力。改為首次啟動自動生成 32 bytes 隨機密鑰
 *    並存於 DB（隨備份同步，且四副本共用同一把，避免指紋不一致）。
 *    ⚠️ 輪替密鑰會使「以舊密鑰簽出的指紋」無法再被重算驗證（但紀錄表中的歷史紀錄仍有效）。
 */
const SIGN_SECRET_KEY = 'pdf_sign_secret';
let _signSecret = null;
function pdfSignSecret() {
  if (_signSecret) return _signSecret;
  if (process.env.APP_PDF_SIGN_SECRET) return (_signSecret = process.env.APP_PDF_SIGN_SECRET);
  // 明確覆寫來源：config.json 的 pdf.signSecret（留空則不採用，改由 DB 自動管理）
  try {
    const { cfg } = require('./config');
    if (cfg && cfg.pdf && cfg.pdf.signSecret) return (_signSecret = cfg.pdf.signSecret);
  } catch { /* config 不可用時略過 */ }
  try {
    const row = db.prepare('SELECT value FROM parameters WHERE key=?').get(SIGN_SECRET_KEY);
    if (row && row.value) return (_signSecret = row.value);
    const generated = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT OR REPLACE INTO parameters (key,value,label,group_name) VALUES (?,?,?,?)')
      .run(SIGN_SECRET_KEY, generated, 'PDF 文件簽章密鑰（系統自動產生，請勿任意變更）', 'system');
    return (_signSecret = generated);
  } catch (e) {
    console.warn('[pdf] 無法取得簽章密鑰，暫用預設值：', e.message);
    return 'mj-default-sign-secret';
  }
}

/** 密鑰指紋（前 8 碼）：可公開揭露，用來判斷文件是否由「目前這把密鑰」簽出 */
function fingerprintSecretId() {
  return crypto.createHash('sha256').update(pdfSignSecret()).digest('hex').slice(0, 8);
}

/**
 * 計算文件指紋（HMAC-SHA256，16 字 hex）＝ 單據「內容」指紋
 *
 * ⚠️ payload 內**不可包含 generated_at**：否則同一張單據每次列印指紋都不同，無法核對。
 *    列印時間改由紀錄表的 generated_at 與 PDF 檔案的 SHA-256（見 doc_fingerprints 表）承載。
 * @param {object} payload - 關鍵欄位（單據 id、單號、客戶 id、金額…）
 * @param {string} [secret] - 測試用覆寫密鑰；正式一律走 pdfSignSecret()
 * @returns {string} 16 字 hex 指紋
 */
function documentFingerprint(payload, secret) {
  const key = secret || pdfSignSecret();
  const text = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHmac('sha256', key).update(text).digest('hex').slice(0, 16);
}

/**
 * 畫公司抬頭（純繪製；「每頁自動重畫」由 createDoc 註冊一次 pageAdded 達成）
 */
function drawHeader(doc, docTitle) {
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;
  const top = 30;
  const c = getCompany();

  if (c.name) {
    doc.font('zh').fontSize(16).fillColor('#003366').text(c.name, left, top, { width, align: 'left' });
  }
  // 第二行：英文名稱 ＋ 統一編號（有值才顯示，空白則空白）
  const line2 = [c.en, c.tax_id ? `統編：${c.tax_id}` : ''].filter(Boolean).join('  ');
  if (line2) {
    doc.fontSize(8).fillColor('#666666').text(line2, left, top + 22, { width, align: 'left' });
  }
  // 第三行：地址 ＋ 電話 ＋ 傳真（有值才顯示）
  const contact = [c.address, c.phone, c.fax ? `傳真：${c.fax}` : ''].filter(Boolean).join('  ');
  if (contact) {
    doc.fontSize(8).text(contact, left, top + 32, { width, align: 'left' });
  }

  // 分隔線
  doc.moveTo(left, top + 48).lineTo(left + width, top + 48).lineWidth(1).strokeColor('#003366').stroke();

  // 單據標題（右側）
  if (docTitle) {
    doc.fontSize(14).fillColor('#003366').text(docTitle, left, top + 55, { width, align: 'right' });
  }
}

/**
 * 在指定位置畫 QR code（向量：逐 module 畫矩形，列印清晰、無點陣失真）
 * 同一列連續的深色 module 會合併成一個矩形，避免 PDF 指令暴增。
 * @param {PDFDocument} doc
 * @param {string} text QR 內容
 * @param {number} x 左上角 x
 * @param {number} y 左上角 y
 * @param {number} size 邊長（pt）
 */
function drawQr(doc, text, x, y, size) {
  if (!QRCode || !text) return;
  try {
    // ECC 'L'：容量最大 → QR 版本最小 → module 較大 → 最好掃
    const qr = QRCode.create(text, { errorCorrectionLevel: 'L' });
    const n = qr.modules.size;
    const data = qr.modules.data;
    const m = size / n;
    doc.save();
    doc.rect(x - 1.5, y - 1.5, size + 3, size + 3).fillColor('#ffffff').fill();
    doc.fillColor('#000000');
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!data[r * n + c]) { c++; continue; }
        let c2 = c;
        while (c2 + 1 < n && data[r * n + c2 + 1]) c2++;
        doc.rect(x + c * m, y + r * m, (c2 - c + 1) * m, m).fill();
        c = c2 + 1;
      }
    }
    doc.restore();
  } catch (e) {
    console.warn('[pdf] QR 繪製失敗：', e.message);
  }
}

/**
 * 畫頁尾（每頁）
 * @param {PDFDocument} doc
 * @param {string} [generatedAt] 列印時間字串（預設取現在）
 * @param {string} [fingerprint] 文件指紋（16 字 hex）
 * @param {string} [qrText] 要畫進 QR 的內容（通常是查驗網址）；未給則不畫 QR
 */
function addPageFooter(doc, generatedAt, fingerprint, qrText) {
  // 注意：bufferPages 模式下，doc.end() 才會真正觸發 pageAdded。
  // 因此 footer 分兩段：
  //   (1) 為已存在的頁面畫 footer
  //   (2) 註冊 pageAdded handler，為將來新增的頁面也畫 footer
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;
  const bottomY = doc.page.height - 50;
  // ⚠️ zh-TW 時間格式含 U+2009（THIN SPACE），Noto Sans TC 無此字符 → PDF 會顯示成空白方框
  //    統一正規化為一般空白，避免頁尾出現亂碼方框
  const stamp = String(generatedAt || new Date().toLocaleString('zh-TW', { hour12: false }))
    .replace(/[\u2009\u202F\u00A0]/g, ' ');

  function drawOnPage(idx, total) {
    doc.switchToPage(idx);
    // 暫時解除下邊界：頁尾是刻意畫在頁面底部留白區，若維持原下邊界，
    // 文字換行時 PDFKit 會判定「超出可書寫範圍」而自動 addPage（曾使 1 頁文件變成 3 頁空白/殘頁）。
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    // 防偽查驗 QR（右下角）：內容＝查驗網址，掃碼即可跳轉查驗頁
    const QR_SIZE = 52;
    if (qrText) {
      drawQr(doc, qrText, doc.page.width - right - QR_SIZE, doc.page.height - QR_SIZE - 11, QR_SIZE);
    }
    const textW = qrText ? width - QR_SIZE - 10 : width;
    doc.font('zh').fontSize(8).fillColor('#999999');
    // ⚠️ 文字務必「短到能單行放進 textW」：有 QR 時可用寬度會被扣掉 62pt。
    //    指紋排在前面，避免過長被換行擠到第二行（曾被 QR 區擠掉而看不見）。
    let line = `列印時間：${stamp}`;
    if (fingerprint) line += `  |  文件指紋：${fingerprint}`;
    if (total) line += `  |  第 ${idx + 1} / ${total} 頁`;
    line += '  |';
    doc.text(line, left, bottomY, { width: textW, align: qrText ? 'left' : 'center' });

    // 第二行標示製作單位；品牌使用 Noto Sans TC 變數字型 Bold 字重。
    const prefix = '由';
    const brand = '輔凰商貿系統';
    const suffix = ' 製作';
    const footerY = bottomY + 11;
    doc.font('zh').fontSize(8).fillColor('#999999');
    const prefixW = doc.widthOfString(prefix);
    doc.font('zh-bold').fontSize(8);
    const brandW = doc.widthOfString(brand);
    doc.font('zh').fontSize(8);
    const suffixW = doc.widthOfString(suffix);
    const fullW = prefixW + brandW + suffixW;
    const startX = qrText ? left : left + (width - fullW) / 2;
    doc.text(prefix, startX, footerY, { lineBreak: false });
    doc.font('zh-bold').fontSize(8).text(brand, startX + prefixW, footerY, { lineBreak: false });
    doc.font('zh').fontSize(8).text(suffix, startX + prefixW + brandW, footerY, { lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }

  // (1) 處理當前已存在的頁面（range.count = 已有頁數）
  const range = doc.bufferedPageRange();
  const initialCount = range.count;
  for (let i = 0; i < initialCount; i++) {
    drawOnPage(i, initialCount);
  }

  // (2) 為將來新增的頁面補 footer（doc.end() 會觸發 pageAdded）
  doc.on('pageAdded', () => {
    const r = doc.bufferedPageRange();
    // r.count 是「已建立」的頁數（含剛加入的新頁）
    drawOnPage(r.count - 1, r.count);
  });
}

/**
 * 欄寬自動適寬：欄寬總和超出「可列印寬度」時等比例縮小（最後一欄吸收四捨五入誤差）
 * @param {PDFDocument} doc
 * @param {number} x 表格左緣
 * @param {number[]} colWidths 原始欄寬
 * @returns {number[]} 適寬後的欄寬（未超出時原樣回傳）
 */
function fitColWidths(doc, x, colWidths) {
  const avail = doc.page.width - x - doc.page.margins.right;
  const sum = colWidths.reduce((a, b) => a + b, 0);
  if (sum <= 0 || sum <= avail + 0.01) return colWidths;
  const k = avail / sum;
  const out = colWidths.map((w) => Math.round(w * k * 100) / 100);
  const diff = Math.round((avail - out.reduce((a, b) => a + b, 0)) * 100) / 100;
  out[out.length - 1] = Math.round((out[out.length - 1] + diff) * 100) / 100;
  return out;
}

/**
 * 可書寫區域的下緣 y（頁高 − 下邊界）；超過此線的內容 PDFKit 會自動分頁
 */
function bottomLimit(doc) {
  return doc.page.height - doc.page.margins.bottom;
}

/**
 * 若 y 之後還要放 needed 高度的內容會超出可書寫區域，就先換頁並回傳新頁起始 y。
 * 用於表格之後的合計列／簽核欄，避免被擠到紙張外。
 * @param {PDFDocument} doc
 * @param {number} y 目前 y
 * @param {number} needed 還需要的高度
 * @returns {number} 可直接使用的 y
 */
function ensureSpace(doc, y, needed) {
  if (y + needed <= bottomLimit(doc)) return y;
  doc.addPage();
  return doc.page.margins.top;
}

/**
 * 把文字裁到「單行可容納寬度」（超出以 … 結尾）。
 * ⚠️ PDFKit 只要 options.width 有值就會強制換行（lineBreak:false 完全無效），
 *    表格儲存格的長文字因此會把字擠到下一列、甚至溢出到下一頁（曾使 30 筆明細變成 245 頁）。
 *    → 單行欄位一律先裁切再交給 doc.text 繪製。
 * 呼叫前請先設定好字型與字級（widthOfString 取決於當下字型）。
 */
function clipText(doc, text, maxWidth) {
  const s = String(text == null ? '' : text);
  if (!s || maxWidth <= 0) return '';
  if (doc.widthOfString(s) <= maxWidth) return s;
  const ell = '…';
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(s.slice(0, mid) + ell) <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? s.slice(0, lo) + ell : '';
}

/**
 * 表格繪製（含自動適寬 + 自動分頁）
 *   - 欄寬總和 > 可列印寬度 → 等比例縮小（不會超出紙張右緣）
 *   - 列數超過可書寫高度 → 自動換頁並重畫表頭（不會被擠出紙張外）
 * @param {PDFDocument} doc
 * @param {object} t - { x, y, colWidths, headers, rows, headerBg='#003366', rowHeight=20, fontSize=9 }
 * @returns {number} 表格結束後的 y（已是最後一頁的座標）
 */
function drawTable(doc, t) {
  const x = t.x;
  // 自動適寬：避免欄寬總和 > 可列印寬度，導致表格右緣超出紙張
  const colWidths = fitColWidths(doc, x, t.colWidths);
  const tableWidth = colWidths.reduce((a, b) => a + b, 0);
  const headerBg = t.headerBg || '#003366';
  const headerColor = '#FFFFFF';
  const rowHeight = t.rowHeight || 20;
  const fontSize = t.fontSize || 9;
  let cy = t.y;

  // 每列自帶外框與直線 → 分頁時不會留下跨頁的破框
  function gridRow(yy) {
    doc.save();
    doc.rect(x, yy, tableWidth, rowHeight).lineWidth(0.5).strokeColor('#CCCCCC').stroke();
    let lx = x;
    for (let i = 0; i < colWidths.length - 1; i++) {
      lx += colWidths[i];
      doc.moveTo(lx, yy).lineTo(lx, yy + rowHeight).lineWidth(0.3).strokeColor('#CCCCCC').stroke();
    }
    doc.restore();
  }

  function paintHeader(yy) {
    doc.save();
    doc.rect(x, yy, tableWidth, rowHeight).fill(headerBg);
    doc.fillColor(headerColor).font('zh').fontSize(fontSize);
    let cx = x;
    for (let i = 0; i < t.headers.length; i++) {
      doc.text(clipText(doc, t.headers[i], colWidths[i] - 8), cx + 4, yy + 5, { width: colWidths[i] - 8, align: t.aligns ? t.aligns[i] : 'left', ellipsis: true });
      cx += colWidths[i];
    }
    doc.restore();
    gridRow(yy);
  }

  function paintRow(row, yy, striped) {
    doc.save();
    doc.rect(x, yy, tableWidth, rowHeight).fill(striped ? '#F5F8FC' : '#FFFFFF');
    doc.restore();
    doc.fillColor('#000000').font('zh').fontSize(fontSize);
    let cx = x;
    for (let i = 0; i < row.length; i++) {
      doc.fillColor('#000000').text(clipText(doc, row[i], colWidths[i] - 8), cx + 4, yy + 5, { width: colWidths[i] - 8, align: t.aligns ? t.aligns[i] : 'left', ellipsis: true });
      cx += colWidths[i];
    }
    gridRow(yy);
  }

  // 表頭（起始位置連「表頭 + 1 列」都放不下時，先換頁再畫）
  cy = ensureSpace(doc, cy, rowHeight * 2);
  paintHeader(cy);
  cy += rowHeight;

  // 內容列（滿版自動換頁 + 重畫表頭）
  for (let r = 0; r < t.rows.length; r++) {
    if (cy + rowHeight > bottomLimit(doc)) {
      doc.addPage();
      cy = doc.page.margins.top;
      paintHeader(cy);
      cy += rowHeight;
    }
    paintRow(t.rows[r], cy, r % 2 === 1);
    cy += rowHeight;
  }

  return cy;
}

/**
 * 簽核欄（預設 業務 / 會計 / 主管 3 欄；可傳 opts 自訂欄位與顯示內容）
 *   opts = {
 *     titles: ['核決主管', '承辦人'],       // 欄位名稱
 *     values: ['林董', '王大寧'],           // 欄位內容（未簽核用「（簽名）」）
 *     dates:  ['2026-09-08', '日期：____ / ____ / ____']
 *   }
 */
function drawSignatureBox(doc, y, opts = {}) {
  const { left, right } = doc.page.margins;
  const width = doc.page.width - left - right;
  const titles = opts.titles || ['業務簽核', '會計簽核', '主管簽核'];
  const values = opts.values || titles.map(() => '（簽名）');
  const dates = opts.dates || titles.map(() => '日期：____ / ____ / ____');
  const cols = titles.length;
  const gap = cols === 2 ? 30 : 20;
  const boxWidth = (width - (cols - 1) * gap) / cols;
  const boxHeight = 60;

  doc.font('kaiu').fontSize(10).fillColor('#000000');

  for (let i = 0; i < cols; i++) {
    const x = left + i * (boxWidth + gap);
    doc.rect(x, y, boxWidth, boxHeight).lineWidth(0.5).strokeColor('#666666').stroke();
    doc.font('zh').fontSize(9).fillColor('#666666').text(titles[i] || '', x + 6, y + 4);
    const val = String(values[i] || '（簽名）');
    const valColor = val.includes('（簽名）') || val.includes('待簽核') ? '#CCCCCC' : '#000000';
    doc.font('kaiu').fontSize(13).fillColor(valColor)
      .text(clipText(doc, val, 120), x + boxWidth / 2 - 60, y + boxHeight / 2 - 8, { width: 120, align: 'center' });
    doc.fontSize(8).fillColor('#999999').text(dates[i] || '日期：____ / ____ / ____', x + 6, y + boxHeight - 14);
  }
}

/**
 * 格式化金額（原幣或本位幣）
 */
function fmtMoney(n, currency) {
  if (n == null || isNaN(n)) return '-';
  const num = Number(n);
  return currency ? `${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}` :
    num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * 格式化百分比
 */
function fmtPct(n) {
  if (n == null || isNaN(n)) return '-';
  return (Number(n) * 100).toFixed(2) + ' %';
}

export {
  createDoc,
  drawTable,
  drawSignatureBox,
  addPageFooter,
  drawQr,
  documentFingerprint,
  pdfSignSecret,
  fingerprintSecretId,
  ensureSpace,
  clipText,
  fmtMoney,
  fmtPct,
};