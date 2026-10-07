'use strict';
/**
 * 操作日誌查詢（M1：補上稽核「有寫有讀」的缺口）
 *   權限：管理員 / 主管（requireManager）
 *   GET /         分頁 + 多條件篩選（entity / action / actor / keyword / from / to）
 *   GET /stats    近 N 天依動作分組統計
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireManager } = require('../lib/auth');
const audit = require('../lib/audit');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();
router.use(requireAuth, requireManager);

router.get('/', wrap(async (req, res) => {
  const q = req.query;
  const r = audit.list({
    limit: Math.min(Number(q.limit) || 50, 200),
    offset: Number(q.offset) || 0,
    entity: q.entity || '',
    action: q.action || '',
    keyword: q.keyword || '',
    actor: q.actor || '',
    from: q.from || '',
    to: q.to || '',
  });
  res.json(r);
}));

router.get('/stats', wrap(async (req, res) => {
  res.json(audit.stats({ days: Number(req.query.days) || 30 }));
}));

module.exports = router;
