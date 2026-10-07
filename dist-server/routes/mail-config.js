'use strict';
/**
 * 郵件設定路由（routes/mail-config.js）
 *
 *   GET  /api/mail-config        讀取 SMTP 設定（密碼不回傳）
 *   POST /api/mail-config        儲存 SMTP 設定（密碼僅在提供時更新）
 *   POST /api/mail-config/test   發送測試郵件
 *
 * 設定儲存於 parameters 表（group_name='mail'），鍵值：
 *   smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, mail_from, mail_footer
 *
 *   mail_footer：信件頁尾自動附加文字（可編輯；留空則使用系統預設「本郵件由 輔凰商貿系統 自動寄出。」）
 *
 * 權限：requireManager（管理者 / 主管）
 */
const express = require('express');
const { db } = require('../lib/db-dual');
const { encrypt } = require('../lib/crypto');
const { requireAuth, requireManager } = require('../lib/auth');
const audit = require('../lib/audit');
const { getMailConfig, sendTestMail } = require('../lib/mailer');

const router = express.Router();
router.use(requireAuth);

const MAIL_KEYS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_secure', 'mail_from', 'mail_footer'];

/** 從 parameters 表讀取郵件設定（原始值，含密碼） */
function loadRawConfig() {
  const rows = db.prepare("SELECT key, value FROM parameters WHERE group_name = 'mail'").all();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

/** 儲存單一參數（upsert） */
function setParam(key, value) {
  db.prepare(`INSERT INTO parameters (key, value, group_name) VALUES (?,?, 'mail')
              ON CONFLICT(key) DO UPDATE SET value=excluded.value, group_name='mail', updated_at=datetime('now','localtime')`)
    .run(key, value);
}

// ========== 讀取設定 ==========
router.get('/', requireManager, (req, res) => {
  try {
    const raw = loadRawConfig();
    const effective = getMailConfig();
    res.json({
      smtp_host: raw.smtp_host || '',
      smtp_port: raw.smtp_port || '587',
      smtp_user: raw.smtp_user || '',
      smtp_pass: '',  // 密碼永遠不回傳
      smtp_pass_set: !!(raw.smtp_pass && raw.smtp_pass.length > 0),
      smtp_secure: raw.smtp_secure === '1' || raw.smtp_secure === 'true',
      mail_from: raw.mail_from || '',
      mail_footer: raw.mail_footer || '',
      effective_mode: effective.mode,       // 'smtp' | 'ethereal'
      effective_source: effective.source,   // 'db' | 'config' | 'none'
      config_smtp_host: (effective.source === 'config' && effective.host) ? effective.host : '',
      // ===== 2026-09-24 郵件防呆：回傳「實際生效的加密方式」，前端用於狀態卡與自動校正提示 =====
      effective_port: effective.effective_port,
      effective_secure: effective.effective_secure,
      effective_encryption: effective.effective_encryption,
      secure_auto_override: !!effective.secure_auto_override,
    });
  } catch (e) {
    res.status(500).json({ error: '讀取郵件設定失敗：' + e.message });
  }
});

// ========== 儲存設定 ==========
router.post('/', requireManager, async (req, res) => {
  try {
    const b = req.body || {};
    const values = {};

    // 主機（必填）
    if (b.smtp_host !== undefined) values.smtp_host = String(b.smtp_host).trim();
    // 連接埠
    if (b.smtp_port !== undefined) values.smtp_port = String(b.smtp_port).trim() || '587';
    // 使用者
    if (b.smtp_user !== undefined) values.smtp_user = String(b.smtp_user).trim();
    // 密碼：只有在提供非空值時才更新（避免覆蓋已儲存的密碼）
    // 儲存前以 AES-256-GCM 加密
    if (b.smtp_pass && String(b.smtp_pass).length > 0) {
      values.smtp_pass = encrypt(String(b.smtp_pass));
    }
    // SSL/TLS
    if (b.smtp_secure !== undefined) values.smtp_secure = b.smtp_secure ? '1' : '0';
    // 寄件者
    if (b.mail_from !== undefined) values.mail_from = String(b.mail_from).trim();
    // 頁尾文字（純文字，不加密）
    if (b.mail_footer !== undefined) values.mail_footer = String(b.mail_footer);

    if (Object.keys(values).length === 0) {
      return res.status(400).json({ error: '沒有可更新的欄位' });
    }

    // 基本驗證：如果有 host 但沒有 user，仍允許（部分 SMTP 不需認證）
    if (values.smtp_host && values.smtp_host.length > 0 && !values.smtp_host.includes('.')) {
      return res.status(400).json({ error: 'SMTP 主機格式不正確（應包含網域名稱）' });
    }

    const tx = db.transaction(async () => {
      for (const [k, v] of Object.entries(values)) {
        await setParam(k, v);
      }
    });
    await tx();

    audit.log(req, 'update', 'mail_config', '', Object.keys(values).join(','));
    res.json({ ok: true, updated: Object.keys(values) });
  } catch (e) {
    res.status(500).json({ error: '儲存郵件設定失敗：' + e.message });
  }
});

// ========== 發送測試郵件 ==========
router.post('/test', requireManager, async (req, res) => {
  try {
    const to = (req.body && req.body.test_email || '').toString().trim();
    if (!to) return res.status(400).json({ error: '請填寫測試收件人 Email' });
    // 簡單 Email 格式驗證
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ error: 'Email 格式不正確' });
    }

    const result = await sendTestMail(to);
    if (!result.configured) {
      return res.status(400).json({ error: result.error || 'SMTP 尚未設定完整' });
    }
    if (!result.ok) {
      audit.log(req, 'email.test_failed', 'mail_config', '', { to, error: result.error });
      return res.status(500).json({ error: result.error || '測試郵件發送失敗' });
    }
    audit.log(req, 'email.test', 'mail_config', '', { to, messageId: result.messageId });
    res.json({ ok: true, message: `測試郵件已寄送至 ${to}`, messageId: result.messageId, previewUrl: result.previewUrl || null });
  } catch (e) {
    res.status(500).json({ error: '測試郵件發送失敗：' + e.message });
  }
});

module.exports = router;
