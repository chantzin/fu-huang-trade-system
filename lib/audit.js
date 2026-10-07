// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = log;
exports.list = list;
exports.stats = stats;
/** 操作日誌：重要資料的新增／修改／刪除留軌跡 */
const { db } = require('./db');
function log(req, action, entity, entityId, detail) {
    try {
        db.prepare('INSERT INTO audit_logs (user_id, emp_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)').run((req && req.user && req.user.id) || null, (req && req.user && req.user.empId) || null, action, entity, entityId === undefined || entityId === null ? null : String(entityId), typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : null);
    }
    catch (e) {
        console.warn('[audit] 寫入失敗：' + e.message);
    }
}
function list({ limit = 50, offset = 0, entity = '', action = '', keyword = '', actor = '', from = '', to = '' } = {}) {
    const where = [];
    const args = [];
    if (entity) {
        where.push('a.entity = ?');
        args.push(entity);
    }
    if (action) {
        where.push('a.action = ?');
        args.push(action);
    }
    if (actor) {
        where.push('a.emp_id LIKE ?');
        args.push(`%${actor}%`);
    }
    if (keyword) {
        where.push('(a.entity_id LIKE ? OR a.detail LIKE ?)');
        args.push(`%${keyword}%`, `%${keyword}%`);
    }
    if (from) {
        where.push('a.created_at >= ?');
        args.push(from);
    }
    if (to) {
        where.push('a.created_at <= ?');
        args.push(to);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs a ${w}`).get(...args).c;
    const rows = db.prepare(`SELECT a.*, u.name AS user_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...args, Number(limit), Number(offset));
    return { rows, total };
}
/** 統計：近 N 天依動作分組的筆數 */
function stats({ days = 30 } = {}) {
    const since = db.prepare("SELECT datetime('now','localtime', ?) AS s").get(`-${Number(days)} days`).s;
    const byAction = db.prepare(`SELECT action, COUNT(*) AS c FROM audit_logs WHERE created_at >= ? GROUP BY action ORDER BY c DESC`).all(since);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs WHERE created_at >= ?`).get(since).c;
    return { total, since, byAction };
}
