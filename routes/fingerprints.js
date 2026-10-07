'use strict';
/**
 * 文件指紋查驗（routes/fingerprints.js）
 *
 * 搭配 lib/pdf.js 的 documentFingerprint() 與 doc_fingerprints 表，提供：
 *   GET  /api/fingerprints/doc-types    可用文件類型清單（前端下拉單一來源）
 *   GET  /api/fingerprints/secret       目前簽章密鑰的「密鑰指紋」（前 8 碼，不洩漏密鑰）
 *   GET  /api/fingerprints/verify?q=    查驗單一指紋 / PDF SHA-256 / 單號
 *   POST /api/fingerprints/verify       同上，可帶 body { q, sha256 }（前端已算出檔案雜湊）
 *   GET  /api/fingerprints              列印紀錄清單（分頁、可篩類型與關鍵字）
 *   GET  /api/fingerprints/stats        統計摘要
 *
 * 三種查驗值語意：
 *   16 字 hex  → 文件內容指紋（頁尾印的那組）→ 命中即「本系統曾產出此單據內容」
 *   64 字 hex  → PDF 檔案本體 SHA-256（防竄改用）→ 命中即「這份檔案是原始產出、未被改過」
 *   其他       → 當單號查
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth } = require('../lib/auth');
const { fingerprintSecretId } = require('../lib/pdf');

const router = express.Router();

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const HEX16 = /^[0-9a-f]{16}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;

/** 文件類型中文名（與 routes/pdf.js 的 fingerprint type 一致） */
const DOC_LABELS = {
  order: '訂單確認單',
  shipment: '出貨單',
  quotation: '客戶報價單',
  'customer-statement': '客戶對帳單',
  supplier_quotation: '供應商報價單',
  supplier_order: '採購單',
  supplier_shipment: '進貨單',
  statement: '客戶月對帳單',
  receivables_summary: '應收帳款彙總表',
  batch_orders: '批次列印（訂單）',
  batch_shipments: '批次列印（出貨單）',
};

const labelOf = (t) => DOC_LABELS[t] || t || '-';

/** 對外輸出前加工（補中文名與短雜湊；不下傳完整敏感欄位以外的東西） */
function decorate(r, secret) {
  return {
    id: r.id,
    fp: r.fp,
    doc_type: r.doc_type,
    doc_label: labelOf(r.doc_type),
    doc_id: r.doc_id,
    doc_no: r.doc_no,
    pdf_sha256: r.pdf_sha256,
    sha_short: r.pdf_sha256 ? String(r.pdf_sha256).slice(0, 16) : null,
    pdf_bytes: r.pdf_bytes,
    pages: r.pages,
    secret_fp: r.secret_fp,
    secret_match: secret ? r.secret_fp === secret : null,
    generated_at: r.generated_at,
    generated_by: r.generated_by,
    generated_by_name: r.generated_by_name,
    source: r.source,
    created_at: r.created_at,
  };
}

// ===== 文件類型清單 =====
router.get('/doc-types', requireAuth, (req, res) => {
  res.json({ items: Object.entries(DOC_LABELS).map(([type, label]) => ({ type, label })) });
});

// ===== 目前密鑰指紋（供核對「是否同一把密鑰」） =====
router.get('/secret', requireAuth, (req, res) => {
  let id = null;
  try { id = fingerprintSecretId(); } catch { /* ignore */ }
  res.json({
    secret_id: id,
    note: '此為簽章密鑰的指紋（前 8 碼），可用來判斷一份文件是否由「目前這把密鑰」簽出；不會洩漏密鑰本身。',
  });
});

// ===== 查驗（GET query / POST body 共用） =====
function doVerify(query, sha256, res) {
  const q = String(query || sha256 || '').trim();
  if (!q) return res.status(400).json({ error: '請提供查驗值（16 碼指紋 / 64 碼 SHA-256 / 單號）' });

  let secret = null;
  try { secret = fingerprintSecretId(); } catch { /* ignore */ }

  let rows = [];
  let matchType = null;

  if (HEX64.test(q)) {
    rows = db.prepare('SELECT * FROM doc_fingerprints WHERE lower(pdf_sha256)=lower(?) ORDER BY id DESC LIMIT 50').all(q);
    matchType = 'pdf_sha256';
  }
  if (!rows.length && HEX16.test(q)) {
    rows = db.prepare('SELECT * FROM doc_fingerprints WHERE lower(fp)=lower(?) ORDER BY id DESC LIMIT 50').all(q);
    if (rows.length) matchType = 'fingerprint';
  }
  if (!rows.length) {
    rows = db.prepare('SELECT * FROM doc_fingerprints WHERE doc_no=? ORDER BY id DESC LIMIT 50').all(q);
    if (rows.length) matchType = 'doc_no';
  }

  const items = rows.map((r) => decorate(r, secret));
  const secretMismatch = items.some((r) => r.secret_match === false);

  return res.json({
    found: items.length > 0,
    query: q,
    match_type: matchType,
    count: items.length,
    current_secret_id: secret,
    any_secret_mismatch: secretMismatch,
    items,
    message: items.length
      ? (matchType === 'pdf_sha256'
        ? '此檔案雜湊與系統留存紀錄相符 → 為本系統原始產出、未被竄改。'
        : (matchType === 'fingerprint'
          ? '此指紋存在於系統列印紀錄中 → 該單據確實由本系統產出。'
          : '以此單號查到系統列印紀錄。'))
      : '查無此查驗值的列印紀錄。若您確信文件由本系統產出，請確認是否為舊版（本次改版前的）指紋，或該文件尚未在本機列印過。',
  });
}

router.get('/verify', requireAuth, (req, res) => {
  try { doVerify(req.query.q, req.query.sha256, res); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/verify', requireAuth, (req, res) => {
  try {
    const b = req.body || {};
    doVerify(b.q, b.sha256, res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 統計摘要 =====
router.get('/stats', requireAuth, wrap(async (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS c FROM doc_fingerprints').get().c;
  const byType = db.prepare('SELECT doc_type, COUNT(*) AS c FROM doc_fingerprints GROUP BY doc_type ORDER BY c DESC').all()
    .map((r) => ({ doc_type: r.doc_type, doc_label: labelOf(r.doc_type), count: r.c }));
  const bySource = db.prepare('SELECT COALESCE(source,\'single\') AS s, COUNT(*) AS c FROM doc_fingerprints GROUP BY s').all()
    .map((r) => ({ source: r.s, count: r.c }));
  const last = db.prepare('SELECT created_at FROM doc_fingerprints ORDER BY id DESC LIMIT 1').get();
  const secret = (() => { try { return fingerprintSecretId(); } catch { return null; } })();
  const withSecret = db.prepare('SELECT COUNT(DISTINCT secret_fp) AS c FROM doc_fingerprints WHERE secret_fp IS NOT NULL').get().c;
  res.json({
    total,
    by_type: byType,
    by_source: bySource,
    last_at: last ? last.created_at : null,
    current_secret_id: secret,
    distinct_secrets: withSecret,
  });
}));

// ===== 列印紀錄清單 =====
router.get('/', requireAuth, wrap(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const type = req.query.type ? String(req.query.type) : '';
  const kw = req.query.q ? String(req.query.q).trim() : '';

  const where = [];
  const args = [];
  if (type) { where.push('doc_type=?'); args.push(type); }
  if (kw) {
    where.push('(COALESCE(doc_no,\'\') LIKE ? OR fp LIKE ? OR COALESCE(pdf_sha256,\'\') LIKE ?)');
    args.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS c FROM doc_fingerprints ${w}`).get(...args).c;
  const rows = db.prepare(`SELECT * FROM doc_fingerprints ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);

  let secret = null;
  try { secret = fingerprintSecretId(); } catch { /* ignore */ }
  res.json({ total, limit, offset, items: rows.map((r) => decorate(r, secret)) });
}));

module.exports = router;
