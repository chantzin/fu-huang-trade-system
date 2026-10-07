// lib/crypto.js 單元測試（AES-256-GCM 加密工具）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

// 測試變數（在 beforeAll 中動態 import 後設定）
let encrypt, decrypt, isEncrypted;
let configBackup = null;

beforeAll(async () => {
  // 備份原 config.json
  if (fs.existsSync(CONFIG_PATH)) {
    configBackup = fs.readFileSync(CONFIG_PATH, 'utf8');
  }
  // 建立測試用 config.json（含固定加密金鑰，確保測試可重現）
  const testConfig = {
    port: 5200,
    security: {
      encryptionKey: Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex').toString('base64'),
    },
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(testConfig, null, 2), 'utf8');

  // 清除 require 快取（CommonJS 模組），確保使用新的 config
  const cryptoModPath = path.resolve(__dirname, '..', '..', 'lib', 'crypto.js');
  delete require.cache[cryptoModPath];

  // 動態 import crypto 模組
  const mod = await import('../../lib/crypto.js');
  encrypt = mod.encrypt;
  decrypt = mod.decrypt;
  isEncrypted = mod.isEncrypted;
});

afterAll(() => {
  // 還原 config.json
  if (configBackup !== null) {
    fs.writeFileSync(CONFIG_PATH, configBackup, 'utf8');
  } else if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
  }
});

describe('crypto — AES-256-GCM 加密工具', () => {
  describe('encrypt()', () => {
    it('一般字串加密後回傳非空字串', () => {
      const result = encrypt('my-secret-password');
      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('加密後格式以 v1: 開頭', () => {
      const result = encrypt('test');
      expect(result.startsWith('v1:')).toBe(true);
    });

    it('加密後格式包含三個部分（iv:authTag:ciphertext）', () => {
      const result = encrypt('test');
      const parts = result.slice(3).split(':');
      expect(parts.length).toBe(3);
    });

    it('相同明文每次加密結果不同（隨機 IV）', () => {
      const r1 = encrypt('same-password');
      const r2 = encrypt('same-password');
      expect(r1).not.toBe(r2);
    });

    it('空字串回傳空字串', () => {
      expect(encrypt('')).toBe('');
    });

    it('null 回傳空字串', () => {
      expect(encrypt(null)).toBe('');
    });

    it('undefined 回傳空字串', () => {
      expect(encrypt(undefined)).toBe('');
    });

    it('特殊字元（中文/符號）可正常加密', () => {
      const result = encrypt('密碼!@#$%^&*()_+');
      expect(result.startsWith('v1:')).toBe(true);
    });

    it('長字串（1000 字元）可正常加密', () => {
      const longStr = 'a'.repeat(1000);
      const result = encrypt(longStr);
      expect(result.startsWith('v1:')).toBe(true);
    });
  });

  describe('decrypt()', () => {
    it('加密後解密可還原原文', () => {
      const original = 'my-secret-password-123';
      const encrypted = encrypt(original);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    it('中文內容加密解密一致', () => {
      const original = '這是一段中文密碼：測試@#$';
      const encrypted = encrypt(original);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    it('特殊符號加密解密一致', () => {
      const original = 'p@ssw0rd!#$%^&*()_+-=[]{}|;:,.<>?';
      const encrypted = encrypt(original);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(original);
    });

    it('空字串解密回傳空字串', () => {
      expect(decrypt('')).toBe('');
    });

    it('null 解密回傳空字串', () => {
      expect(decrypt(null)).toBe('');
    });

    it('非加密格式字串視為明文直接回傳（相容舊資料）', () => {
      const plain = 'old-plaintext-password';
      expect(decrypt(plain)).toBe(plain);
    });

    it('竄改密文後解密失敗回傳 null', () => {
      const encrypted = encrypt('secret');
      const tampered = encrypted.slice(0, -1) + (encrypted.slice(-1) === 'A' ? 'B' : 'A');
      const result = decrypt(tampered);
      expect(result).toBeNull();
    });

    it('格式錯誤（v1: 後只有兩部分）回傳 null', () => {
      const result = decrypt('v1:abc:def');
      expect(result).toBeNull();
    });

    it('多次加密解密結果一致', () => {
      const original = 'consistency-test';
      for (let i = 0; i < 5; i++) {
        const encrypted = encrypt(original);
        const decrypted = decrypt(encrypted);
        expect(decrypted).toBe(original);
      }
    });
  });

  describe('isEncrypted()', () => {
    it('加密格式回傳 true', () => {
      const encrypted = encrypt('test');
      expect(isEncrypted(encrypted)).toBe(true);
    });

    it('明文回傳 false', () => {
      expect(isEncrypted('plain-text')).toBe(false);
    });

    it('空字串回傳 false', () => {
      expect(isEncrypted('')).toBe(false);
    });

    it('null 回傳 false', () => {
      expect(isEncrypted(null)).toBe(false);
    });

    it('v1: 前綴但非完整格式仍回傳 true（只檢查前綴）', () => {
      expect(isEncrypted('v1:invalid')).toBe(true);
    });
  });

  describe('整合測試 — 加密解密循環', () => {
    it('SMTP 密碼場景：一般 Email 密碼', () => {
      const smtpPass = 'my-smtp-app-password-2024';
      const stored = encrypt(smtpPass);
      const retrieved = decrypt(stored);
      expect(retrieved).toBe(smtpPass);
      expect(stored).not.toContain(smtpPass);
    });

    it('SMTP 密碼場景：含特殊字元的 Gmail 應用程式密碼', () => {
      const smtpPass = 'abcd efgh ijkl mnop';
      const stored = encrypt(smtpPass);
      const retrieved = decrypt(stored);
      expect(retrieved).toBe(smtpPass);
    });

    it('舊版明文密碼相容：DB 中存的是明文，解密後仍可使用', () => {
      const oldPlainPass = 'old-plain-smtp-password';
      const retrieved = decrypt(oldPlainPass);
      expect(retrieved).toBe(oldPlainPass);
    });
  });
});
