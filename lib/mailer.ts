// @ts-nocheck
'use strict';
/**
 * 郵件寄送模組（lib/mailer.js）
 *
 * 支援三種設定來源（優先順序）：
 *   1. 資料庫 parameters 表（group_name='mail'）— 可由「系統管理 → 郵件設定」UI 編輯
 *   2. config.json 的 mail.smtp — 靜態設定
 *   3. ethereal.email 測試模式 — 無 SMTP 時自動建立測試帳號，所有郵件進測試收件匣
 *
 * 安全設計：
 *   - ethereal 帳號密碼每次啟動隨機，不會洩漏真實郵件
 *   - 真實 SMTP 密碼不寫死，只在 DB 或 config.json 設定時啟用
 *   - 預設 ethereal，不會誤寄真實郵件
 *   - SMTP 密碼不會透過 API 回傳給前端
 */
const nodemailer = require('nodemailer');
const { cfg } = require('./config');
const { decrypt } = require('./crypto');

// ethereal 帳號快取（避免每次寄信都新建）
let _etherealAccount = null;
let _etherealTransporter = null;

/**
 * 已知 SMTP 連接埠對應的加密模式（隱式 SSL vs STARTTLS）
 *   - 465  → 隱式 SSL/TLS（連線即 TLS 握手）
 *   - 587/25/2525 → STARTTLS（明文 220 握手後再升級加密）
 * 配錯端口與加密模式會觸發 OpenSSL `wrong version number`（本系統歷史故障根因）。
 */
const KNOWN_STARTTLS_PORTS = [587, 25, 2525];
const IMPLICIT_SSL_PORTS = [465];

/** 判斷是否為「已知端口」（已知端口強制套用對應加密，避免人為配錯） */
function isKnownPort(port) {
  const p = Number(port);
  return IMPLICIT_SSL_PORTS.includes(p) || KNOWN_STARTTLS_PORTS.includes(p);
}

/**
 * 依連接埠自動決定加密模式（secure），消除「587 + SSL」「465 + 非 SSL」致死組合。
 *   - 465          → 強制隱式 SSL（secure=true）
 *   - 587/25/2525  → 強制 STARTTLS（secure=false）
 *   - 其他自訂端口 → 尊重使用者勾選（secure=userSecure）
 * @param {number|string} port      連接埠
 * @param {boolean} userSecure      使用者儲存的 SSL/TLS 勾選值
 * @returns {boolean} 實際給 nodemailer transporter 使用的 secure
 */
function resolveSecure(port, userSecure) {
  const p = Number(port);
  if (IMPLICIT_SSL_PORTS.includes(p)) return true;
  if (KNOWN_STARTTLS_PORTS.includes(p)) return false;
  return !!userSecure; // 自訂端口：尊重使用者設定
}

/**
 * 產生人類可讀的加密方式說明（給 UI 狀態卡與測試信顯示）
 * @param {number|string} port
 * @param {boolean} secure  實際使用的 secure
 */
function describeEncryption(port, secure) {
  if (secure) return 'SSL/TLS（隱式加密，連線即加密）';
  const p = Number(port);
  if (KNOWN_STARTTLS_PORTS.includes(p)) return 'STARTTLS（明文握手後升級加密，推薦）';
  return '未加密（明文傳輸，不建議）';
}

/**
 * 從資料庫 parameters 表讀取郵件設定（group_name='mail'）
 * @returns {object|null} { host, port, user, pass, secure, from } 或 null（DB 無設定）
 */
function getMailConfigFromDB() {
  try {
    const { db } = require('./db');
    const rows = db.prepare("SELECT key, value FROM parameters WHERE group_name = 'mail'").all();
    if (!rows || rows.length === 0) return null;
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    // 至少需要 host 才算有設定
    if (!map.smtp_host) return null;
    return {
      host: map.smtp_host || '',
      port: map.smtp_port ? Number(map.smtp_port) : 587,
      user: map.smtp_user || '',
      pass: decrypt(map.smtp_pass) || '',
      secure: map.smtp_secure === '1' || map.smtp_secure === 'true',
      from: map.mail_from || '',
    };
  } catch (e) {
    console.warn('[mailer] 讀取 DB 郵件設定失敗（fallback config.json）：' + e.message);
    return null;
  }
}

/**
 * 取得目前有效的郵件設定（DB 優先，其次 config.json）
 * @returns {object} { mode: 'smtp'|'ethereal', host, port, user, pass, secure, from, smtp_pass_set,
 *                     stored_secure, effective_port, effective_secure, effective_encryption, secure_auto_override }
 *
 * 【2026-09-24 郵件故障防呆修正】
 *   secure 欄位一律回傳「依端口自動校正後的有效值」，因此 transporter 永遠不會拿到
 *   「587 + SSL」這種致死組合（即 OpenSSL wrong version number 根因）。
 *   同時回傳 stored_secure（使用者當初儲存值，供 UI 顯示）、effective_* 系列與
 *   secure_auto_override（是否因端口已知而被自動覆寫）。
 */
function getMailConfig() {
  const dbCfg = getMailConfigFromDB();
  if (dbCfg && dbCfg.host) {
    const effectiveSecure = resolveSecure(dbCfg.port, dbCfg.secure);
    return {
      mode: 'smtp',
      source: 'db',
      host: dbCfg.host,
      port: dbCfg.port,
      user: dbCfg.user,
      pass: dbCfg.pass,
      secure: effectiveSecure,                 // 實際給 transporter 使用的值
      stored_secure: dbCfg.secure,              // 使用者當初儲存值（UI 顯示用）
      from: dbCfg.from,
      smtp_pass_set: !!(dbCfg.pass && dbCfg.pass.length > 0),
      effective_port: dbCfg.port,
      effective_secure: effectiveSecure,
      effective_encryption: describeEncryption(dbCfg.port, effectiveSecure),
      secure_auto_override: isKnownPort(dbCfg.port) && effectiveSecure !== dbCfg.secure,
    };
  }
  const fileCfg = cfg.mail || {};
  if (fileCfg.smtp && fileCfg.smtp.host) {
    const filePort = fileCfg.smtp.port || 587;
    const fileSecure = !!fileCfg.smtp.secure;
    const effectiveSecure = resolveSecure(filePort, fileSecure);
    return {
      mode: 'smtp',
      source: 'config',
      host: fileCfg.smtp.host,
      port: filePort,
      user: fileCfg.smtp.user || '',
      pass: fileCfg.smtp.pass || '',
      secure: effectiveSecure,
      stored_secure: fileSecure,
      from: fileCfg.from || '',
      smtp_pass_set: !!(fileCfg.smtp.pass && fileCfg.smtp.pass.length > 0),
      effective_port: filePort,
      effective_secure: effectiveSecure,
      effective_encryption: describeEncryption(filePort, effectiveSecure),
      secure_auto_override: isKnownPort(filePort) && effectiveSecure !== fileSecure,
    };
  }
  return {
    mode: 'ethereal', source: 'none', host: '', port: 587, user: '', pass: '', secure: false, stored_secure: false, from: '',
    smtp_pass_set: false, effective_port: 587, effective_secure: false, effective_encryption: '未加密（測試模式）', secure_auto_override: false,
  };
}

async function getEtherealTransporter() {
  if (_etherealTransporter) return _etherealTransporter;
  const test = await nodemailer.createTestAccount();
  _etherealAccount = test;
  _etherealTransporter = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    auth: { user: test.user, pass: test.pass },
  });
  console.log('[mailer] ethereal 測試帳號:', test.user, '(密碼自動隱藏)');
  return _etherealTransporter;
}

async function getTransporter() {
  const mailCfg = getMailConfig();
  if (mailCfg.mode === 'smtp' && mailCfg.host) {
    const port = mailCfg.port || 587;
    const secure = !!mailCfg.secure;
    const options = {
      host: mailCfg.host,
      port,
      secure,
      auth: mailCfg.user ? { user: mailCfg.user, pass: mailCfg.pass } : undefined,
    };
    // STARTTLS 連接埠（587/25/2525）強制加密，避免明文外洩（secure=false 時有意義）
    if (!secure && KNOWN_STARTTLS_PORTS.includes(port)) {
      options.requireTLS = true;
    }
    return nodemailer.createTransport(options);
  }
  return await getEtherealTransporter();
}

/**
 * 寄送 PDF 附件給客戶
 * @param {object} opts
 * @param {string|string[]} opts.to          收件者
 * @param {string} opts.subject              主旨
 * @param {string} [opts.html]               HTML 內容（會附加預設抬頭）
 * @param {string} [opts.text]               純文字內容
 * @param {Array<{filename:string, content:Buffer}>} [opts.attachments] PDF 附件
 * @returns {Promise<{messageId:string, previewUrl:string|null}>}
 */
/** 轉義 HTML 特殊字元（防止可編輯頁尾文字破壞郵件 HTML 結構） */
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c: string) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c
  ));
}

async function sendMail(opts) {
  if (!opts.to) throw new Error('缺少收件者 (to)');
  const mailCfg = getMailConfig();
  const fromAddr = mailCfg.from || `"輔凰商貿系統" <noreply@mingjhong.local>`;

  // 頁尾文字：可由「郵件設定」UI 編輯（parameters.group_name='mail', key='mail_footer'）；
  // 預設帶系統名稱，避免回退到舊的「輔凰商貿 ERP」。
  let footerText = '本郵件由 輔凰商貿系統 自動寄出。';
  try {
    const row = db.prepare("SELECT value FROM parameters WHERE group_name='mail' AND key='mail_footer'").get();
    if (row && row.value && String(row.value).trim()) footerText = String(row.value).trim();
  } catch (e) { /* 使用預設值 */ }

  const html = (opts.html || opts.text || '')
    + '<br><br><hr><small style="color:#888">' + escapeHtml(footerText) + '</small>';

  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from: fromAddr,
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: opts.subject || '(無主旨)',
    text: opts.text,
    html,
    attachments: (opts.attachments || []).map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType || 'application/pdf',
    })),
  });

  // ethereal 提供預覽 URL（測試模式才會有）
  const previewUrl = nodemailer.getTestMessageUrl(info);

  return {
    messageId: info.messageId,
    previewUrl,
    accepted: info.accepted,
    envelope: info.envelope,
    isEthereal: mailCfg.mode === 'ethereal',
    mode: mailCfg.mode,
    source: mailCfg.source,
  };
}

/**
 * 發送測試郵件（用於「郵件設定」頁面的測試按鈕）
 * @param {string} to 測試收件者
 * @returns {Promise<{ok:boolean, configured:boolean, messageId?:string, previewUrl?:string, error?:string}>}
 */
async function sendTestMail(to) {
  const mailCfg = getMailConfig();
  if (mailCfg.mode !== 'smtp' || !mailCfg.host) {
    return { ok: false, configured: false, error: 'SMTP 尚未設定完整（需填寫 host / user / 寄件者 from）' };
  }
  try {
    const result = await sendMail({
      to,
      subject: '【輔凰商貿系統】SMTP 設定測試郵件',
      html: `<p>您好，</p>
             <p>這是一封來自「輔凰商貿系統」的測試郵件。</p>
             <p>若您收到此郵件，表示 SMTP 郵件伺服器設定已正確運作。</p>
             <p><b>測試資訊：</b></p>
             <ul>
               <li>SMTP Host：${mailCfg.host}</li>
               <li>SMTP Port：${mailCfg.port}</li>
               <li>加密方式：${mailCfg.effective_encryption || (mailCfg.secure ? 'SSL/TLS' : 'STARTTLS/未加密')}</li>
               <li>寄件者：${mailCfg.from || '(未設定)'}</li>
               <li>設定來源：${mailCfg.source === 'db' ? '資料庫（UI 設定）' : 'config.json'}</li>
               <li>測試時間：${new Date().toLocaleString('zh-TW')}</li>
             </ul>
             <p style="color:#888;font-size:12px">此郵件由系統自動寄出，請勿直接回覆。</p>`,
    });
    return { ok: true, configured: true, messageId: result.messageId, previewUrl: result.previewUrl };
  } catch (e) {
    return { ok: false, configured: true, error: e.message };
  }
}

/**
 * 取得當前 ethereal 帳號（給前端顯示測試連結用）
 *
 * 【2026-09-10 健檢修正 P2-1】
 *   原本無條件 await getEtherealTransporter()：若 nodemailer.createTestAccount() 失敗
 *   （例如無外網）會直接拋錯，且當 getMailConfig() 其實是 smtp 模式時會回傳 null。
 *   改為：建立失敗時回傳 null，由呼叫端優雅降級（不再噴 500）。
 */
async function getEtherealInfo() {
  const mailCfg = getMailConfig();
  if (mailCfg.mode !== 'ethereal') return null;
  try {
    await getEtherealTransporter();
  } catch (e) {
    console.warn('[mailer] 建立 ethereal 測試帳號失敗（將以未設定處理）：' + e.message);
    return null;
  }
  return _etherealAccount;
}

export { sendMail, sendTestMail, getEtherealInfo, getMailConfig, resolveSecure, describeEncryption, isKnownPort };
