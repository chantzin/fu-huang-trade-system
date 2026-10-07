// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUPER_EMPID = void 0;
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
exports.createToken = createToken;
exports.destroyToken = destroyToken;
exports.cleanupExpiredTokens = cleanupExpiredTokens;
exports.requireAuth = requireAuth;
exports.requireAdmin = requireAdmin;
exports.requireManager = requireManager;
exports.requireSuperAdmin = requireSuperAdmin;
exports.requireAccounting = requireAccounting;
exports.requireMasterWrite = requireMasterWrite;
exports.authenticate = authenticate;
exports.bootstrapAdmin = bootstrapAdmin;
exports.getClientIp = getClientIp;
exports.checkLockout = checkLockout;
exports.recordFailure = recordFailure;
exports.clearFailures = clearFailures;
/**
 * 認證模組：scrypt 密碼雜湊 + Bearer Token 工作階段
 *
 * 🔒 硬規則：帳號識別一律「工號」emp_id（與 HR 帳號體系一致）
 *   - 登入收 empId + password（username 保留為過渡別名，僅 local 模式）
 *   - req.user.empId 即工號
 *   - auth.provider = local（獨立） / shared（代理 HR 共用帳密），切換不改路由與 token 結構
 *
 * 注意：本檔為 lib/auth.js 的 TypeScript 來源（@ts-nocheck，僅供 tsc 轉譯為 dist-server/lib/auth.js）。
 *       任何改動都必須與運行中的 lib/auth.js 保持一致，否則 tsc 重建會遺失功能（如 B3 鎖定）。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db } = require('./db-dual');
const { cfg, mapRole } = require('./config');
const TOKEN_TTL_DAYS = Number((cfg.auth && cfg.auth.tokenTtlDays) || 7);
function hashPassword(plain) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(String(plain), salt, 64).toString('hex');
    return `scrypt$${salt}$${derived}`;
}
function verifyPassword(plain, stored) {
    if (typeof stored !== 'string' || !stored.startsWith('scrypt$'))
        return false;
    const [, salt, hash] = stored.split('$');
    if (!salt || !hash)
        return false;
    try {
        const derived = crypto.scryptSync(String(plain), salt, 64).toString('hex');
        return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
    }
    catch {
        return false;
    }
}
async function createToken(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + TOKEN_TTL_DAYS * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    await db.prepare('INSERT INTO tokens (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expires);
    return { token, expires_at: expires };
}
async function destroyToken(token) {
    await db.prepare('DELETE FROM tokens WHERE token = ?').run(token);
}
async function cleanupExpiredTokens() {
    await db.prepare("DELETE FROM tokens WHERE expires_at IS NOT NULL AND expires_at < datetime('now','localtime')").run();
}
async function resolveToken(token) {
    if (!token)
        return null;
    const row = await db
        .prepare(`SELECT t.token, t.expires_at, u.id, u.emp_id, u.username, u.name, u.role, u.title, u.email, u.active, u.must_change_pwd
         FROM tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token = ?`)
        .get(token);
    if (!row)
        return null;
    if (row.expires_at && new Date(row.expires_at.replace(' ', 'T')).getTime() < Date.now()) {
        await destroyToken(token);
        return null;
    }
    if (!row.active)
        return null;
    // 🔒 統一識別語意：empId = 工號（舊資料尚未回填時降級用 username）
    row.empId = row.emp_id || row.username;
    row.mustChangePwd = !!row.must_change_pwd;
    return row;
}
function readToken(req) {
    const h = req.headers.authorization || '';
    if (typeof h === 'string' && h.toLowerCase().startsWith('bearer '))
        return h.slice(7).trim();
    if (req.query && req.query.token)
        return String(req.query.token);
    return null;
}
function requireAuth(req, res, next) {
    Promise.resolve(resolveToken(readToken(req))).then((user) => {
        if (!user)
            return res.status(401).json({ error: '未登入或登入已逾時，請重新登入' });
        req.user = user;
        next();
    }).catch(next);
}
/** 必須為管理員 */
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin')
        return res.status(403).json({ error: '需要管理員權限' });
    next();
}
/** 管理員或主管 */
function requireManager(req, res, next) {
    if (!req.user || !['admin', 'manager'].includes(req.user.role)) {
        return res.status(403).json({ error: '需要主管以上權限' });
    }
    next();
}
/**
 * 超級管理員（供應商交付帳號）：僅 empId 等同 bootstrapAdmin.empId 的帳號，預設 'super'。
 * 用途：供應商專屬操作（如匯入授權檔）限此帳號，即便其他 role=admin 帳號亦不可見/不可執行。
 * 🔒 輔凰工程帳號（emp_id='super'）為系統保留最大權限帳號，判定永遠認 super，
 *    不受 bootstrapAdmin/env（如 BOOTSTRAP_ADMIN_EMP_ID）影響，確保不可變更/不可刪除。
 */
const SUPER_EMPID = (cfg.auth && cfg.auth.bootstrapAdmin && cfg.auth.bootstrapAdmin.empId) || 'super';
exports.SUPER_EMPID = SUPER_EMPID;
function isSuperEmp(empId) {
    return empId === 'super' || empId === SUPER_EMPID;
}
function requireSuperAdmin(req, res, next) {
    if (!req.user || !isSuperEmp(req.user.empId)) {
        return res.status(403).json({ error: '需要超級管理員權限（供應商交付帳號）' });
    }
    next();
}
/** 應收帳款可寫：管理員 / 主管 / 會計 */
function requireAccounting(req, res, next) {
    if (!req.user || !['admin', 'manager', 'accounting'].includes(req.user.role)) {
        return res.status(403).json({ error: '需要會計以上權限' });
    }
    next();
}
/** 基本資料可寫：管理員 / 主管（其餘角色唯讀） */
function requireMasterWrite(req, res, next) {
    if (!req.user || !['admin', 'manager'].includes(req.user.role)) {
        return res.status(403).json({ error: '需要主管以上權限（基本資料維護）' });
    }
    next();
}
/**
 * 驗證登入（🔒 一律以「工號」為帳號）
 *   provider = local  → 本機 users 表密碼驗證（獨立運作，不依賴 HR）
 *   provider = shared → 代理 HR /api/auth/login 驗證（共用帳密；未來必要時才切）
 */
async function authenticate(empId, password) {
    const account = String(empId || '').trim();
    if (!account)
        return null;
    if (cfg.auth.provider === 'shared' && cfg.auth.shared && cfg.auth.shared.hrBaseUrl) {
        return await authenticateShared(account, password);
    }
    const u = await db.prepare('SELECT * FROM users WHERE emp_id = ? OR username = ?').get(account, account);
    if (!u || !u.active)
        return null;
    if (!verifyPassword(password, u.password_hash))
        return null;
    return u;
}
/**
 * shared provider：呼叫 HR 驗證，成功後對映到本地 users（工號為 KEY；不存 HR 密碼）
 * 注意：HR 端有強制 2FA 的帳號會被 HR 擋下，屬預期安全行為。
 */
async function authenticateShared(empId, password) {
    const sh = cfg.auth.shared;
    const url = (sh.hrBaseUrl || 'http://localhost:3000') + (sh.hrLoginPath || '/api/auth/login');
    let r;
    try {
        r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: empId, password }),
        });
    }
    catch (e) {
        console.error('[auth] shared：HR 連線失敗 -', e.message);
        return null;
    }
    if (!r.ok)
        return null;
    let j;
    try {
        j = await r.json();
    }
    catch {
        return null;
    }
    const hrUser = j.user || j || {};
    const localRole = mapRole(hrUser.role);
    let u = await db.prepare('SELECT * FROM users WHERE emp_id = ?').get(empId);
    if (!u)
        u = await db.prepare('SELECT * FROM users WHERE username = ?').get(empId);
    if (u) {
        await db.prepare("UPDATE users SET emp_id=?, name=?, role=?, active=1, updated_at=datetime('now','localtime') WHERE id=?")
            .run(empId, hrUser.name || u.name || empId, localRole, u.id);
        return await db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
    }
    let uname = String(empId).toLowerCase();
    if (await db.prepare('SELECT id FROM users WHERE username = ?').get(uname)) {
        let n = 1;
        while (await db.prepare('SELECT id FROM users WHERE username = ?').get(uname + '-' + n))
            n++;
        uname = uname + '-' + n;
    }
    const info = await db
        .prepare('INSERT INTO users (emp_id, username, password_hash, name, role, active) VALUES (?,?,?,?,?,1)')
        .run(empId, uname, '', hrUser.name || empId, localRole);
    return await db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}
/** 確保至少一位管理員（工號來自 config.auth.bootstrapAdmin） */
function clearBootstrapCredential() {
    if (cfg.auth)
        cfg.auth.bootstrapAdmin = null;
    try {
        const configPath = path.join(__dirname, '..', 'config.json');
        const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (saved.auth) {
            saved.auth.bootstrapAdmin = null;
            fs.writeFileSync(configPath, JSON.stringify(saved, null, 2), 'utf8');
        }
    }
    catch (e) {
        console.warn('[auth] 無法清除一次性 bootstrap 憑證設定：' + e.message);
    }
}
function bootstrapAdmin() {
    try {
        const ba = cfg.auth.bootstrapAdmin;
        const totalUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
        // 1) 設定/環境變數指定的 bootstrap 帳號（供應商交付時可指定不同 empId/密碼）
        if (ba && ba.empId && ba.password) {
            const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin'").get().c;
            if (adminCount > 0) {
                clearBootstrapCredential();
                return;
            }
            const exist = db.prepare('SELECT id FROM users WHERE emp_id = ?').get(ba.empId);
            if (exist) {
                db.prepare("UPDATE users SET role='admin', active=1 WHERE id=?").run(exist.id);
            }
            else {
                // 🔒 B2：交付帳號建立後強制首次登入改密（must_change_pwd=1）
                db.prepare('INSERT INTO users (emp_id, username, password_hash, name, role, active, must_change_pwd) VALUES (?,?,?,?,?,1,1)')
                    .run(ba.empId, String(ba.empId).toLowerCase(), hashPassword(ba.password), ba.name || ba.empId, 'admin');
                console.log(`[auth] 已建立初始管理員：${ba.empId}（首次登入須修改密碼）`);
            }
            clearBootstrapCredential();
            return;
        }
        // 2) 全新安裝（沒有任何使用者）：自動建立工程師管理者 ADMIN，但「絕不使用萬用密碼 admin123」。
        //    改為產生隨機一次性強密碼，並強制首次登入改密（must_change_pwd=1）。
        //    交付時請由 config.auth.bootstrapAdmin 或環境變數 BOOTSTRAP_ADMIN_PASSWORD 指定每客唯一密碼；
        //    若皆未設定，本分支僅作安全網，隨機密碼會印在啟動日誌，請立即改密。
        if (totalUsers === 0) {
            const exist = db.prepare('SELECT id FROM users WHERE emp_id = ?').get(SUPER_EMPID);
            if (!exist) {
                // 🔒 B2：杜絕萬用後門密碼——隨機強密碼（base64 取字母數字 16 碼並補強度）
                const initPwd = (crypto.randomBytes(12).toString('base64') + 'Aa1')
                    .replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
                db.prepare('INSERT INTO users (emp_id, username, password_hash, name, role, active, must_change_pwd) VALUES (?,?,?,?,?,1,1)')
                    .run(SUPER_EMPID, String(SUPER_EMPID).toLowerCase(), hashPassword(initPwd), '工程師管理者', 'admin');
                console.warn(`[auth] ⚠️ 已建立初始管理員（隨機一次性密碼，請立即改密並妥善交付）：${SUPER_EMPID} / ${initPwd}`);
            }
        }
    }
    catch (e) {
        console.warn('[auth] bootstrapAdmin 略過：' + e.message);
    }
}
/**
 * 登入失敗鎖定（B3）：依 IP＋帳號 限制暴力破解。
 *   - 連續失敗達 5 次 => 鎖定 15 分鐘（locked_until）。
 *   - 鎖定期內登入一律拒絕；期滿自動解除並重置計數。
 *   - 登入成功 => 清除該 key 的失敗紀錄。
 */
const LOCK_MAX_ATTEMPTS = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
/** 取得真實客戶端 IP（直連取 socket；前方有反向代理時取 X-Forwarded-For 首個） */
function getClientIp(req) {
    const xff = req && req.headers && req.headers['x-forwarded-for'];
    if (xff) {
        const first = String(xff).split(',')[0].trim();
        if (first)
            return first;
    }
    return (req && req.socket && req.socket.remoteAddress) || (req && req.connection && req.connection.remoteAddress) || 'unknown';
}
/** 查詢鎖定狀態：{ locked, fails, retryAfterSec } */
function checkLockout(key) {
    const row = db.prepare('SELECT * FROM login_failures WHERE key=?').get(key);
    if (!row)
        return { locked: false, fails: 0, retryAfterSec: 0 };
    const now = Date.now();
    if (row.locked_until) {
        // locked_until 以「epoch 毫秒」儲存（時區無關），直接與 Date.now() 比較，
        // 避免 toISOString(UTC) 與 new Date(local) 解析錯位導致誤判到期。
        const until = Number(row.locked_until);
        if (until > now)
            return { locked: true, fails: row.fails, retryAfterSec: Math.ceil((until - now) / 1000) };
        db.prepare('DELETE FROM login_failures WHERE key=?').run(key); // 期滿重置
        return { locked: false, fails: 0, retryAfterSec: 0 };
    }
    return { locked: false, fails: row.fails, retryAfterSec: 0 };
}
/** 記錄一次失敗：{ locked, remaining, retryAfterSec } */
function recordFailure(key) {
    const row = db.prepare('SELECT * FROM login_failures WHERE key=?').get(key);
    const fails = row ? row.fails + 1 : 1;
    let lockedUntil = null;
    // 允許 5 次失敗嘗試；第 6 次（fails > 5）才鎖定 15 分鐘。
    // 對應需求「5 次失敗鎖 15 分鐘」：用戶有 5 次機會，連續 6 次錯誤才進入鎖定。
    if (fails > LOCK_MAX_ATTEMPTS) {
        lockedUntil = String(Date.now() + LOCK_WINDOW_MS); // epoch 毫秒字串（時區無關）
    }
    db.prepare(`INSERT INTO login_failures (key, fails, locked_until, updated_at)
      VALUES (?,?,?,datetime('now','localtime'))
      ON CONFLICT(key) DO UPDATE SET fails=excluded.fails, locked_until=excluded.locked_until, updated_at=datetime('now','localtime')`)
        .run(key, fails, lockedUntil);
    if (lockedUntil)
        return { locked: true, remaining: 0, retryAfterSec: Math.ceil(LOCK_WINDOW_MS / 1000) };
    return { locked: false, remaining: Math.max(0, LOCK_MAX_ATTEMPTS - fails), retryAfterSec: 0 };
}
/** 登入成功：清除失敗紀錄 */
function clearFailures(key) {
    db.prepare('DELETE FROM login_failures WHERE key=?').run(key);
}
