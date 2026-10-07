'use strict';
/**
 * 表單編輯（Form Editor）— 文件模板 + 文件實例
 * - doc_templates：內建／自訂模板（HTML + 佔位符）
 * - documents：使用者建立的文件實例（關聯系統資料快照 ref_data）
 * - 佔位符（{{公司名稱}}、{{客戶名稱}}、{{訂單單號}}…）於渲染時以系統資料替換
 * - 輸出：/api/forms/documents/:id/render 回傳可列印 HTML（公司頁首自動帶入）
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth } = require('../lib/auth');
const audit = require('../lib/audit');
const { num, str, toDateStr, nextSerial } = require('../lib/util');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();
router.use(requireAuth);

/* ================= 可插入欄位清單 ================= */
router.get('/fields', wrap(async (req, res) => {
  res.json([
    { group: '公司', fields: [
      { token: '公司名稱', label: '公司名稱' }, { token: '公司地址', label: '公司地址' }, { token: '公司電話', label: '公司電話' },
    ] },
    { group: '客戶', fields: [
      { token: '客戶名稱', label: '客戶名稱' }, { token: '客戶地址', label: '客戶地址' }, { token: '客戶電話', label: '客戶電話' },
    ] },
    { group: '訂單', fields: [
      { token: '訂單單號', label: '訂單單號' }, { token: '訂單日期', label: '訂單日期' },
      { token: '訂單客戶', label: '訂單客戶' }, { token: '訂單金額', label: '訂單金額（含稅）' },
    ] },
    { group: '出貨', fields: [
      { token: '出貨單號', label: '出貨單號' }, { token: '出貨日期', label: '出貨日期' }, { token: '出貨客戶', label: '出貨客戶' },
    ] },
    { group: '報價單', fields: [
      { token: '報價單號', label: '報價單號' }, { token: '報價日期', label: '報價日期' },
      { token: '報價有效日', label: '報價有效日期' }, { token: '報價客戶', label: '報價客戶' },
    ] },
    { group: '產品', fields: [
      { token: '產品料號', label: '產品料號' }, { token: '產品規格', label: '品名規格' },
      { token: '產品數量', label: '數量' }, { token: '產品單價', label: '單價' }, { token: '產品金額', label: '金額' },
    ] },
    { group: '其他', fields: [{ token: '今日日期', label: '今天日期' }] },
  ]);
}));

/* ================= 公司資訊（系統外觀參數） ================= */
async function companyInfo() {
  const get = async (k) => { const r = await db.prepare('SELECT value FROM parameters WHERE key=?').get(k); return r ? r.value : ''; };
  return {
    name: await get('company_name'), en: await get('company_name_en'), tax_id: await get('company_tax_id'),
    address: await get('company_address'), phone: await get('company_phone'), fax: await get('company_fax'),
  };
}

/* ================= 佔位符替換（依關聯系統資料快照） ================= */
async function resolvePlaceholders(content, refData) {
  const ref = refData || {};
  const c = await companyInfo();
  const map = {
    '公司名稱': c.name,
    '公司英文名稱': c.en,
    '公司統編': c.tax_id ? (c.tax_id.startsWith('統編') ? c.tax_id : `統編：${c.tax_id}`) : '',
    '公司地址': c.address,
    '公司電話': c.phone,
    '公司傳真': c.fax ? (c.fax.startsWith('傳真') ? c.fax : `傳真：${c.fax}`) : '',
    '今日日期': toDateStr(new Date()),
  };
  if (ref.customerId) {
    const cu = await db.prepare('SELECT * FROM customers WHERE id=?').get(ref.customerId);
    if (cu) {
      map['客戶名稱'] = cu.name || '';
      map['客戶地址'] = cu.address || '';
      map['客戶電話'] = cu.phone || '';
    }
  }
  if (ref.orderId) {
    const o = await db.prepare('SELECT * FROM orders WHERE id=?').get(ref.orderId);
    if (o) {
      const cu = o.customer_id ? await db.prepare('SELECT name FROM customers WHERE id=?').get(o.customer_id) : null;
      map['訂單單號'] = o.order_no || '';
      map['訂單日期'] = o.order_date || '';
      map['訂單客戶'] = cu ? cu.name : '';
      const tot = await db.prepare('SELECT COALESCE(SUM(total),0) t FROM order_items WHERE order_id=?').get(o.id);
      map['訂單金額'] = num(tot.t) + (o.currency && o.currency !== 'TWD' ? ` ${o.currency}` : '');
    }
  }
  if (ref.shipmentId) {
    const sh = await db.prepare('SELECT * FROM shipments WHERE id=?').get(ref.shipmentId);
    if (sh) {
      const o = sh.order_id ? await db.prepare('SELECT * FROM orders WHERE id=?').get(sh.order_id) : null;
      const cu = o && o.customer_id ? await db.prepare('SELECT name FROM customers WHERE id=?').get(o.customer_id) : null;
      map['出貨單號'] = sh.shipment_no || '';
      map['出貨日期'] = sh.ship_date || '';
      map['出貨客戶'] = cu ? cu.name : '';
    }
  }
  if (ref.quotationId) {
    const q = await db.prepare('SELECT * FROM quotations WHERE id=?').get(ref.quotationId);
    if (q) {
      const cu = q.customer_id ? await db.prepare('SELECT name FROM customers WHERE id=?').get(q.customer_id) : null;
      map['報價單號'] = q.quotation_no || '';
      map['報價日期'] = q.quotation_date || '';
      map['報價有效日'] = q.valid_until || '';
      map['報價客戶'] = cu ? cu.name : '';
    }
  }
  if (ref.productId) {
    const pr = await db.prepare('SELECT * FROM products WHERE id=?').get(ref.productId);
    if (pr) {
      map['產品料號'] = pr.part_no || '';
      map['產品規格'] = pr.spec || pr.name || '';
      map['產品數量'] = num(ref.qty, 0);
      map['產品單價'] = num(ref.unitPrice, 0);
      map['產品金額'] = num(num(ref.qty, 0) * num(ref.unitPrice, 0));
    }
  }
  return String(content || '').replace(/\{\{([^}]+)\}\}/g, (m, key) => (map[key] !== undefined ? map[key] : m));
}

/* ================= 公司頁首 HTML（所有表單一律強制帶入） ================= */
async function headerHtml() {
  const c = await companyInfo();
  const parts = [c.address, c.phone, c.fax ? `傳真：${c.fax}` : ''].filter(Boolean);
  const line2 = [c.en, c.tax_id ? `統編：${c.tax_id}` : ''].filter(Boolean).join('　');
  let h = '<div style="text-align:center;border-bottom:2px solid #333;padding-bottom:8px;margin-bottom:14px;">';
  if (c.name) h += `<div style="font-size:19px;font-weight:700;letter-spacing:2px;">${c.name}</div>`;
  if (line2) h += `<div style="font-size:11px;color:#555;margin-top:2px;">${line2}</div>`;
  if (parts.length) h += `<div style="font-size:11px;color:#555;margin-top:2px;">${parts.join('　')}</div>`;
  h += '</div>';
  return h;
}

/* ================= 模板 CRUD ================= */
router.get('/templates', wrap(async (req, res) => {
  const list = await db.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM documents d WHERE d.template_id = t.id) AS doc_count
     FROM doc_templates t ORDER BY t.doc_type, t.id`
  ).all();
  res.json(list);
}));

router.post('/templates', wrap(async (req, res) => {
  const { name, content, remark } = req.body || {};
  if (!str(name)) return res.status(400).json({ error: '模板名稱必填' });
  const code = 'TPL_' + Date.now().toString(36).toUpperCase();
  const r = await db.prepare(
    `INSERT INTO doc_templates (code, name, doc_type, company_header, content, remark, is_system)
     VALUES (?,?,'custom',1,?,?,0)`
  ).run(code, name.trim(), str(content), str(remark));
  audit.log(req.user, 'CREATE', 'doc_templates', r.lastInsertRowid, `新增模板：${name}`);
  res.json({ ok: true, id: r.lastInsertRowid });
}));

router.put('/templates/:id', wrap(async (req, res) => {
  const t = await db.prepare('SELECT * FROM doc_templates WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '模板不存在' });
  const { name, content, remark, company_header } = req.body || {};
  await db.prepare(
    `UPDATE doc_templates SET name=?, content=?, remark=?, company_header=?,
        updated_at=datetime('now','localtime') WHERE id=?`
  ).run(
    str(name) || t.name, str(content), str(remark),
    company_header === undefined ? t.company_header : (company_header ? 1 : 0),
    t.id
  );
  audit.log(req.user, 'UPDATE', 'doc_templates', t.id, `修改模板：${name || t.name}`);
  res.json({ ok: true });
}));

router.delete('/templates/:id', wrap(async (req, res) => {
  const t = await db.prepare('SELECT * FROM doc_templates WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '模板不存在' });
  if (Number(t.is_system) === 1) return res.status(400).json({ error: '內建模板不可刪除' });
  const used = await db.prepare('SELECT COUNT(*) c FROM documents WHERE template_id=?').get(t.id);
  if (used.c > 0) return res.status(400).json({ error: `此模板已有 ${used.c} 份文件，不可刪除` });
  await db.prepare('DELETE FROM doc_templates WHERE id=?').run(t.id);
  audit.log(req.user, 'DELETE', 'doc_templates', t.id, `刪除模板：${t.name}`);
  res.json({ ok: true });
}));

/* ================= 文件 CRUD ================= */
const DOC_SELECT = `SELECT d.*, t.name AS template_name, t.doc_type, t.company_header
                    FROM documents d LEFT JOIN doc_templates t ON t.id = d.template_id`;

router.get('/documents', wrap(async (req, res) => {
  const list = await db.prepare(DOC_SELECT + ' ORDER BY d.id DESC').all();
  res.json(list);
}));

router.get('/documents/:id', wrap(async (req, res) => {
  const d = await db.prepare(DOC_SELECT + ' WHERE d.id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: '文件不存在' });
  res.json(d);
}));

router.post('/documents', wrap(async (req, res) => {
  const { template_id, title, content, ref_data, remark, status } = req.body || {};
  if (!num(template_id)) return res.status(400).json({ error: '請選擇模板' });
  const t = await db.prepare('SELECT * FROM doc_templates WHERE id=?').get(template_id);
  if (!t) return res.status(404).json({ error: '模板不存在' });
  const docNo = nextSerial('doc_no_prefix', 'doc_no_seq', 'FD');
  const r = await db.prepare(
    `INSERT INTO documents (doc_no, template_id, title, content, ref_data, status, remark, created_by)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    docNo, t.id, str(title) || t.name, str(content),
    JSON.stringify(ref_data || {}), str(status) || 'draft', str(remark),
    (req.user && (req.user.emp_id || req.user.username)) || 'admin'
  );
  audit.log(req.user, 'CREATE', 'documents', r.lastInsertRowid, `建立文件：${docNo}`);
  res.json({ ok: true, id: r.lastInsertRowid, doc_no: docNo });
}));

router.put('/documents/:id', wrap(async (req, res) => {
  const d = await db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: '文件不存在' });
  const { title, content, ref_data, remark, status } = req.body || {};
  await db.prepare(
    `UPDATE documents SET title=?, content=?, ref_data=?, status=?, remark=?,
        updated_at=datetime('now','localtime') WHERE id=?`
  ).run(
    str(title) || d.title, str(content), JSON.stringify(ref_data || {}),
    str(status) || d.status, str(remark), d.id
  );
  audit.log(req.user, 'UPDATE', 'documents', d.id, `更新文件：${d.doc_no}`);
  res.json({ ok: true });
}));

router.delete('/documents/:id', wrap(async (req, res) => {
  const d = await db.prepare('SELECT * FROM documents WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: '文件不存在' });
  await db.prepare('DELETE FROM documents WHERE id=?').run(d.id);
  audit.log(req.user, 'DELETE', 'documents', d.id, `刪除文件：${d.doc_no}`);
  res.json({ ok: true });
}));

/* ================= 渲染（預覽／列印） ================= */
router.get('/documents/:id/render', wrap(async (req, res) => {
  const d = await db.prepare(DOC_SELECT + ' WHERE d.id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: '文件不存在' });
  let ref = {};
  try { ref = JSON.parse(d.ref_data || '{}'); } catch { /* ignore */ }
  const body = await resolvePlaceholders(d.content, ref);
  const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>${d.doc_no} ${d.title}</title>
<style>
  body{font-family:'Microsoft JhengHei','PingFang TC',sans-serif;margin:36px;color:#111;font-size:13px;line-height:1.7;}
  table{width:100%;border-collapse:collapse;}
  th,td{border:1px solid #666;padding:5px 8px;font-size:12.5px;}
  th{background:#f0f0f0;}
  h3{margin:4px 0 10px;}
</style>
</head>
<body>
${await headerHtml()}
${body}
<hr style="margin-top:24px;border:none;border-top:1px solid #ccc;">
<div style="font-size:10.5px;color:#888;">文件號：${d.doc_no}　建立：${d.created_by || '-'}　${d.created_at || ''}</div>
</body>
</html>`;
  res.type('html').send(html);
}));

module.exports = router;
