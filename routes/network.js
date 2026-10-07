'use strict';
/**
 * 網路設定 API（管理者自助設定內部 IP / 對外固定 IP / HTTPS / 憑證 / 允許網段）
 * ───────────────────────────────────────────────────────────────────────────
 * 設計目標：售予客戶後，客戶依自身網路環境自助設定，且「設完不會把自己鎖死」。
 *
 * 端點：
 *   GET  /api/network/status          本機網卡 / 目前設定 / 憑證資訊 / 待確認 / 建議網段
 *   POST /api/network/apply           驗證 + 快照 + 寫 config + 待確認重啟（5 分自動回滾）
 *   POST /api/network/confirm         確認套用（清除待確認標記，正式生效）
 *   POST /api/network/cancel          取消並復原快照 + 重啟
 *   POST /api/network/test-connection 模擬某組 CIDR 是否允許指定 IP（防鎖死預檢）
 *   POST /api/network/cert-generate   產生自簽憑證（寫入 <app>/certs/，不改 config）
 *
 * 安全：requireSuperAdmin（供應商專屬，與授權匯入相同模式）。config 寫入 <app>/dist-server/config.json（與 lib/config.js 同源）。
 * 重啟：寫 _restart.flag + 對自身 SIGTERM，看門狗 500ms 重生讀新 config。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const forge = require('./forge.vendor');

// 此 forge 組建在 Node 下無法自動偵測隨機源，強制委派 Node CSPRNG（金鑰產生必須）
if (forge.random && forge.random.getBytesSync) {
  forge.random.getBytesSync = (n) => crypto.randomBytes(n).toString('binary');
  forge.random.getBytes = (n, cb) => {
    try { const b = crypto.randomBytes(n).toString('binary'); if (cb) cb(null, b); return b; }
    catch (e) { if (cb) cb(e); else throw e; }
  };
}

const { requireAuth, requireSuperAdmin } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireSuperAdmin);

// 本檔執行期位於 <app>/dist-server/routes，故往上兩層為 <app>
const APP_ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(APP_ROOT, 'dist-server', 'config.json');
const CERT_DIR = path.join(APP_ROOT, 'certs');
const SNAPSHOT_PATH = path.join(APP_ROOT, '_network_snapshot.json');
const PENDING_PATH = path.join(APP_ROOT, '_network_pending.json');
const ROLLBACK_MS = 5 * 60 * 1000; // 5 分鐘待確認視窗

/* ---------------- 工具 ---------------- */
function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
function writeConfig(c) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), 'utf8');
}
function toInt(ip) {
  if (!ip || ip.indexOf('.') < 0) return null;
  const p = ip.split('.').map((x) => parseInt(x, 10));
  if (p.length !== 4 || p.some((x) => isNaN(x) || x < 0 || x > 255)) return null;
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}
function isValidCidr(s) {
  if (typeof s !== 'string') return false;
  const m = s.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (!m) return false;
  if (toInt(m[1]) === null) return false;
  const bits = parseInt(m[2], 10);
  return bits >= 0 && bits <= 32;
}
function cidrContains(cidr, ip) {
  const n = toInt(ip);
  if (n === null) return false;
  const mm = cidr.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (!mm) return false;
  const base = toInt(mm[1]);
  const bits = parseInt(mm[2], 10);
  if (base === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (((1 << bits) - 1) << (32 - bits)) >>> 0;
  return (n & mask) === (base & mask);
}
function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '0:0:0:0:0:0:0:1' || ip.startsWith('::ffff:127.0.0.1');
}
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  let ip = xff ? String(xff).split(',')[0].trim() : (req.socket && req.socket.remoteAddress) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}
function localInterfaces() {
  const ni = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(ni)) {
    for (const ni2 of ni[name]) {
      if (ni2.family === 'IPv4') {
        out.push({ name, family: 'IPv4', address: ni2.address, internal: !!ni2.internal });
      }
    }
  }
  return out;
}
function suggestCidrs() {
  const out = [];
  for (const i of localInterfaces()) {
    if (i.internal) continue;
    const p = i.address.split('.').map(Number);
    out.push(`${p[0]}.${p[1]}.${p[2]}.0/24`);
  }
  return Array.from(new Set(out));
}
function certInfo(certFile) {
  try {
    if (!certFile || !fs.existsSync(certFile)) return null;
    const c = forge.pki.certificateFromPem(fs.readFileSync(certFile, 'utf8'));
    const san = [];
    const ext = c.getExtension('subjectAltName');
    if (ext && ext.altNames) {
      for (const a of ext.altNames) {
        if (a.type === 2) san.push('DNS:' + a.value);
        else if (a.type === 7) {
          try { san.push('IP:' + (a.ip || '')); } catch { /* ignore */ }
        }
      }
    }
    return {
      subject: c.subject.getField('CN') ? c.subject.getField('CN').value : '(無 CN)',
      issuer: c.issuer.getField('CN') ? c.issuer.getField('CN').value : '(無 CN)',
      validFrom: c.validity.notBefore.toISOString(),
      validTo: c.validity.notAfter.toISOString(),
      serial: c.serialNumber,
      san,
      selfSigned: c.subject.hash === c.issuer.hash,
    };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

/* ---------------- 憑證產生 ---------------- */
function parseSanEntry(s) {
  s = String(s || '').trim();
  if (!s) return null;
  if (s.startsWith('DNS:')) return { type: 2, value: s.slice(4).trim() };
  if (s.startsWith('IP:')) return { type: 7, ip: s.slice(3).trim() };
  if (toInt(s) !== null) return { type: 7, ip: s };
  return { type: 2, value: s };
}
function generateCert({ commonName, san, days }) {
  const pki = forge.pki;
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(8).toString('hex');
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + (Number(days) || 3650) * 86400000);
  const cn = commonName || 'localhost';
  const attrs = [
    { name: 'commonName', value: cn },
    { name: 'organizationName', value: cn },
    { name: 'countryName', value: 'TW' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  const altNames = (san || []).map(parseSanEntry).filter(Boolean);
  if (altNames.length === 0) altNames.push({ type: 2, value: cn });
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    { name: 'subjectAltName', altNames },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: pki.certificateToPem(cert),
    keyPem: pki.privateKeyToPem(keys.privateKey),
  };
}

/* ---------------- 重啟 / 回滾 ---------------- */
function triggerRestart() {
  try { fs.writeFileSync(path.join(APP_ROOT, '_restart.flag'), new Date().toISOString()); } catch { /* ignore */ }
  // 回應送出後再結束自身，看門狗 500ms 重生並讀取新 config
  setTimeout(() => { try { process.kill(process.pid, 'SIGTERM'); } catch { /* ignore */ } }, 1500);
}
function rollbackNow() {
  try {
    if (fs.existsSync(SNAPSHOT_PATH)) {
      const snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
      writeConfig(snap);
    }
    if (fs.existsSync(PENDING_PATH)) fs.unlinkSync(PENDING_PATH);
  } catch (e) { /* ignore */ }
  triggerRestart();
}
function scheduleRollback(expiresAt) {
  const ms = Math.max(0, expiresAt - Date.now());
  setTimeout(() => {
    try { if (fs.existsSync(PENDING_PATH)) rollbackNow(); } catch { /* ignore */ }
  }, ms);
}
// 啟動時若仍有待確認標記（apply 當下的重啟後），重新掛載回滾計時
(function armOnBoot() {
  try {
    if (fs.existsSync(PENDING_PATH)) {
      const p = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
      if (p.expiresAt && Date.now() >= p.expiresAt) rollbackNow();
      else scheduleRollback(p.expiresAt);
    }
  } catch { /* ignore */ }
})();

/* ---------------- 路由 ---------------- */
// 狀態
router.get('/status', (req, res) => {
  try {
    const c = readConfig();
    const https = c.https || {};
    const sec = c.security || {};
    let pending = null;
    if (fs.existsSync(PENDING_PATH)) {
      try {
        const p = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'));
        pending = {
          appliedAt: p.appliedAt,
          expiresAt: p.expiresAt,
          remainingMs: Math.max(0, p.expiresAt - Date.now()),
        };
      } catch { pending = null; }
    }
    res.json({
      current: {
        https: { enabled: !!https.enabled, port: https.port || 5443 },
        security: {
          httpLocalOnly: sec.httpLocalOnly !== false,
          allowedRemoteCidrs: sec.allowedRemoteCidrs || [],
        },
      },
      localInterfaces: localInterfaces(),
      suggestedCidrs: suggestCidrs(),
      cert: certInfo(https.certFile),
      pending,
      rollbackSeconds: ROLLBACK_MS / 1000,
      clientIp: clientIp(req),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 連線測試（防鎖死預檢）：給定 CIDR 清單與目標 IP，回傳是否允許
router.post('/test-connection', (req, res) => {
  try {
    const body = req.body || {};
    const list = Array.isArray(body.cidrs) ? body.cidrs.map(String) : [];
    const target = (body.ip && String(body.ip).trim()) || clientIp(req);
    const bad = list.filter((c) => !isValidCidr(c));
    if (bad.length) return res.status(400).json({ error: '無效的 CIDR：' + bad.join(', ') });
    const enabled = body.enabled !== false;
    const httpLocalOnly = body.httpLocalOnly !== false;
    let allowed = isLoopback(target);
    if (!allowed) {
      allowed = enabled && list.some((c) => cidrContains(c, target));
    }
    res.json({
      ip: target,
      allowed,
      reason: allowed
        ? (isLoopback(target) ? '本機回路，恆允許' : '該 IP 在允許清單內')
        : '該 IP 不在允許清單，套用後將無法由此 IP 連線',
      cidrs: list,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 產生自簽憑證（不改 config，僅寫入 <app>/certs/ 並回傳 PEM 供預覽/下載）
router.post('/cert-generate', (req, res) => {
  try {
    const body = req.body || {};
    const cn = (body.commonName && String(body.commonName).trim()) || '';
    if (!cn) return res.status(400).json({ error: '請填寫憑證名稱（CN，例如網域或主機名）' });
    fs.mkdirSync(CERT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const certPath = path.join(CERT_DIR, `selfsigned-${ts}.crt`);
    const keyPath = path.join(CERT_DIR, `selfsigned-${ts}.key`);
    const san = Array.isArray(body.san) ? body.san : [];
    const { certPem, keyPem } = generateCert({ commonName: cn, san, days: Number(body.days) || 3650 });
    fs.writeFileSync(certPath, certPem, 'utf8');
    fs.writeFileSync(keyPath, keyPem, 'utf8');
    try { fs.chmodSync(keyPath, 0o600); } catch { /* ignore */ }
    const fp = crypto.createHash('sha256').update(certPem).digest('hex').toUpperCase().replace(/(.{2})/g, '$1:').slice(0, -1);
    res.json({
      ok: true,
      certPath,
      keyPath,
      certPem,
      keyPem,
      fingerprint: fp,
      message: '自簽憑證已產生。請將 .crt 匯入客戶端「信任的根憑證授權單位」，再點擊「套用」。',
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 套用設定（含快照 + 待確認回滾）
router.post('/apply', (req, res) => {
  try {
    const body = req.body || {};
    const https = body.https || {};
    const security = body.security || {};

    // 驗證 HTTPS 連接埠
    const port = Number(https.port);
    if (!port || port < 1 || port > 65535) {
      return res.status(400).json({ error: 'HTTPS 連接埠必須為 1–65535' });
    }
    const enabled = !!https.enabled;

    // 驗證 CIDR
    const cidrs = Array.isArray(security.allowedRemoteCidrs)
      ? security.allowedRemoteCidrs.map(String)
      : [];
    const bad = cidrs.filter((c) => !isValidCidr(c));
    if (bad.length) return res.status(400).json({ error: '無效的 CIDR：' + bad.join(', ') });
    const httpLocalOnly = security.httpLocalOnly !== false;

    // 防鎖死：若啟用本機限制且目前連線為遠端，且新設定下無法連線 → 拒絕
    const ip = clientIp(req);
    if (httpLocalOnly && !isLoopback(ip)) {
      const canConnect = enabled && cidrs.some((c) => cidrContains(c, ip));
      if (!canConnect) {
        return res.status(409).json({
          error:
            '此設定會切斷您目前的連線（您的 IP ' + ip + ' 套用後將無法連線）。' +
            '請改由本機操作，或先將該 IP 加入允許清單後再套用。',
        });
      }
    }

    // 憑證處理
    let certFile = null;
    let keyFile = null;
    if (enabled) {
      const mode = body.certMode || 'keep';
      if (mode === 'keep') {
        const cur = readConfig();
        certFile = (cur.https && cur.https.certFile) || null;
        keyFile = (cur.https && cur.https.keyFile) || null;
        if (!certFile || !keyFile || !fs.existsSync(certFile)) {
          return res.status(400).json({ error: '目前無可用憑證，請先「產生自簽憑證」或「上傳憑證」。' });
        }
      } else if (mode === 'generate') {
        if (!body.certPath || !body.keyPath) {
          return res.status(400).json({ error: '請先產生自簽憑證（certPath/keyPath 缺失）。' });
        }
        if (!fs.existsSync(body.certPath) || !fs.existsSync(body.keyPath)) {
          return res.status(400).json({ error: '憑證檔案不存在，請重新產生。' });
        }
        certFile = body.certPath;
        keyFile = body.keyPath;
      } else if (mode === 'upload') {
        if (!body.certPem || !body.keyPem) {
          return res.status(400).json({ error: '請上傳憑證（certPem/keyPem）。' });
        }
        fs.mkdirSync(CERT_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        certFile = path.join(CERT_DIR, `uploaded-${ts}.crt`);
        keyFile = path.join(CERT_DIR, `uploaded-${ts}.key`);
        fs.writeFileSync(certFile, String(body.certPem), 'utf8');
        fs.writeFileSync(keyFile, String(body.keyPem), 'utf8');
        try { fs.chmodSync(keyFile, 0o600); } catch { /* ignore */ }
      } else {
        return res.status(400).json({ error: '未知的憑證模式：' + mode });
      }
    }

    // 快照現有 config + 寫入新 config
    const cur = readConfig();
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(cur, null, 2), 'utf8');
    const next = JSON.parse(JSON.stringify(cur));
    next.https = Object.assign({}, next.https, {
      enabled,
      port,
      certFile: certFile || '',
      keyFile: keyFile || '',
    });
    next.security = Object.assign({}, next.security, {
      httpLocalOnly,
      allowedRemoteCidrs: cidrs,
    });
    writeConfig(next);

    // 寫入待確認標記（供 confirm / 自動回滾使用）
    const expiresAt = Date.now() + ROLLBACK_MS;
    fs.writeFileSync(
      PENDING_PATH,
      JSON.stringify({
        appliedAt: Date.now(),
        expiresAt,
        by: (req.user && (req.user.emp_id || req.user.username)) || 'admin',
      }, null, 2),
      'utf8'
    );

    try { require('../lib/audit').log && require('../lib/audit').log({ action: 'network.apply', meta: { port, enabled, cidrs } }); } catch { /* ignore */ }

    // 先回應，再重啟（看門狗重生讀新 config）
    res.json({
      ok: true,
      pending: true,
      expiresAt,
      message:
        '設定已套用，系統將重新啟動。請於 ' + (ROLLBACK_MS / 60000) +
        ' 分鐘內，從「其他裝置」重新登入並點擊「確認套用」；若未確認，系統將自動復原原設定。',
    });
    triggerRestart();
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 確認套用
router.post('/confirm', (req, res) => {
  try {
    if (!fs.existsSync(PENDING_PATH)) {
      return res.json({ ok: true, committed: false, message: '目前無待確認的網路變更。' });
    }
    fs.unlinkSync(PENDING_PATH);
    if (fs.existsSync(SNAPSHOT_PATH)) fs.unlinkSync(SNAPSHOT_PATH);
    res.json({ ok: true, committed: true, message: '已確認套用，網路設定正式生效。' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 取消並復原
router.post('/cancel', (req, res) => {
  try {
    if (!fs.existsSync(PENDING_PATH)) {
      return res.json({ ok: true, rolledBack: false, message: '目前無待確認的網路變更。' });
    }
    rollbackNow(); // 內部會復原快照並重啟
    res.json({ ok: true, rolledBack: true, message: '已取消並復原原設定，系統重新啟動中。' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

module.exports = router;
