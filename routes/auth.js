'use strict';
/**
 * 認證路由
 * 🔒 硬規則：登入一律收「工號」empId（username 僅為 local 模式過渡別名）
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const {
  authenticate, createToken, destroyToken, cleanupExpiredTokens,
  requireAuth, hashPassword, verifyPassword,
  getClientIp, checkLockout, recordFailure, clearFailures,
} = require('../lib/auth');
const { cfg } = require('../lib/config');
const audit = require('../lib/audit');
const crypto = require('crypto');
const mfa = require('../lib/mfa');
const QRCode = require('qrcode');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();

const SUPER_EMPID = (cfg.auth && cfg.auth.bootstrapAdmin && cfg.auth.bootstrapAdmin.empId) || 'super';
function publicUser(u) {
  return {
    id: u.id, emp_id: u.emp_id, empId: u.emp_id || u.username, username: u.username,
    name: u.name, role: u.role, title: u.title, email: u.email, active: u.active,
    // 輔凰工程帳號（emp_id=super）為全系統最大權限，永不因 bootstrapAdmin/env 判定失準
    isSuperAdmin: u.emp_id === 'super' || u.emp_id === SUPER_EMPID,
    mustChangePwd: !!u.must_change_pwd,
    mfaEnabled: !!u.mfa_enabled,
  };
}

/** 登入：{ empId, password }（含 B3 登入失敗鎖定：IP＋帳號，5 次失敗鎖 15 分鐘） */
router.post('/login', wrap(async (req, res) => {
  const empId = req.body.empId || req.body.username || req.body.emp_id;
  const password = req.body.password;
  if (!empId || !password) return res.status(400).json({ error: '請輸入工號與密碼' });
  const ip = getClientIp(req);
  const lockKey = `${ip}|${String(empId).trim().toUpperCase()}`;
  const lock = checkLockout(lockKey);
  if (lock.locked) {
    const min = Math.ceil(lock.retryAfterSec / 60);
    return res.status(423).json({ error: `嘗試次數過多，帳號已鎖定，請於 ${min} 分鐘後再試`, locked: true, retryAfterSec: lock.retryAfterSec });
  }
  try {
    await cleanupExpiredTokens();
    const u = await authenticate(empId, password);
    if (!u) {
      const r = recordFailure(lockKey);
      if (r.locked) return res.status(423).json({ error: '密碼錯誤次數過多，帳號已鎖定 15 分鐘', locked: true, retryAfterSec: r.retryAfterSec });
      return res.status(401).json({ error: `工號或密碼錯誤（剩餘 ${r.remaining} 次）` });
    }
    clearFailures(lockKey);
    // 🔒 全域 MFA 開關：mfaEnabled===false（公司內部暫只用帳號＋密碼）時，跳過所有 MFA 挑戰直接發 token。
    //    預設 true；可由 dist-server/config.json 的 auth.mfaEnabled 覆寫。已綁定狀態保留，日後開回即生效。
    const mfaEnabled = !(cfg.auth && cfg.auth.mfaEnabled === false);
    if (mfaEnabled) {
    // 🔒 MFA：啟用二階段驗證者，發出短期挑戰碼請求第二步，不在此建立 session
    if (u.mfa_enabled) {
      const challenge = crypto.randomBytes(32).toString('hex');
      // ⚠️ 以 epoch 秒存 expires_at：避免 toISOString(UTC) 與 new Date(local) 時區錯置，
      //    導致挑戰碼在 UTC+8 主機上「立即過期」而被 verify-mfa 的過期分支刪除（MFA 第二步永遠 401）。
      const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60;
      // 清理同一使用者舊的過期挑戰碼，避免殘留累積
      try { await db.prepare('DELETE FROM mfa_challenges WHERE user_id=? AND CAST(expires_at AS INTEGER)*1000 < ?').run(u.id, Date.now()); } catch {}
      await db.prepare('INSERT INTO mfa_challenges (token, user_id, expires_at) VALUES (?,?,?)').run(challenge, u.id, String(expiresAt));
      return res.json({ mfaRequired: true, challengeToken: challenge, mustChangePwd: !!u.must_change_pwd });
    }
    // 🔒 MFA 技術強制：角色在 requireMfaRoles 且尚未啟用 MFA → 導向強制綁定，不發 session token
    const requireMfaRoles = (cfg.auth.requireMfaRoles || []).map((x) => String(x).toLowerCase());
    if (requireMfaRoles.includes(String(u.role || '').toLowerCase())) {
      const setupToken = crypto.randomBytes(32).toString('hex');
      const setupExpiresAt = Math.floor(Date.now() / 1000) + 10 * 60;
      try { await db.prepare('DELETE FROM mfa_setup_challenges WHERE user_id=? AND CAST(expires_at AS INTEGER)*1000 < ?').run(u.id, Date.now()); } catch {}
      await db.prepare('INSERT INTO mfa_setup_challenges (token, user_id, expires_at) VALUES (?,?,?)').run(setupToken, u.id, String(setupExpiresAt));
      return res.json({ mfaSetupRequired: true, setupToken, mustChangePwd: !!u.must_change_pwd });
    }
    }
    const { token, expires_at } = await createToken(u.id);
    res.json({ token, expires_at, user: publicUser(u), provider: cfg.auth.provider, mustChangePwd: !!u.must_change_pwd });
  } catch (e) {
    res.status(500).json({ error: '登入失敗：' + e.message });
  }
}));

/** 登出 */
router.post('/logout', requireAuth, wrap(async (req, res) => {
  const h = req.headers.authorization || '';
  if (h.toLowerCase().startsWith('bearer ')) await destroyToken(h.slice(7).trim());
  res.json({ ok: true });
}));

/** 目前登入者 */
router.get('/me', requireAuth, wrap(async (req, res) => {
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u) return res.status(401).json({ error: '帳號不存在' });
  res.json({ user: publicUser(u), provider: cfg.auth.provider, base: (cfg.currency && cfg.currency.base) || 'TWD' });
}));

/** 修改自己的密碼（shared 模式不提供）；首次登入強制改密會清除 must_change_pwd */
router.post('/change-password', requireAuth, wrap(async (req, res) => {
  if (cfg.auth.provider === 'shared') {
    return res.status(400).json({ error: '目前為 HR 共用帳密模式，密碼請至 HR 系統修改' });
  }
  const oldP = req.body.old_password || req.body.oldPassword;
  const newP = req.body.new_password || req.body.newPassword;
  if (!oldP || !newP) return res.status(400).json({ error: '請輸入舊密碼與新密碼' });
  // 🔒 B2：強密碼政策（至少 8 碼，且同時含英文字母與數字）
  if (String(newP).length < 8) return res.status(400).json({ error: '新密碼至少 8 碼' });
  if (!/[a-zA-Z]/.test(newP) || !/\d/.test(newP)) return res.status(400).json({ error: '新密碼須同時包含英文字母與數字' });
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!verifyPassword(oldP, u.password_hash)) return res.status(400).json({ error: '舊密碼錯誤' });
  if (oldP === newP) return res.status(400).json({ error: '新密碼不能與舊密碼相同' });
  await db.prepare("UPDATE users SET password_hash=?, must_change_pwd=0, updated_at=datetime('now','localtime') WHERE id=?")
    .run(hashPassword(newP), u.id);
  audit.log(req, 'change_password', 'users', u.id, u.emp_id);
  res.json({ ok: true, mustChangePwd: false });
}));

/** MFA 第二步：以挑戰碼 + TOTP 完成登入（未登入狀態可呼叫） */
router.post('/verify-mfa', wrap(async (req, res) => {
  const challenge = req.body.challengeToken || req.body.challenge || req.body.token;
  const code = req.body.code;
  if (!challenge || !code) return res.status(400).json({ error: '請提供挑戰碼與驗證碼' });
  const ch = await db.prepare('SELECT * FROM mfa_challenges WHERE token=?').get(challenge);
  if (!ch) return res.status(401).json({ error: '驗證逾時或無效，請重新登入' });
  if (ch.expires_at && Number(ch.expires_at) * 1000 < Date.now()) {
    await db.prepare('DELETE FROM mfa_challenges WHERE token=?').run(challenge);
    return res.status(401).json({ error: '驗證逾時，請重新登入' });
  }
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(ch.user_id);
  const secret = u ? mfa.decryptSecret(u.mfa_secret) : null;
  if (!u || !u.active || !u.mfa_enabled || !secret) {
    return res.status(401).json({ error: '帳號未啟用 MFA' });
  }
  if (!mfa.verify(secret, code)) {
    return res.status(401).json({ error: '驗證碼錯誤' });
  }
  await db.prepare('DELETE FROM mfa_challenges WHERE token=?').run(challenge);
  const { token, expires_at } = await createToken(u.id);
  audit.log(req, 'login_mfa', 'auth', u.id, u.emp_id);
  res.json({ token, expires_at, user: publicUser(u), provider: cfg.auth.provider, mustChangePwd: !!u.must_change_pwd });
}));

/** MFA 自助啟用：產生待確認密鑰 + otpauth URI + QR（登入後可用） */
router.post('/mfa/setup', requireAuth, wrap(async (req, res) => {
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const secret = mfa.generateSecret();
  await db.prepare('UPDATE users SET mfa_pending_secret=? WHERE id=?').run(mfa.encryptSecret(secret), u.id);
  const issuer = (cfg.app_name || '輔凰商貿系統').slice(0, 32);
  const uri = mfa.otpauthUrl({ issuer, account: u.emp_id || u.username, secret });
  const qr = await QRCode.toDataURL(uri);
  res.json({ secret, otpauthUrl: uri, qrDataUrl: qr, enabled: !!u.mfa_enabled });
}));

/** MFA 確認啟用：輸入正確 TOTP 後正式啟用 */
router.post('/mfa/confirm', requireAuth, wrap(async (req, res) => {
  const code = req.body.code;
  if (!code) return res.status(400).json({ error: '請輸入驗證碼' });
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u.mfa_pending_secret) return res.status(400).json({ error: '請先執行啟用並取得密鑰' });
  const pending = mfa.decryptSecret(u.mfa_pending_secret);
  if (!pending || !mfa.verify(pending, code)) return res.status(400).json({ error: '驗證碼錯誤，請重試' });
  // 注意：mfa_pending_secret 在 DB 中已為加密值，此處直接整欄拷貝，
  // mfa_secret 因此同樣以 v1: 加密形式落庫（兩者皆密文，驗證時再 decrypt）。
  await db.prepare("UPDATE users SET mfa_secret=mfa_pending_secret, mfa_pending_secret=NULL, mfa_enabled=1, updated_at=datetime('now','localtime') WHERE id=?").run(u.id);
  audit.log(req, 'mfa_enable', 'users', u.id, u.emp_id);
  res.json({ ok: true, enabled: true });
}));

/** MFA 停用（需密碼＋當前 TOTP 碼；若尚未啟用則只需密碼） */
router.post('/mfa/disable', requireAuth, wrap(async (req, res) => {
  const oldP = req.body.password || req.body.old_password;
  const code = req.body.code;
  if (!oldP) return res.status(400).json({ error: '請輸入登入密碼' });
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!verifyPassword(oldP, u.password_hash)) return res.status(400).json({ error: '密碼錯誤' });
  if (u.mfa_enabled) {
    if (!code) return res.status(400).json({ error: '請輸入目前的驗證碼' });
    const secret = mfa.decryptSecret(u.mfa_secret);
    if (!secret || !mfa.verify(secret, code)) return res.status(400).json({ error: '驗證碼錯誤' });
  }
  await db.prepare("UPDATE users SET mfa_secret=NULL, mfa_pending_secret=NULL, mfa_enabled=0, updated_at=datetime('now','localtime') WHERE id=?").run(u.id);
  audit.log(req, 'mfa_disable', 'users', u.id, u.emp_id);
  res.json({ ok: true, enabled: false });
}));

/** MFA 自助查看目前綁定密鑰與 QR（已綁定者；密碼 step-up 確認身分）
 *  用途：避免 PNG（文件/mfa_qr/*.png）遺失就只能走救援端點 mfa-disable。
 *  回傳解密後的明文 secret + otpauth URI + QR dataURL（等同綁定當下使用者所見）。 */
router.post('/mfa/view', requireAuth, wrap(async (req, res) => {
  const pw = req.body.password || req.body.old_password;
  if (!pw) return res.status(400).json({ error: '請輸入登入密碼以確認身分' });
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!u || !u.mfa_enabled || !u.mfa_secret) return res.status(400).json({ error: '此帳號尚未啟用 MFA' });
  if (!verifyPassword(pw, u.password_hash)) return res.status(400).json({ error: '密碼錯誤' });
  const secret = mfa.decryptSecret(u.mfa_secret);
  if (!secret) return res.status(500).json({ error: '密鑰解密失敗，請聯絡管理員重發' });
  const issuer = (cfg.app_name || '輔凰商貿系統').slice(0, 32);
  const uri = mfa.otpauthUrl({ issuer, account: u.emp_id || u.username, secret });
  const qr = await QRCode.toDataURL(uri);
  audit.log(req, 'mfa_view', 'users', u.id, u.emp_id);
  res.json({ secret, otpauthUrl: uri, qrDataUrl: qr, enabled: true });
}));

/** MFA 強制綁定：第一步（無 session，僅憑 setupToken）產生待確認密鑰與 QR */
router.post('/mfa/setup-start', wrap(async (req, res) => {
  const token = req.body.setupToken || req.body.token;
  if (!token) return res.status(400).json({ error: '請提供 setupToken' });
  const ch = await db.prepare('SELECT * FROM mfa_setup_challenges WHERE token=?').get(token);
  if (!ch) return res.status(401).json({ error: '綁定逾時或無效，請重新登入' });
  if (ch.expires_at && Number(ch.expires_at) * 1000 < Date.now()) {
    await db.prepare('DELETE FROM mfa_setup_challenges WHERE token=?').run(token);
    return res.status(401).json({ error: '綁定逾時，請重新登入' });
  }
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(ch.user_id);
  if (!u || !u.active) return res.status(401).json({ error: '帳號無效' });
  const secret = mfa.generateSecret();
  await db.prepare('UPDATE users SET mfa_pending_secret=? WHERE id=?').run(mfa.encryptSecret(secret), u.id);
  const issuer = (cfg.app_name || '輔凰商貿系統').slice(0, 32);
  const uri = mfa.otpauthUrl({ issuer, account: u.emp_id || u.username, secret });
  const qr = await QRCode.toDataURL(uri);
  res.json({ secret, otpauthUrl: uri, qrDataUrl: qr, enabled: false });
}));

/** MFA 強制綁定：第二步 驗證 TOTP 後正式啟用並發 session token */
router.post('/mfa/setup-finish', wrap(async (req, res) => {
  const token = req.body.setupToken || req.body.token;
  const code = req.body.code;
  if (!token || !code) return res.status(400).json({ error: '請提供 setupToken 與驗證碼' });
  const ch = await db.prepare('SELECT * FROM mfa_setup_challenges WHERE token=?').get(token);
  if (!ch) return res.status(401).json({ error: '綁定逾時或無效，請重新登入' });
  if (ch.expires_at && Number(ch.expires_at) * 1000 < Date.now()) {
    await db.prepare('DELETE FROM mfa_setup_challenges WHERE token=?').run(token);
    return res.status(401).json({ error: '綁定逾時，請重新登入' });
  }
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(ch.user_id);
  if (!u || !u.active || !u.mfa_pending_secret) return res.status(401).json({ error: '帳號或綁定狀態無效' });
  const pending = mfa.decryptSecret(u.mfa_pending_secret);
  if (!pending || !mfa.verify(pending, code)) return res.status(400).json({ error: '驗證碼錯誤，請重試' });
  await db.prepare("UPDATE users SET mfa_secret=mfa_pending_secret, mfa_pending_secret=NULL, mfa_enabled=1, updated_at=datetime('now','localtime') WHERE id=?").run(u.id);
  await db.prepare('DELETE FROM mfa_setup_challenges WHERE token=?').run(token);
  audit.log(req, 'mfa_enable', 'users', u.id, u.emp_id);
  const { token: sessToken, expires_at } = await createToken(u.id);
  res.json({ token: sessToken, expires_at, user: publicUser(u), provider: cfg.auth.provider, mustChangePwd: !!u.must_change_pwd });
}));

module.exports = router;
