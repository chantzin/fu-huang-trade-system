'use strict';
/**
 * 郵件發送紀錄路由（routes/mail-logs.js）
 *
 *   GET /api/mail-logs  查詢郵件發送紀錄（從 audit_logs 表，action LIKE 'email%'）
 *
 * 查詢參數：
 *   status    — all | sent | failed（預設 all）
 *   search    — 關鍵字（比對收件者 / 主旨 / entity_id）
 *   page      — 頁碼（預設 1）
 *   pageSize  — 每頁筆數（預設 50，最大 200）
 *
 * 回傳：
 *   rows      — 紀錄列表（含解析後的 detail）
 *   total     — 總筆數
 *   page/pageSize
 *   summary   — { total, sent, failed }
 *
 * 權限：requireManager（管理者 / 主管）
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireManager } = require('../lib/auth');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();
router.use(requireAuth);

/** 解析 detail JSON 字串，失敗則回傳原始字串 */
function parseDetail(detail) {
  if (!detail) return {};
  try { return JSON.parse(detail); } catch { return { raw: detail }; }
}

/** 判斷紀錄狀態：sent / failed */
function getStatus(row) {
  if (row.action && row.action.includes('failed')) return 'failed';
  const d = parseDetail(row.detail);
  // 有 messageId 表示成功發送
  if (d.messageId) return 'sent';
  // email.send 但沒有 messageId（理論上不會發生，防呆）
  if (row.action === 'email.send') return 'sent';
  return 'sent';
}

/** 取得收件者（從 detail 解析） */
function getRecipient(row) {
  const d = parseDetail(row.detail);
  return d.to || d.recipient || d.email || '';
}

/** 取得主旨/說明 */
function getSubject(row) {
  const d = parseDetail(row.detail);
  if (d.subject) return d.subject;
  // 依 entity 與 action 組合說明
  const entityLabel = {
    order: '訂單', shipment: '出貨單', batch: '批次寄送', mail_config: '測試郵件',
  };
  const entity = entityLabel[row.entity] || row.entity || '';
  const actionLabel = {
    'email.send': '發送', 'email.test': '測試', 'email.test_failed': '測試失敗', 'email.send_failed': '發送失敗',
  };
  const action = actionLabel[row.action] || row.action;
  const id = row.entity_id ? ` #${row.entity_id}` : '';
  return `${action}${entity}${id}`;
}

// ========== 查詢郵件發送紀錄 ==========
router.get('/', requireManager, wrap(async (req, res) => {
  try {
    const q = req.query || {};
    const status = (q.status || 'all').toString();
    const search = (q.search || '').toString().trim();
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize, 10) || 50));
    const offset = (page - 1) * pageSize;

    // 基礎 WHERE：action 開頭為 email
    const where = ["action LIKE 'email%'"];
    const params = [];

    // 狀態篩選：失敗 = action 包含 failed；成功 = action 不包含 failed
    if (status === 'failed') {
      where.push("action LIKE '%failed%'");
    } else if (status === 'sent') {
      where.push("action NOT LIKE '%failed%'");
    }

    // 關鍵字篩選：比對 detail（收件者）、entity_id、emp_id
    if (search) {
      where.push('(detail LIKE ? OR entity_id LIKE ? OR emp_id LIKE ?)');
      const kw = '%' + search + '%';
      params.push(kw, kw, kw);
    }

    const whereSql = 'WHERE ' + where.join(' AND ');

    // 總筆數
    const cnt = await db.prepare(`SELECT COUNT(*) as c FROM audit_logs ${whereSql}`).get(...params);

    // 分頁查詢
    const rows = await db.prepare(
      `SELECT id, user_id, emp_id, action, entity, entity_id, detail, created_at
       FROM audit_logs ${whereSql}
       ORDER BY id DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);

    // 統計
    const sum = await db.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN action NOT LIKE '%failed%' THEN 1 ELSE 0 END) as sent,
         SUM(CASE WHEN action LIKE '%failed%' THEN 1 ELSE 0 END) as failed
       FROM audit_logs ${whereSql}`
    ).get(...params);

    // 格式化輸出（解析 detail、加上 status/recipient/subject）
    const formatted = rows.map((r) => ({
      id: r.id,
      emp_id: r.emp_id,
      action: r.action,
      entity: r.entity,
      entity_id: r.entity_id,
      status: getStatus(r),
      recipient: getRecipient(r),
      subject: getSubject(r),
      detail: parseDetail(r.detail),
      created_at: r.created_at,
    }));

    res.json({
      rows: formatted,
      total: cnt ? cnt.c : 0,
      page,
      pageSize,
      summary: {
        total: sum ? sum.total : 0,
        sent: sum ? sum.sent || 0 : 0,
        failed: sum ? sum.failed || 0 : 0,
      },
    });
  } catch (e) {
    res.status(500).json({ error: '查詢郵件發送紀錄失敗：' + e.message });
  }
}));

module.exports = router;
