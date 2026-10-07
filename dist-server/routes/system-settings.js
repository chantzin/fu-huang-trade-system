'use strict';
/** 系統設定（主題等） */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireManager } = require('../lib/auth');
const audit = require('../lib/audit');
const { str } = require('../lib/util');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();
router.use(requireAuth);

/** 讀取系統設定 */
router.get('/', wrap(async (req, res) => {
  const getParam = async (key, def) => {
    const r = await db.prepare('SELECT value FROM parameters WHERE key=?').get(key);
    return r ? r.value : def;
  };
  res.json({
    theme: await getParam('system_theme', 'light'),
    money_decimals: await getParam('money_decimals', ''),
  });
}));

/** 儲存系統設定 */
router.put('/', requireManager, wrap(async (req, res) => {
  const b = req.body || {};
  const theme = str(b.theme) || 'light';
  if (!['light', 'dark'].includes(theme)) {
    return res.status(400).json({ error: '主題值不正確（light / dark）' });
  }
  await db.prepare(
    `INSERT INTO parameters (key, value, label, group_name) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now','localtime')`
  ).run('system_theme', theme, '系統主題', 'system');
  audit.log(req, 'update', 'system_settings', '', `theme=${theme}`);
  res.json({ ok: true, theme });
}));

module.exports = router;
