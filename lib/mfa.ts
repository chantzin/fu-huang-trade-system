// @ts-nocheck
'use strict';
/**
 * MFA — TOTP 二階段驗證（RFC 6238 / RFC 4226，純 Node crypto 實作，免外部依賴）
 *   - generateSecret()：產生 base32 密鑰（供 Authenticator App 掃描）
 *   - totp(secret)    ：算當前 6 位碼（step=30s）
 *   - verify(secret, code, {window})：容許前後各 window 個 30s 視窗，抗時鐘漂移
 *   - otpauthUrl(...) ：otpauth://  URI（含發行者/帳號/演算法/位數/週期）
 * 說明：本檔為 lib/mfa.js 的 TypeScript 來源，任何改動須與運行中的 lib/mfa.js 保持一致。
 */
const crypto = require('crypto');
const cryptoUtil = require('./crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = B32.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 產生一個新的 base32 密鑰（預設 20 bytes → 32 字元） */
function generateSecret(len = 20) {
  return base32Encode(crypto.randomBytes(len));
}

/** HOTP（RFC 4226） */
function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    buf[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (binary % 1000000).toString().padStart(6, '0');
}

/** TOTP（RFC 6238）：預設 6 位、30 秒週期 */
function totp(secret, opts = {}) {
  const step = opts.step || 30;
  const time = opts.time != null ? opts.time : Math.floor(Date.now() / 1000);
  const counter = Math.floor(time / step);
  return hotp(base32Decode(secret), counter);
}

/** 驗證使用者輸入的 code（容許前後 window 個週期，預設 1） */
function verify(secret, token, opts = {}) {
  if (!secret || !token) return false;
  const step = opts.step || 30;
  const window = opts.window == null ? 1 : opts.window;
  const time = opts.time != null ? opts.time : Math.floor(Date.now() / 1000);
  const counter = Math.floor(time / step);
  const t = String(token).replace(/\s/g, '');
  if (!/^\d{6}$/.test(t)) return false;
  for (let w = -window; w <= window; w++) {
    if (hotp(base32Decode(secret), counter + w) === t) return true;
  }
  return false;
}

/** 產生 otpauth:// URI（供 Authenticator App 掃描） */
function otpauthUrl({ issuer, account, secret, step = 30 }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(step),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * 加密 MFA 密鑰（轉調 lib/crypto 的 AES-256-GCM，v1: 前綴）。
 * 空值原樣回傳，避免把 NULL 寫成空加密串。
 */
function encryptSecret(plain) {
  if (plain == null || plain === '') return plain;
  return cryptoUtil.encrypt(plain);
}

/**
 * 解密 MFA 密鑰。
 * 相容舊明文（非 v1: 前綴者原樣回傳，lib/crypto.decrypt 已處理）；
 * 若解密失敗（如金鑰輪換異常）回傳 null，呼叫端須視為失效並由 admin 重發。
 */
function decryptSecret(cipher) {
  if (cipher == null || cipher === '') return cipher;
  return cryptoUtil.decrypt(cipher);
}

export {
  base32Encode, base32Decode, generateSecret, hotp, totp, verify, otpauthUrl,
  encryptSecret, decryptSecret,
};
