'use strict';
/** 使用者管理（管理員限定）🔒 工號 emp_id 為必填識別 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { requireAuth, requireAdmin, hashPassword, verifyPassword, SUPER_EMPID, isSuperEmp } = require('../lib/auth');
const { cfg } = require('../lib/config');
const audit = require('../lib/audit');
const { str } = require('../lib/util');
const mfa = require('../lib/mfa');
const QRCode = require('qrcode');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();
router.use(requireAuth, requireAdmin);

function row(u) {
  return {
    id: u.id, emp_id: u.emp_id, username: u.username, name: u.name, role: u.role,
    title: u.title, phone: u.phone, email: u.email, active: u.active,
    mustChangePwd: !!u.must_change_pwd,
    created_at: u.created_at, updated_at: u.updated_at,
  };
}

router.get('/', wrap(async (req, res) => {
  // 隱藏工程師管理者（供應商後門帳號），客戶管理者看不到也無法管理
  res.json(await db.prepare("SELECT * FROM users WHERE emp_id NOT IN ('super', ?) ORDER BY active DESC, role, emp_id").all(SUPER_EMPID).map(row));
}));

router.post('/', wrap(async (req, res) => {
  const b = req.body || {};
  const empId = str(b.emp_id || b.empId);
  const name = str(b.name);
  if (!empId) return res.status(400).json({ error: '工號為必填' });
  if (!name) return res.status(400).json({ error: '姓名為必填' });
  // 工程師管理者帳號為系統保留，禁止客戶建立
  if (String(empId).toUpperCase() === String(SUPER_EMPID).toUpperCase() || String(empId).toUpperCase() === 'SUPER') {
    return res.status(400).json({ error: `工號 ${empId} 為系統保留帳號，不可建立` });
  }
  if (!['admin', 'manager', 'accounting', 'sales'].includes(b.role || 'sales')) {
    return res.status(400).json({ error: '角色不合法' });
  }
  if (await db.prepare('SELECT id FROM users WHERE emp_id=?').get(empId)) {
    return res.status(400).json({ error: `工號 ${empId} 已存在` });
  }
  let uname = str(b.username) || empId.toLowerCase();
  let n = 1;
  while (await db.prepare('SELECT id FROM users WHERE username=?').get(uname)) { n++; uname = `${empId.toLowerCase()}-${n}`; }
  const pw = b.password ? hashPassword(b.password) : '';
  try {
    // 🔒 B2：管理者新建的帳號，首次登入必須修改密碼（must_change_pwd=1）
    const info = await db.prepare(
      `INSERT INTO users (emp_id, username, password_hash, name, role, title, phone, email, active, must_change_pwd)
       VALUES (?,?,?,?,?,?,?,?,?,1)`
    ).run(empId, uname, pw, name, b.role || 'sales', str(b.title), str(b.phone), str(b.email), b.active === undefined ? 1 : (Number(b.active) ? 1 : 0));
    audit.log(req, 'create', 'users', info.lastInsertRowid, empId);
    res.json(row(await db.prepare('SELECT * FROM users WHERE id=?').get(info.lastInsertRowid)));
  } catch (e) {
    res.status(400).json({ error: '建立失敗：' + e.message });
  }
}));

router.put('/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cur = await db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '使用者不存在' });
  // 工程師管理者帳號不可被修改（防客戶管理者降權/停用後門）
  if (isSuperEmp(cur.emp_id)) {
    return res.status(403).json({ error: '工程師管理者帳號不可修改' });
  }
  const b = req.body || {};
  const empId = b.emp_id !== undefined ? str(b.emp_id) : cur.emp_id;
  if (!empId) return res.status(400).json({ error: '工號不可空白' });
  if (await db.prepare('SELECT id FROM users WHERE emp_id=? AND id<>?').get(empId, id)) {
    return res.status(400).json({ error: `工號 ${empId} 已被其他帳號使用` });
  }
  const next = {
    emp_id: empId,
    name: b.name !== undefined ? str(b.name) : cur.name,
    role: b.role !== undefined ? b.role : cur.role,
    title: b.title !== undefined ? str(b.title) : cur.title,
    phone: b.phone !== undefined ? str(b.phone) : cur.phone,
    email: b.email !== undefined ? str(b.email) : cur.email,
    active: b.active === undefined ? cur.active : (Number(b.active) ? 1 : 0),
  };
  if (!['admin', 'manager', 'accounting', 'sales'].includes(next.role)) {
    return res.status(400).json({ error: '角色不合法' });
  }
  // 不能把自己停用或降權（避免鎖死系統）
  if (id === req.user.id && (next.active !== 1 || next.role !== 'admin')) {
    return res.status(400).json({ error: '不可停用或降級目前登入的管理員帳號' });
  }
  const roleChanged = cur.role !== next.role;
  await db.prepare(
    `UPDATE users SET emp_id=?, name=?, role=?, title=?, phone=?, email=?, active=?,
     updated_at=datetime('now','localtime') WHERE id=?`
  ).run(next.emp_id, next.name, next.role, next.title, next.phone, next.email, next.active, id);
  if (b.password) {
    await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(b.password), id);
  }
  // M1 稽核：角色變更時於 detail 載明 old→new，提升稽核覆蓋完整性
  audit.log(req, 'update', 'users', id, empId + (roleChanged ? ` role=${cur.role}→${next.role}` : ''));
  res.json(row(await db.prepare('SELECT * FROM users WHERE id=?').get(id)));
}));

router.delete('/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不可刪除目前登入的帳號' });
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '使用者不存在' });
  // 工程師管理者帳號不可被刪除
  if (isSuperEmp(u.emp_id)) {
    return res.status(403).json({ error: '工程師管理者帳號不可刪除' });
  }
  // 已被訂單引用的業務不刪除，改用停用保留軌跡
  const used = await db.prepare('SELECT COUNT(*) AS c FROM orders WHERE sales_id=?').get(id).c;
  if (used > 0) {
    await db.prepare("UPDATE users SET active=0, updated_at=datetime('now','localtime') WHERE id=?").run(id);
    audit.log(req, 'deactivate', 'users', id, u.emp_id);
    return res.json({ ok: true, deactivated: true, message: '該業務已有訂單資料，已改為停用' });
  }
  await db.prepare('DELETE FROM users WHERE id=?').run(id);
  audit.log(req, 'delete', 'users', id, u.emp_id);
  res.json({ ok: true });
}));

// 管理者停用指定使用者的 MFA（帳號被鎖/換手機時救援；禁止對工程師管理者帳號）
router.post('/:id/mfa-disable', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '使用者不存在' });
  if (isSuperEmp(u.emp_id)) return res.status(403).json({ error: '工程師管理者帳號不可操作' });
  await db.prepare("UPDATE users SET mfa_secret=NULL, mfa_pending_secret=NULL, mfa_enabled=0, updated_at=datetime('now','localtime') WHERE id=?").run(id);
  audit.log(req, 'mfa_disable_admin', 'users', id, u.emp_id);
  res.json({ ok: true, enabled: false });
}));

// 管理者代看指定使用者「目前綁定」的 MFA 密鑰與 QR（密碼 step-up 確認操作者身分；
// 用途：使用者遺失 PNG 時，管理者可直接重看，不必走 mfa-disable 救援端點）
router.post('/:id/mfa-view', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const pw = req.body.password || req.body.old_password;
  if (!pw) return res.status(400).json({ error: '請輸入您（管理者）的登入密碼以確認身分' });
  const admin = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!admin || !verifyPassword(pw, admin.password_hash)) return res.status(400).json({ error: '管理者密碼錯誤' });
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '使用者不存在' });
  if (isSuperEmp(u.emp_id)) return res.status(403).json({ error: '工程師管理者帳號不可操作' });
  if (!u.mfa_enabled || !u.mfa_secret) return res.status(400).json({ error: '該帳號尚未啟用 MFA' });
  const secret = mfa.decryptSecret(u.mfa_secret);
  if (!secret) return res.status(500).json({ error: '密鑰解密失敗' });
  const issuer = (cfg.app_name || '輔凰商貿系統').slice(0, 32);
  const uri = mfa.otpauthUrl({ issuer, account: u.emp_id || u.username, secret });
  const qr = await QRCode.toDataURL(uri);
  audit.log(req, 'mfa_view_admin', 'users', id, u.emp_id);
  res.json({ id: u.id, emp_id: u.emp_id, name: u.name, secret, otpauthUrl: uri, qrDataUrl: qr, enabled: true });
}));

// 管理者為指定使用者「重發」MFA（立即產生新密鑰、加密落庫並啟用，舊 TOTP 碼立即失效）
// 密碼 step-up + 稽核；禁止對工程師管理者帳號。適用：換手機 / 舊碼遺失 / 疑似外流。
router.post('/:id/mfa-reissue', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const pw = req.body.password || req.body.old_password;
  if (!pw) return res.status(400).json({ error: '請輸入您（管理者）的登入密碼以確認身分' });
  const admin = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!admin || !verifyPassword(pw, admin.password_hash)) return res.status(400).json({ error: '管理者密碼錯誤' });
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '使用者不存在' });
  if (isSuperEmp(u.emp_id)) return res.status(403).json({ error: '工程師管理者帳號不可操作' });
  const secret = mfa.generateSecret();
  await db.prepare("UPDATE users SET mfa_secret=?, mfa_pending_secret=NULL, mfa_enabled=1, updated_at=datetime('now','localtime') WHERE id=?")
    .run(mfa.encryptSecret(secret), id);
  const issuer = (cfg.app_name || '輔凰商貿系統').slice(0, 32);
  const uri = mfa.otpauthUrl({ issuer, account: u.emp_id || u.username, secret });
  const qr = await QRCode.toDataURL(uri);
  audit.log(req, 'mfa_reissue_admin', 'users', id, u.emp_id);
  res.json({ id: u.id, emp_id: u.emp_id, name: u.name, secret, otpauthUrl: uri, qrDataUrl: qr, enabled: true, reissued: true });
}));

module.exports = router;
