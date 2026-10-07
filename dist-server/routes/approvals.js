'use strict';
/**
 * 電子簽核引擎（2026-09-11 擴充）
 *   - 流程設定：approval_flows + approval_flow_steps（多層核決、每層可多選核決人）
 *   - 動作：submit（發起簽核）／approve（核准）／reject（駁回）／return（退回）
 *   - 狀態機：none → pending（待簽核）→ approved（已核決）／rejected（已否決）／returned（待修改）
 *             returned 可由原送核人重新 submit（回到 pending）
 *   - 稽核：approval_logs 逐筆記錄送核人／核決人／時間／意見
 *
 * 支援 docType：
 *   - supplier-order：供應商訂單（主表 supplier_orders，明細 supplier_order_items）
 *   - shipment：出貨單（主表 shipments，明細從 order_items 帶，客戶從 customers）
 *   - quote：客戶報價單（主表 quotations，明細 quotation_items，客戶從 customers）
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireManager } = require('../lib/auth');
const audit = require('../lib/audit');
const { str } = require('../lib/util');

const router = express.Router();
router.use(requireAuth);

const DOC_LABELS = {
  'supplier-order': { table: 'supplier_orders', noCol: 'order_no',     label: '供應商訂單', alias: 'o',  dateCol: 'order_date',     party: '供應商' },
  'shipment':       { table: 'shipments',       noCol: 'shipment_no',  label: '出貨單',     alias: 'sh', dateCol: 'ship_date',      party: '客戶' },
  'quote':          { table: 'quotations',      noCol: 'quotation_no', label: '客戶報價單', alias: 'q',  dateCol: 'quotation_date', party: '客戶' },
};

/** 取 docType 在 SQL 中的資料表別名（listDocs 的 whereSql 需用同一別名） */
function aliasOf(docType) {
  const meta = DOC_LABELS[docType];
  return meta ? meta.alias : 'x';
}

/**
 * 簽核通過後，把「業務狀態」同步推進為已生效（2026-09-24 修正）。
 *
 * 背景：單據有兩個獨立欄位——
 *   - status          ：業務狀態（列表「狀態」欄，如 草稿/已報價/已失效/作廢）
 *   - approval_status ：簽核狀態（列表「簽核狀況」欄，none/pending/approved/rejected/returned）
 * 以往核准只寫 approval_status，單子簽完仍停在「草稿」，故補上回寫。
 *
 * 僅對語意相符者啟用：
 *   - quote：confirmed = 已報價，簽核通過即報價生效 → draft 升 confirmed。
 *   - supplier-order：其 confirmed 屬「收貨進度」狀態機（draft/confirmed/partial/received），
 *     由收貨作業推進，不可被簽核覆蓋。
 *   - shipment：資料表無 status 欄位，不適用。
 * 條件式 UPDATE（僅當目前值仍為 from）確保冪等，且不覆蓋 expired/cancelled 等已推進狀態。
 */
const APPROVED_STATUS_SYNC = {
  'quote': { col: 'status', from: 'draft', to: 'confirmed' },
};

function syncApprovedBusinessStatus(docType, meta, docId) {
  const rule = APPROVED_STATUS_SYNC[docType];
  if (!rule) return;
  db.prepare(
    `UPDATE ${meta.table} SET ${rule.col}=?, updated_at=datetime('now','localtime') WHERE id=? AND ${rule.col}=?`
  ).run(rule.to, docId, rule.from);
}

/* ================= 內部工具 ================= */

function getFlow(docType) {
  const flow = db.prepare('SELECT * FROM approval_flows WHERE doc_type=? AND active=1').get(docType);
  if (!flow) return null;
  const steps = db.prepare('SELECT * FROM approval_flow_steps WHERE flow_id=? ORDER BY step_no').all(flow.id);
  return { ...flow, steps };
}

function parseIds(s) {
  return String(s || '').split(',').map((x) => Number(x.trim())).filter((x) => x > 0);
}

function getDoc(docType, id) {
  const meta = DOC_LABELS[docType];
  if (!meta) return null;
  return db.prepare(`SELECT * FROM ${meta.table} WHERE id=?`).get(Number(id));
}

function approvedActors(docType, docId, stepNo) {
  return db.prepare(
    "SELECT DISTINCT actor_id FROM approval_logs WHERE doc_type=? AND doc_id=? AND step_no=? AND action='approve' AND actor_id IS NOT NULL"
  ).all(docType, docId, stepNo).map((r) => r.actor_id);
}

function currentStepOf(doc, flow) {
  if (!flow || !flow.steps.length) return null;
  const no = doc.current_step || flow.steps[0].step_no;
  return flow.steps.find((s) => s.step_no === no) || flow.steps[0];
}

function getFlowMeta(docType) { return DOC_LABELS[docType]; }

function log(docType, doc, stepNo, stepName, action, statusLabel, actor, comment, opt) {
  const o = opt || {};
  const now = o.now || new Date().toISOString().slice(0, 19).replace('T', ' ');
  const notAt = o.notifiedAt !== undefined ? o.notifiedAt : now;
  const finAt = o.finishedAt === undefined ? null : o.finishedAt;
  const meta = getFlowMeta(docType);
  db.prepare(
    `INSERT INTO approval_logs
       (doc_type, doc_id, doc_no, step_no, step_name, action, status_label,
        actor_id, actor_name, delegate_name, comment, notified_at, finished_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    docType, doc.id, doc[meta.noCol] || '',
    stepNo, stepName || '', action, statusLabel || '',
    actor ? actor.id : null, actor ? actor.name : null,
    o.delegate || null, str(comment), notAt, finAt
  );
}

function pendingRowOf(docType, docId, stepNo) {
  return db.prepare(
    "SELECT * FROM approval_logs WHERE doc_type=? AND doc_id=? AND step_no=? AND action='pending' ORDER BY id DESC LIMIT 1"
  ).get(docType, docId, stepNo);
}

function closePendingRow(docType, docId, stepNo, actor, statusLabel, comment, delegate, finAt) {
  const row = pendingRowOf(docType, docId, stepNo);
  if (row) {
    db.prepare(
      `UPDATE approval_logs SET actor_id=?, actor_name=?, delegate_name=?, comment=?, status_label=?, finished_at=? WHERE id=?`
    ).run(actor.id, actor.name, delegate || null, str(comment), statusLabel, finAt, row.id);
  }
}

function attachLogs(row, docType) {
  row.logs = db.prepare('SELECT * FROM approval_logs WHERE doc_type=? AND doc_id=? ORDER BY id').all(docType, row.id);
  return row;
}

/** 依 docType 補充單據詳情（客戶/供應商、明細、送核人） */
function withDoc(docType, row) {
  if (!row) return null;
  const meta = getFlowMeta(docType);
  const flow = getFlow(docType);
  const step = flow && flow.steps.length ? (currentStepOf(row, flow) || null) : null;
  const r = { ...row };
  r.doc_label = meta.label;
  r.doc_no = row[meta.noCol];
  r.doc_date = meta.dateCol ? row[meta.dateCol] : null;   // 通用日期欄（前端清單/檢視共用）
  r.party_label = meta.party || '對象';                   // 對象欄標題（供應商／客戶）
  r.doc_type = docType;

  if (docType === 'supplier-order') {
    const sup = db.prepare('SELECT name, code FROM suppliers WHERE id=?').get(row.supplier_id);
    if (sup) { r.party_name = sup.name; r.party_code = sup.code; }
    const itemSum = db.prepare('SELECT COALESCE(SUM(total),0) AS total FROM supplier_order_items WHERE order_id=?').get(row.id);
    r.amount_total = itemSum ? itemSum.total : 0;
    r.items = db.prepare(
      'SELECT part_no, description, qty, unit, unit_price, amount, total FROM supplier_order_items WHERE order_id=? ORDER BY sort_order, id'
    ).all(row.id);
  } else if (docType === 'shipment') {
    const o = db.prepare('SELECT order_no, customer_id FROM orders WHERE id=?').get(row.order_id);
    if (o) {
      r.order_no = o.order_no;
      const c = db.prepare('SELECT name, customer_no FROM customers WHERE id=?').get(o.customer_id);
      if (c) { r.party_name = c.name; r.party_code = c.customer_no; }
    }
    const itemSum = db.prepare('SELECT COALESCE(SUM(total),0) AS total FROM order_items WHERE order_id=?').get(row.order_id);
    r.amount_total = itemSum ? itemSum.total : 0;
    r.items = db.prepare(
      'SELECT part_no AS part_no, part_no AS description, qty, unit, unit_price, amount, total FROM order_items WHERE order_id=? ORDER BY sort_order, id'
    ).all(row.order_id);
  } else if (docType === 'quote') {
    const c = db.prepare('SELECT name, customer_no FROM customers WHERE id=?').get(row.customer_id);
    if (c) { r.party_name = c.name; r.party_code = c.customer_no; }
    const itemSum = db.prepare('SELECT COALESCE(SUM(total),0) AS total FROM quotation_items WHERE quotation_id=?').get(row.id);
    r.amount_total = itemSum ? itemSum.total : 0;
    r.items = db.prepare(
      'SELECT part_no, description, qty, unit, unit_price, amount, total FROM quotation_items WHERE quotation_id=? ORDER BY sort_order, id'
    ).all(row.id);
  }

  const sub = row.submitter_id ? db.prepare('SELECT name, emp_id FROM users WHERE id=?').get(row.submitter_id) : null;
  if (sub) { r.submitter_name = sub.name; r.submitter_emp = sub.emp_id; }

  r.approval_flow = flow ? { id: flow.id, name: flow.name, steps: flow.steps } : null;
  r.approval_step = step ? { step_no: step.step_no, step_name: step.step_name, approver_ids: parseIds(step.approver_ids) } : null;
  const ids = [...new Set((flow ? flow.steps : []).flatMap((s) => parseIds(s.approver_ids)))];
  if (ids.length) {
    const us = db.prepare(`SELECT id, name, emp_id, role FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    r._userNames = Object.fromEntries(us.map((u) => [u.id, `${u.name}（${u.emp_id}）`]));
  }
  return attachLogs(r, docType);
}

/** 通用列表：依 docType 查主表，補 party_name / submitter_name */
function listDocs(docType, whereSql, args) {
  const meta = DOC_LABELS[docType];
  let sql;
  if (docType === 'supplier-order') {
    sql = `SELECT o.*, s.name AS party_name, s.code AS party_code, u.name AS submitter_name,
             o.order_date AS doc_date,
             (SELECT COALESCE(SUM(total),0) FROM supplier_order_items oi WHERE oi.order_id=o.id) AS amount_total
           FROM supplier_orders o
           LEFT JOIN suppliers s ON s.id=o.supplier_id
           LEFT JOIN users u ON u.id=o.submitter_id
           ${whereSql}`;
  } else if (docType === 'shipment') {
    sql = `SELECT sh.*, c.name AS party_name, c.customer_no AS party_code, u.name AS submitter_name,
             sh.ship_date AS doc_date,
             (SELECT COALESCE(SUM(oi.total),0) FROM order_items oi WHERE oi.order_id=sh.order_id) AS amount_total
           FROM shipments sh
           LEFT JOIN orders o ON o.id=sh.order_id
           LEFT JOIN customers c ON c.id=o.customer_id
           LEFT JOIN users u ON u.id=sh.submitter_id
           ${whereSql}`;
  } else if (docType === 'quote') {
    sql = `SELECT q.*, c.name AS party_name, c.customer_no AS party_code, u.name AS submitter_name,
             q.quotation_date AS doc_date,
             (SELECT COALESCE(SUM(qi.total),0) FROM quotation_items qi WHERE qi.quotation_id=q.id) AS amount_total
           FROM quotations q
           LEFT JOIN customers c ON c.id=q.customer_id
           LEFT JOIN users u ON u.id=q.submitter_id
           ${whereSql}`;
  } else {
    return [];
  }
  const rows = db.prepare(sql).all(...args);
  return rows.map((r) => ({ ...r, doc_type: docType, doc_no: r[meta.noCol] }));
}

/* ================= 流程設定（電子簽核頁） ================= */

/**
 * 可用文件類型清單（前端「新增流程」下拉的唯一來源）
 *   used = 是否已有流程 → 前端可只列出「尚未設定」的類型，避免選到會被打回的重複項
 *   ⚠️ 前端不得再自行維護一份清單（曾因此導致檢視/核准打錯 docType）
 */
router.get('/doc-types', (req, res) => {
  const used = new Set(db.prepare('SELECT doc_type FROM approval_flows').all().map((r) => r.doc_type));
  res.json(Object.keys(DOC_LABELS).map((value) => ({
    value,
    label: DOC_LABELS[value].label,
    used: used.has(value),
  })));
});

router.get('/flows', (req, res) => {
  const flows = db.prepare('SELECT * FROM approval_flows ORDER BY id').all();
  const steps = db.prepare('SELECT * FROM approval_flow_steps ORDER BY flow_id, step_no').all();
  const users = db.prepare("SELECT id, emp_id, name, role FROM users WHERE active=1 ORDER BY role DESC, emp_id").all();
  res.json(flows.map((f) => ({ ...f, steps: steps.filter((s) => s.flow_id === f.id), users })));
});

router.post('/flows', requireManager, async (req, res, next) => {
  try {
    const b = req.body || {};
    const docType = str(b.doc_type);
    const name = str(b.name);
    if (!docType || !name) return res.status(400).json({ error: '請填寫文件類型與流程名稱' });
    if (!DOC_LABELS[docType]) return res.status(400).json({ error: `目前尚不支援文件類型：${docType}` });
    if (db.prepare('SELECT id FROM approval_flows WHERE doc_type=?').get(docType)) {
      return res.status(400).json({ error: `「${DOC_LABELS[docType].label}」已有簽核流程` });
    }
    const steps = Array.isArray(b.steps) ? b.steps : [];
    const tx = await db.transaction(async () => {
      const info = db.prepare('INSERT INTO approval_flows (doc_type, name, active) VALUES (?,?,?)')
        .run(docType, name, b.active === undefined ? 1 : (b.active ? 1 : 0));
      const flowId = info.lastInsertRowid;
      const st = db.prepare('INSERT INTO approval_flow_steps (flow_id, step_no, step_name, approver_ids) VALUES (?,?,?,?)');
      steps.forEach((s, i) => st.run(flowId, i + 1, str(s.step_name, `第 ${i + 1} 層`), Array.isArray(s.approver_ids) ? s.approver_ids.join(',') : str(s.approver_ids)));
      return flowId;
    })();
    audit.log(req, 'approval_flow_create', `建立簽核流程 ${name}（${docType}）`);
    res.status(201).json(db.prepare('SELECT * FROM approval_flows WHERE id=?').get(tx));
  } catch (e) { next(e); }
});

router.put('/flows/:id', requireManager, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM approval_flows WHERE id=?').get(id);
    if (!cur) return res.status(404).json({ error: '簽核流程不存在' });
    const b = req.body || {};
    await db.transaction(async () => {
      db.prepare('UPDATE approval_flows SET name=?, active=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?')
        .run(str(b.name, cur.name), b.active === undefined ? cur.active : (b.active ? 1 : 0), id);
      db.prepare('DELETE FROM approval_flow_steps WHERE flow_id=?').run(id);
      const steps = Array.isArray(b.steps) ? b.steps : [];
      const st = db.prepare('INSERT INTO approval_flow_steps (flow_id, step_no, step_name, approver_ids) VALUES (?,?,?,?)');
      steps.forEach((s, i) => st.run(id, i + 1, str(s.step_name, `第 ${i + 1} 層`), Array.isArray(s.approver_ids) ? s.approver_ids.join(',') : str(s.approver_ids)));
    })();
    audit.log(req, 'approval_flow_update', `更新簽核流程 ${cur.name}`);
    res.json(db.prepare('SELECT * FROM approval_flows WHERE id=?').get(id));
  } catch (e) { next(e); }
});

router.delete('/flows/:id', requireManager, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const cur = db.prepare('SELECT * FROM approval_flows WHERE id=?').get(id);
    if (!cur) return res.status(404).json({ error: '簽核流程不存在' });
    await db.transaction(async () => {
      db.prepare('DELETE FROM approval_flow_steps WHERE flow_id=?').run(id);
      db.prepare('DELETE FROM approval_flows WHERE id=?').run(id);
    })();
    audit.log(req, 'approval_flow_delete', `刪除簽核流程 ${cur.name}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ================= 三列表（合併所有支援 docType） ================= */

const ALL_DOC_TYPES = Object.keys(DOC_LABELS);

/** 收集某狀態下、我有權看的文件 */
function collect(statusEq, my, filterMine) {
  const out = [];
  for (const dt of ALL_DOC_TYPES) {
    const flow = getFlow(dt);
    if (!flow) continue;
    const steps = flow.steps;
    const rows = listDocs(dt, `WHERE ${aliasOf(dt)}.approval_status ${statusEq[0]} ${statusEq[1]}`, statusEq[2] || []);
    for (const r of rows) {
      if (filterMine && !filterMine(dt, r, my, steps)) continue;
      out.push(withDoc(dt, r));
    }
  }
  return out;
}

router.get('/pending', (req, res) => {
  const my = req.user.id;
  const out = [];
  for (const dt of ALL_DOC_TYPES) {
    const flow = getFlow(dt);
    if (!flow) continue;
    const alias = aliasOf(dt);
    const rows = listDocs(dt, `WHERE ${alias}.approval_status='pending'`, []);
    for (const r of rows) {
      const step = flow.steps.find((s) => s.step_no === (r.current_step || flow.steps[0].step_no));
      if (!step) continue;
      const ids = parseIds(step.approver_ids);
      if (!ids.includes(my)) continue;
      if (approvedActors(dt, r.id, step.step_no).includes(my)) continue;
      out.push(withDoc(dt, r));
    }
  }
  res.json(out);
});

router.get('/done', (req, res) => {
  const my = req.user.id;
  const out = [];
  for (const dt of ALL_DOC_TYPES) {
    const flow = getFlow(dt);
    if (!flow) continue;
    const alias = aliasOf(dt);
    const rows = listDocs(dt, `WHERE ${alias}.approval_status IN ('approved','rejected')`, []);
    for (const r of rows) {
      if (r.submitter_id === my) { out.push(withDoc(dt, r)); continue; }
      const acted = db.prepare(
        "SELECT COUNT(*) AS c FROM approval_logs WHERE doc_type=? AND doc_id=? AND actor_id=? AND action IN ('approve','reject','return')"
      ).get(dt, r.id, my);
      if (acted.c > 0) out.push(withDoc(dt, r));
    }
  }
  res.json(out);
});

router.get('/returned', (req, res) => {
  const out = [];
  for (const dt of ALL_DOC_TYPES) {
    const flow = getFlow(dt);
    if (!flow) continue;
    const alias = aliasOf(dt);
    const rows = listDocs(dt, `WHERE ${alias}.approval_status='returned' AND ${alias}.submitter_id=?`, [req.user.id]);
    rows.forEach((r) => out.push(withDoc(dt, r)));
  }
  res.json(out);
});

/* ================= 簽核動作 ================= */

router.get('/doc/:docType/:id/log', (req, res) => {
  const doc = getDoc(req.params.docType, Number(req.params.id));
  if (!doc) return res.status(404).json({ error: '文件不存在' });
  res.json(db.prepare('SELECT * FROM approval_logs WHERE doc_type=? AND doc_id=? ORDER BY id').all(req.params.docType, doc.id));
});

router.get('/doc/:docType/:id', (req, res) => {
  const doc = getDoc(req.params.docType, Number(req.params.id));
  if (!doc) return res.status(404).json({ error: '文件不存在' });
  res.json(withDoc(req.params.docType, doc));
});

router.post('/doc/:docType/:id/submit', async (req, res, next) => {
  try {
    const { docType } = req.params;
    const doc = getDoc(docType, Number(req.params.id));
    if (!doc) return res.status(404).json({ error: '文件不存在' });
    if (!DOC_LABELS[docType]) return res.status(400).json({ error: `尚不支援文件類型：${docType}` });
    const flow = getFlow(docType);
    if (!flow || !flow.steps.length) return res.status(400).json({ error: '尚未設定簽核流程，請先到「電子簽核」設定' });

    const canSubmit = doc.approval_status === 'none' ||
      (doc.approval_status === 'returned' && doc.submitter_id === req.user.id);
    if (!canSubmit) {
      return res.status(400).json({ error: `目前狀態（${doc.approval_status}）不可發起簽核` });
    }

    const meta = getFlowMeta(docType);
    await db.transaction(async () => {
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      db.prepare(
        `UPDATE ${meta.table} SET approval_status='pending', current_step=?, submitter_id=?, submitted_at=datetime('now','localtime'), acted_at=NULL WHERE id=?`
      ).run(flow.steps[0].step_no, req.user.id, doc.id);
      log(docType, doc, 0, '流程啟動', 'submit', '新增核單中', req.user,
        `送審人「${req.user.name}」，製單人「${req.user.name}」，流程啟動人「${req.user.name}」`,
        { notifiedAt: now, finishedAt: now });
      log(docType, doc, flow.steps[0].step_no, flow.steps[0].step_name, 'pending', '目前關卡', null, '',
        { notifiedAt: now, finishedAt: null });
    })();
    audit.log(req, 'approval_submit', `發起簽核：${meta.label} ${doc[meta.noCol]}`);
    res.json(withDoc(docType, db.prepare(`SELECT * FROM ${meta.table} WHERE id=?`).get(doc.id)));
  } catch (e) { next(e); }
});

async function actAction(action, req, res) {
  const { docType } = req.params;
  const doc = getDoc(docType, Number(req.params.id));
  if (!doc) return res.status(404).json({ error: '文件不存在' });
  const meta = getFlowMeta(docType);
  if (!meta) return res.status(400).json({ error: `尚不支援文件類型：${docType}` });
  if (doc.approval_status !== 'pending') {
    return res.status(400).json({ error: `目前狀態（${doc.approval_status}）不可執行${action === 'approve' ? '核准' : action === 'reject' ? '駁回' : '退回'}` });
  }
  const flow = getFlow(docType);
  const step = currentStepOf(doc, flow);
  if (!step) return res.status(400).json({ error: '簽核流程設定不完整' });
  const ids = parseIds(step.approver_ids);
  if (!ids.includes(req.user.id)) return res.status(403).json({ error: '您不是本步驟的核決主管' });
  if (action === 'approve' && approvedActors(docType, doc.id, step.step_no).includes(req.user.id)) {
    return res.status(400).json({ error: '您已核准過本文件' });
  }

  const comment = str((req.body || {}).comment);
  const delegate = str((req.body || {}).delegate_name || (req.body || {}).delegate);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await db.transaction(async () => {
    if (action === 'approve') {
      log(docType, doc, step.step_no, step.step_name, 'approve', '已同意', req.user, comment,
        { delegate, finishedAt: now, notifiedAt: now });
      const approved = approvedActors(docType, doc.id, step.step_no);
      const allApproved = ids.every((id) => approved.includes(id));
      if (allApproved) {
        closePendingRow(docType, doc.id, step.step_no, req.user, '已同意', comment, delegate, now);
        const next = flow.steps.find((s) => s.step_no > step.step_no);
        if (next) {
          db.prepare(`UPDATE ${meta.table} SET current_step=?, acted_at=datetime('now','localtime') WHERE id=?`).run(next.step_no, doc.id);
          log(docType, doc, next.step_no, next.step_name, 'pending', '目前關卡', null, '',
            { notifiedAt: now, finishedAt: null });
        } else {
          db.prepare(`UPDATE ${meta.table} SET approval_status='approved', acted_at=datetime('now','localtime') WHERE id=?`).run(doc.id);
          // 簽核全數通過 → 同步業務狀態（如報價單 draft → confirmed「已報價」）
          syncApprovedBusinessStatus(docType, meta, doc.id);
        }
      } else {
        db.prepare(`UPDATE ${meta.table} SET acted_at=datetime('now','localtime') WHERE id=?`).run(doc.id);
      }
    } else if (action === 'reject') {
      closePendingRow(docType, doc.id, step.step_no, req.user, '已否決', comment, delegate, now);
      db.prepare(`UPDATE ${meta.table} SET approval_status='rejected', acted_at=datetime('now','localtime') WHERE id=?`).run(doc.id);
    } else {
      closePendingRow(docType, doc.id, step.step_no, req.user, '待修改', comment, delegate, now);
      db.prepare(`UPDATE ${meta.table} SET approval_status='returned', acted_at=datetime('now','localtime') WHERE id=?`).run(doc.id);
    }
  })();
  const label = action === 'approve' ? '核准' : action === 'reject' ? '駁回' : '退回';
  audit.log(req, `approval_${action}`, `${label}：${meta.label} ${doc[meta.noCol]}`);
  res.json(withDoc(docType, db.prepare(`SELECT * FROM ${meta.table} WHERE id=?`).get(doc.id)));
}

router.post('/doc/:docType/:id/approve', async (req, res, next) => {
  try { await actAction('approve', req, res); }
  catch (e) { next(e); }
});
router.post('/doc/:docType/:id/reject', async (req, res, next) => {
  try { await actAction('reject', req, res); }
  catch (e) { next(e); }
});
router.post('/doc/:docType/:id/return', async (req, res, next) => {
  try { await actAction('return', req, res); }
  catch (e) { next(e); }
});

module.exports = router;
