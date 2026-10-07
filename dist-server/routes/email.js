'use strict';
/**
 * 郵件寄送路由（routes/email.js）
 *
 *   GET  /api/email/preview           取得 ethereal 測試帳號資訊
 *   POST /api/email/send-order        寄送單一訂單 PDF
 *   POST /api/email/send-shipment     寄送單一出貨 PDF
 *   POST /api/email/send-batch        批次寄送多張單據（多 PDF 附件）
 *
 * 安全：
 *   - 預設 ethereal.email 測試模式（不寄真實郵件）
 *   - 真實 SMTP 由 cfg.mail.smtp 控制，須在 config.json 設定才啟用
 *   - 所有寄送寫入 audit log
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../lib/db-dual');
const { requireAuth } = require('../lib/auth');
const { sendMail, getEtherealInfo, getMailConfig } = require('../lib/mailer');
const { log: writeAudit } = require('../lib/audit');
const { loadOrder, loadShipment, renderOrderToBuffer, renderShipmentToBuffer } = require('./pdf-helpers');
const { loadQuote, drawQuoteToDoc, loadSupplierQuote, drawSupplierQuoteToDoc, loadSupplierOrder, drawSupplierOrderToDoc, loadStatement, drawStatementToDoc, verifyUrlFor, finishDoc } = require('./pdf');
const { createDoc, addPageFooter } = require('../lib/pdf');

// 暫存目錄（額外附件上傳）：落在 <app>/data/email-tmp（與 DB 同層）
const APP_ROOT = path.join(__dirname, '..', '..');
const EMAIL_TMP_DIR = path.join(APP_ROOT, 'data', 'email-tmp');
if (!fs.existsSync(EMAIL_TMP_DIR)) fs.mkdirSync(EMAIL_TMP_DIR, { recursive: true });

// 額外附件上傳（批次寄信用）：5MB、常見格式
const ALLOWED_EXT = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.jpg', '.jpeg', '.png', '.zip', '.txt', '.csv'];
const uploadExtra = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, EMAIL_TMP_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.includes(ext)) cb(null, true);
    else cb(new Error('不支援的附件格式（允許：' + ALLOWED_EXT.join(' ') + '）'), false);
  },
});

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** 解析逗號/分號/空白分隔的 Email 清單 */
function parseEmails(raw) {
  if (!raw) return [];
  return String(raw).split(/[,;，；\s]+/).map((s) => s.trim()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}
function getParam(key, def) {
  try { const r = db.prepare('SELECT value FROM parameters WHERE key=?').get(key); return r ? r.value : def; } catch { return def; }
}
/** 公司名片資料（名稱 / 地址 / 網址） */
function getCompanyCard() {
  return {
    name: getParam('company_name', ''),
    address: getParam('company_address', ''),
    website: getParam('company_website', ''),
  };
}
/** 取得客戶聯絡人 Email 與歸屬業務姓名 */
function getCustomerContact(customerId) {
  if (!customerId) return { email: '', salesName: '' };
  try {
    const c = db.prepare('SELECT email, owner_id FROM customers WHERE id=?').get(customerId);
    if (!c) return { email: '', salesName: '' };
    let salesName = '';
    if (c.owner_id) {
      const u = db.prepare('SELECT name FROM users WHERE id=?').get(c.owner_id);
      if (u) salesName = u.name;
    }
    return { email: c.email || '', salesName };
  } catch { return { email: '', salesName: '' }; }
}
/** 組「公司名片」HTML（等寬朴素區塊，TXT 風格） */
function buildCardHtml(company, salesName) {
  const lines = [];
  if (company.name) lines.push(company.name);
  if (company.address) lines.push('地址：' + company.address);
  if (company.website) lines.push('網址：' + company.website);
  if (salesName) lines.push('負責業務：' + salesName);
  if (lines.length === 0) return '';
  return '<pre style="font-family:Menlo,Consolas,monospace;font-size:12px;line-height:1.5;color:#333;background:#f7f7f7;padding:10px 12px;border-left:3px solid #2d5a87;white-space:pre-wrap;margin:14px 0 0">' + escapeHtml(lines.join('\n')) + '</pre>';
}
/** 依類型載入單據並轉為 PDF Buffer，同時回傳客戶 id 與標籤 */
async function renderDoc(it) {
  if (it.type === 'order') {
    const o = await loadOrder(it.id); if (!o) return null;
    const { buf } = await renderOrderToBuffer(o);
    return { buf, customerId: o.customer_id, filename: `order-${o.order_no || o.id}.pdf`, label: `訂單 ${o.order_no || o.id}` };
  }
  if (it.type === 'shipment') {
    const sh = await loadShipment(it.id); if (!sh) return null;
    const { buf } = await renderShipmentToBuffer(sh);
    // 出貨單的客戶 id 來自關聯訂單
    let cid = sh.customer_id;
    if (!cid && sh.order_id) { try { const o = db.prepare('SELECT customer_id FROM orders WHERE id=?').get(sh.order_id); cid = o ? o.customer_id : null; } catch {} }
    return { buf, customerId: cid, filename: `shipment-${sh.shipment_no || sh.id}.pdf`, label: `出貨單 ${sh.shipment_no || sh.id}` };
  }
  if (it.type === 'quote') {
    const q = await loadQuote(it.id); if (!q) return null;
    const { buf } = await renderQuoteToBuffer(q);
    return { buf, customerId: q.customer_id, filename: `quotation-${q.quotation_no || q.id}.pdf`, label: `報價單 ${q.quotation_no || q.id}` };
  }
  if (it.type === 'statement') {
    const st = await loadStatement(it.id); if (!st) return null;
    const { buf } = await renderStatementToBuffer(st);
    return { buf, customerId: st.customer_id, filename: `statement-${st.statement_no || st.id}.pdf`, label: `對帳單 ${st.statement_no || st.id}` };
  }
  if (it.type === 'supplier-quote') {
    const sq = await loadSupplierQuote(it.id); if (!sq) return null;
    const { buf } = await renderSupplierQuoteToBuffer(sq);
    return { buf, customerId: null, filename: `supplier-quote-${sq.quote_no || sq.id}.pdf`, label: `供應商報價單 ${sq.quote_no || sq.id}` };
  }
  if (it.type === 'supplier-order') {
    const so = await loadSupplierOrder(it.id); if (!so) return null;
    const { buf } = await renderSupplierOrderToBuffer(so);
    return { buf, customerId: null, filename: `supplier-order-${so.order_no || so.id}.pdf`, label: `採購單 ${so.order_no || so.id}` };
  }
  return null;
}

const router = express.Router();

/** 渲染報價單為 PDF Buffer（給 email 附件用） */
function renderQuoteToBuffer(q) {
  const doc = createDoc({ title: '報 價 單' });
  const fp = drawQuoteToDoc(doc, q);
  addPageFooter(doc, undefined, fp, verifyUrlFor(null, fp));
  return finishDoc(doc, { fp, doc_type: 'quotation', doc_id: q.id, doc_no: q.quotation_no });
}

/** 渲染供應商報價單為 PDF Buffer */
function renderSupplierQuoteToBuffer(q) {
  const doc = createDoc({ title: '供 應 商 報 價 單' });
  const fp = drawSupplierQuoteToDoc(doc, q);
  addPageFooter(doc, undefined, fp, verifyUrlFor(null, fp));
  return finishDoc(doc, { fp, doc_type: 'supplier_quotation', doc_id: q.id, doc_no: q.quote_no });
}

/** 渲染對帳單為 PDF Buffer */
function renderStatementToBuffer(st) {
  const param = (k) => { try { const r = db.prepare('SELECT value FROM parameters WHERE key=?').get(k); return r ? r.value : ''; } catch { return ''; } };
  const company = { name: param('company_name'), address: param('company_address'), phone: param('company_phone'), fax: param('company_fax') };
  const doc = createDoc({ title: '', watermark: false });
  doc.rect(0, 0, doc.page.width, 100).fillColor('#ffffff').fill();
  const fp = drawStatementToDoc(doc, st, company);
  addPageFooter(doc, undefined, fp, verifyUrlFor(null, fp));
  return finishDoc(doc, { fp, doc_type: 'customer-statement', doc_id: st.id, doc_no: st.statement_no });
}

/** 渲染供應商訂單（採購單）為 PDF Buffer */
function renderSupplierOrderToBuffer(o) {
  const doc = createDoc({ title: '採 購 單' });
  const fp = drawSupplierOrderToDoc(doc, o);
  addPageFooter(doc, undefined, fp, verifyUrlFor(null, fp));
  return finishDoc(doc, { fp, doc_type: 'supplier_order', doc_id: o.id, doc_no: o.order_no });
}

// ========== 取得目前的郵件模式 / 測試帳號（給前端顯示） ==========
// 【2026-09-10 健檢修正 P2-1】
//   原缺陷：這裡只看 config.json 的 cfg.mail.smtp，但真正的設定來源優先順序是
//           「DB parameters（UI 設定）> config.json > ethereal」（見 lib/mailer.js getMailConfig）。
//           本系統已在 UI 設妥 SMTP（mail.fuhuang.com.tw），config.json 的 mail.smtp 卻是 null，
//           於是走進 ethereal 分支 → getEtherealInfo() 回傳 null → 500。
//   修正：  統一改用 getMailConfig()（DB 優先），並對 null 做優雅降級（200 + mode:'none'）。
router.get('/preview', requireAuth, async (req, res) => {
  try {
    const mailCfg = getMailConfig();
    if (mailCfg.mode === 'smtp' && mailCfg.host) {
      // 只回傳非機敏欄位（不洩漏 smtp 密碼）
      return res.json({
        mode: 'smtp',
        source: mailCfg.source,
        host: mailCfg.host,
        port: mailCfg.port,
        secure: mailCfg.secure,
        user: mailCfg.user,
        from: mailCfg.from,
        smtp_pass_set: !!mailCfg.smtp_pass_set,
      });
    }
    const acct = await getEtherealInfo();
    if (!acct) {
      return res.json({ mode: 'none', message: '尚未設定 SMTP，且無法建立測試帳號（可能無外部網路）' });
    }
    res.json({ mode: 'ethereal', user: acct.user, smtp: acct.smtp, web: acct.web });
  } catch (e) {
    res.status(500).json({ error: '取得郵件設定失敗：' + e.message });
  }
});

// ========== 寄送單一訂單 ==========
router.post('/send-order', requireAuth, async (req, res) => {
  const { orderId, to, subject, html } = req.body || {};
  if (!orderId || !to) return res.status(400).json({ error: 'orderId 與 to 必填' });

  const order = await loadOrder(orderId);
  if (!order) return res.status(404).json({ error: '訂單不存在' });

  try {
    const { buf } = await renderOrderToBuffer(order);
    const result = await sendMail({
      to,
      subject: subject || `訂單確認單 ${order.order_no || '#' + order.id}`,
      html: html || `<p>${order.customer_name} 您好，</p><p>附件為您的訂單確認單（${order.order_no || '#' + order.id}），請查收。</p>`,
      attachments: [{ filename: `order-${order.order_no || order.id}.pdf`, content: buf }],
    });
    writeAudit(req, 'email.send', 'order', orderId, { to, messageId: result.messageId });
    res.json({ ok: true, ...result });
  } catch (e) {
    writeAudit(req, 'email.send_failed', 'order', orderId, { to, error: e.message });
    res.status(500).json({ error: '寄送失敗：' + e.message });
  }
});

// ========== 寄送單一出貨 ==========
router.post('/send-shipment', requireAuth, async (req, res) => {
  const { shipmentId, to, subject, html } = req.body || {};
  if (!shipmentId || !to) return res.status(400).json({ error: 'shipmentId 與 to 必填' });

  const sh = await loadShipment(shipmentId);
  if (!sh) return res.status(404).json({ error: '出貨單不存在' });

  try {
    const { buf } = await renderShipmentToBuffer(sh);
    const result = await sendMail({
      to,
      subject: subject || `出貨單 ${sh.shipment_no || '#' + sh.id}`,
      html: html || `<p>${sh.customer_name} 您好，</p><p>附件為出貨單（${sh.shipment_no || '#' + sh.id}），請查收。</p>`,
      attachments: [{ filename: `shipment-${sh.shipment_no || sh.id}.pdf`, content: buf }],
    });
    writeAudit(req, 'email.send', 'shipment', shipmentId, { to, messageId: result.messageId });
    res.json({ ok: true, ...result });
  } catch (e) {
    writeAudit(req, 'email.send_failed', 'shipment', shipmentId, { to, error: e.message });
    res.status(500).json({ error: '寄送失敗：' + e.message });
  }
});

// ========== 批次寄送（依客戶分組，每客戶各寄一封，自動帶入該客戶名片） ==========
// 請求：{ items:[{type,id}], to?(額外收件者), subject?, html?(可編輯本文), bcc?, extraAttachments?:[{id,filename,contentType}] }
router.post('/send-batch', requireAuth, async (req, res) => {
  const { items, to, subject, html, bcc, extraAttachments } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items 必須是非空陣列' });
  if (items.length > 50) return res.status(400).json({ error: '單次批次最多 50 個項目' });

  const extraTo = parseEmails(to);
  const bccList = parseEmails(bcc);

  // 額外附件：從暫存讀取後併入每封郵件，並清理暫存檔
  const extraAtts = [];
  if (Array.isArray(extraAttachments)) {
    for (const a of extraAttachments) {
      if (!a || !a.id) continue;
      const p = path.join(EMAIL_TMP_DIR, a.id);
      if (fs.existsSync(p)) {
        try {
          extraAtts.push({ filename: a.filename || 'attachment', content: fs.readFileSync(p), contentType: a.contentType || 'application/octet-stream' });
        } finally { try { fs.unlinkSync(p); } catch {} }
      }
    }
  }

  // 依客戶分組（無客戶者歸入 'none' 群組）
  const groups = new Map();
  for (const it of items) {
    const doc = await renderDoc(it);
    if (!doc) continue;
    const key = doc.customerId ? ('c' + doc.customerId) : 'none';
    if (!groups.has(key)) groups.set(key, { customerId: doc.customerId, attachments: [], summary: [] });
    groups.get(key).attachments.push({ filename: doc.filename, content: doc.buf });
    groups.get(key).summary.push(doc.label);
  }

  if (groups.size === 0) return res.status(404).json({ error: '所有 id 都查無資料' });

  const company = getCompanyCard();
  const sent = [];
  const skipped = [];

  for (const [, g] of groups) {
    // 收件者：該客戶聯絡人 Email + 額外收件者
    let recipients = [];
    let salesName = '';
    if (g.customerId) {
      const contact = getCustomerContact(g.customerId);
      if (contact.email) recipients.push(contact.email);
      salesName = contact.salesName;
    }
    recipients = recipients.concat(extraTo);
    if (recipients.length === 0) { skipped.push(g.summary.join('、') + '（無收件者）'); continue; }

    const cardHtml = buildCardHtml(company, salesName);
    const bodyHtml = (html || '') + cardHtml; // sendMail 會再加頁尾

    try {
      const result = await sendMail({
        to: recipients,
        bcc: bccList.length ? bccList : undefined,
        subject: subject || `單據通知（${g.summary.length} 份）`,
        html: bodyHtml,
        attachments: g.attachments.concat(extraAtts),
      });
      sent.push({ to: recipients, count: g.attachments.length, messageId: result.messageId, previewUrl: result.previewUrl, isEthereal: result.isEthereal });
      writeAudit(req, 'email.send', 'batch', g.attachments.length, { to: recipients, bcc: bccList, summary: g.summary, messageId: result.messageId });
    } catch (e) {
      skipped.push(g.summary.join('、') + '（寄送失敗：' + e.message + '）');
    }
  }

  res.json({ ok: true, sent: sent.length, count: sent.reduce((s, x) => s + x.count, 0), skipped, details: sent });
});

// ========== 額外附件上傳（批次寄信用，5MB，回傳暫存 id） ==========
router.post('/upload', requireAuth, uploadExtra.array('files', 10), (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: '未收到檔案' });
    const list = req.files.map((f) => ({
      id: path.basename(f.path),
      filename: f.originalname,
      size: f.size,
      contentType: f.mimetype,
    }));
    res.json({ ok: true, files: list });
  } catch (e) {
    res.status(500).json({ error: '上傳失敗：' + e.message });
  }
});

module.exports = router;