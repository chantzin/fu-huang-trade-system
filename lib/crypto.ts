// @ts-nocheck
'use strict';
/**
 * 加密工具函式（lib/crypto.js）
 *
 * 使用 AES-256-GCM 對稱式加密，用於保護敏感設定（如 SMTP 密碼）。
 *
 * 加密金鑰：
 *   - 優先從 config.json 的 security.encryptionKey 讀取
 *   - 若不存在，自動產生 32 位元組隨機金鑰並寫入 config.json
 *   - 金鑰格式：base64 編碼的 32 位元組
 *
 * 儲存格式：
 *   - 加密後字串格式：`v1:${ivBase64}:${authTagBase64}:${ciphertextBase64}`
 *   - 前綴 `v1:` 用於版本識別，未來可擴充其他加密演算法
 *   - 解密時自動偵測格式，若不是加密格式則視為明文（相容舊資料）
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM 建議 12 位元組
const KEY_LEN = 32; // 256 位元
const PREFIX = 'v1:';

/**
 * 取得或建立加密金鑰
 * @returns {Buffer} 32 位元組金鑰
 */
function getEncryptionKey() {
  const configPath = path.join(__dirname, '..', 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch { /* config.json 不存在或格式錯誤，使用預設 */ }

  if (cfg.security && cfg.security.encryptionKey) {
    try {
      const key = Buffer.from(cfg.security.encryptionKey, 'base64');
      if (key.length === KEY_LEN) return key;
      console.warn('[crypto] encryptionKey 長度不正確，重新產生');
    } catch {
      console.warn('[crypto] encryptionKey 格式錯誤，重新產生');
    }
  }

  // 自動產生新金鑰
  const newKey = crypto.randomBytes(KEY_LEN);
  cfg.security = cfg.security || {};
  cfg.security.encryptionKey = newKey.toString('base64');
  try {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
    console.log('[crypto] 已自動產生加密金鑰並寫入 config.json');
  } catch (e) {
    console.warn('[crypto] 無法寫入 config.json（金鑰僅存在於記憶體，重啟後需重新設定密碼）：' + e.message);
  }
  return newKey;
}

// 快取金鑰（避免每次加密/解密都讀取檔案）
let _cachedKey = null;
function getKey() {
  if (!_cachedKey) _cachedKey = getEncryptionKey();
  return _cachedKey;
}

/**
 * 加密純文字
 * @param {string} plaintext - 要加密的字串
 * @returns {string} 加密後的字串（格式：v1:iv:authTag:ciphertext）
 */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return '';
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  let encrypted = cipher.update(String(plaintext), 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();
  return PREFIX +
    iv.toString('base64') + ':' +
    authTag.toString('base64') + ':' +
    encrypted.toString('base64');
}

/**
 * 解密字串
 * @param {string} ciphertext - 加密後的字串（格式：v1:iv:authTag:ciphertext）
 * @returns {string|null} 解密後的純文字；若不是加密格式則回傳原文；若解密失敗回傳 null
 */
function decrypt(ciphertext) {
  if (ciphertext == null || ciphertext === '') return '';
  const str = String(ciphertext);

  // 若不是加密格式，視為明文（相容舊資料）
  if (!str.startsWith(PREFIX)) return str;

  try {
    const parts = str.slice(PREFIX.length).split(':');
    if (parts.length !== 3) return null;
    const [ivB64, authTagB64, dataB64] = parts;
    const key = getKey();
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const encrypted = Buffer.from(dataB64, 'base64');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    console.warn('[crypto] 解密失敗：' + e.message);
    return null;
  }
}

/**
 * 檢查字串是否為加密格式
 * @param {string} str - 要檢查的字串
 * @returns {boolean}
 */
function isEncrypted(str) {
  return typeof str === 'string' && str.startsWith(PREFIX);
}

export { encrypt, decrypt, isEncrypted };
