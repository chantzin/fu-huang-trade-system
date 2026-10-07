// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.TRIAL_DAYS = exports.TRIAL_SEATS = exports.LICENSE_PATH = void 0;
exports.loadState = loadState;
exports.isModuleEnabled = isModuleEnabled;
exports.seatsLimit = seatsLimit;
exports.isExpired = isExpired;
exports.getState = getState;
exports.verifyLicense = verifyLicense;
exports.reload = reload;
/**
 * 簽章授權檔（LIC）驗證層
 *  - 內嵌供應商公鑰，啟動時讀 <app>/license.lic（payload + RSA 簽章）並驗章。
 *  - 無檔 / 簽章錯 / 解析錯 => 「試用受限模式」（trial：2 席／30 天／全模組）。
 *    ⚠️ fail-closed：絕不再退回「全開放模式」，確保營收受保護。
 *    - trial 期間內：功能全開，但僅限 2 席；UI 顯示 trial 標章與到期日。
 *    - trial 期滿（30 天）=> 「expired 模式」：除安全路由外一律 403。
 *  - 授權到期 => 「expired 模式」：除安全路由外一律 403。
 *  - 私鑰僅供應商持有（見 scripts/gen-license.mjs），不公開、不進版控。
 *
 *  試用起始日持久化於 <app>/_trial_start.json（首次載入時寫入，重啟不漂移）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// 應用根：編譯後本檔位於 <app>/dist-server/lib/license.js，往上兩層為 app 根
const APP_ROOT = path.join(__dirname, '..', '..');
const LICENSE_PATH = process.env.LICENSE_PATH || path.join(APP_ROOT, 'license.lic');
exports.LICENSE_PATH = LICENSE_PATH;
// 試用起始日檔（避免重啟後試用期重新計算）
const TRIAL_START_PATH = process.env.TRIAL_START_PATH || path.join(APP_ROOT, '_trial_start.json');
// 試用受限模式參數（慈哥核准：2 席 / 30 天）
const TRIAL_SEATS = 2;
exports.TRIAL_SEATS = TRIAL_SEATS;
const TRIAL_DAYS = 30;
exports.TRIAL_DAYS = TRIAL_DAYS;
// 供應商公鑰（與私鑰 keys/lic_public.pem 成對；私鑰不進版控）
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3GQFHufQKw7qn2PToJsP
fxhLIUuMaB7F+1J0dArIP/JRnr9O4JYKTUw46rKl+yTd+SPZm5ONN81ihK7rcZ9I
qbkDZaxwAlOcximDAM6iVSNt2VJ2qkp75jykFHIY9MIGinlczddLcmg623vnaOSu
UsKNqKPHlGK46V2cHks9hP6g95uCVAK/vSN1WUct/a2I4Yne9OdnbjzyMkJAs8sC
9AUz/LkR5jvDM7prsj1kjBPjWBzUj/NJOJWHz6joW1P97c0L0sg29YFkwCEhEON1
C1aQuD25K82mgBfU7KOQjiVYESY07jqVcn9NFX5sda3l59iKbuLZFwLCIwk7Jwhq
uwIDAQAB
-----END PUBLIC KEY-----`;
// 裝置識別（installId）— 用於授權綁定比對。require 失敗時降級為「不綁定」以免阻斷載入。
let _getInstallInfo = () => ({ installId: '' });
try {
    ({ getInstallInfo: _getInstallInfo } = require('./install'));
}
catch (_) { /* install 模組不可用時不綁定 */ }
let _state = null;
/** 取得試用起始日（首次呼叫時寫入 _trial_start.json 並持久化） */
function getTrialStart() {
    try {
        if (fs.existsSync(TRIAL_START_PATH)) {
            const v = JSON.parse(fs.readFileSync(TRIAL_START_PATH, 'utf8'));
            if (v && typeof v.start === 'number')
                return v.start;
        }
    }
    catch (_) { /* 忽略，重新寫入 */ }
    const start = Date.now();
    try {
        fs.writeFileSync(TRIAL_START_PATH, JSON.stringify({ start }, null, 2), 'utf8');
    }
    catch (_) { /* 唯讀環境忽略 */ }
    return start;
}
/** 試用受限模式狀態（無授權檔／驗章失敗進入；過期轉 expired） */
function trialState(reason, tampered) {
    const start = getTrialStart();
    const expires = start + TRIAL_DAYS * 86400000;
    const now = Date.now();
    const expired = now > expires;
    return {
        valid: false,
        mode: expired ? 'expired' : 'trial',
        reason: expired ? 'TRIAL_EXPIRED' : (reason || 'TRIAL'),
        expired,
        tampered: !!tampered,
        license: {
            licensee: null,
            product: null,
            versionRange: null,
            plan: 'Trial',
            modules: ['*'],
            seats: TRIAL_SEATS,
            issuedAt: new Date(start).toISOString(),
            expiresAt: new Date(expires).toISOString(),
            binding: '',
        },
    };
}
/** 將授權檔 payload 物件轉為授權快照（lic） */
function buildLicense(p) {
    return {
        licensee: p.licensee,
        product: p.product,
        versionRange: p.version_range,
        plan: p.plan || '', // 授權方案（Trial / Starter / Professional ...），供 UI 標示
        modules: Array.isArray(p.modules) ? p.modules : [],
        seats: Number(p.seats) || 0, // 0 = 不限
        issuedAt: p.issued_at,
        expiresAt: p.expires_at,
        binding: p.binding || '',
    };
}
/** 由 lic 計算模式（licensed / expired）與原因 */
function computeState(lic) {
    const now = Date.now();
    const expired = lic.expiresAt && new Date(lic.expiresAt).getTime() < now;
    return { expired, mode: expired ? 'expired' : 'licensed', reason: expired ? 'EXPIRED' : 'OK' };
}
/**
 * 對「單一授權檔物件」做 RSA 公鑰驗章 + 過期檢查（不改快取）。
 * 回傳 { valid, reason, state }；state 為授權狀態快照（失敗時為試用受限模式 trial）。
 */
function verifyPayload(raw) {
    try {
        if (!raw || !raw.payload || !raw.signature)
            throw new Error('授權檔格式錯誤（缺少 payload/signature）');
        const data = Buffer.from(JSON.stringify(raw.payload), 'utf8');
        const sig = Buffer.from(String(raw.signature), 'base64');
        const ok = crypto.verify('sha256', data, PUBLIC_KEY, sig);
        // 驗章失敗：嚴格視為未授權 => 進入試用受限模式（tampered 標記）
        if (!ok)
            return { valid: false, reason: 'BAD_SIGNATURE', state: trialState('BAD_SIGNATURE', true) };
        const lic = buildLicense(raw.payload);
        const { expired, mode, reason } = computeState(lic);
        // 綁定比對（防盜用/防複製）：授權檔指定 binding 且與本機 installId 不符 → 視為無效（fail-closed）
        if (lic.binding) {
            const sysId = (_getInstallInfo().installId || '').trim();
            if (sysId && lic.binding !== sysId) {
                return { valid: false, reason: 'BINDING_MISMATCH', state: trialState('BINDING_MISMATCH', true) };
            }
        }
        return { valid: true, reason, state: { valid: true, mode, reason, expired, license: lic } };
    }
    catch (e) {
        return { valid: false, reason: 'PARSE_ERROR:' + e.message, state: trialState('PARSE_ERROR:' + e.message, true) };
    }
}
function loadState() {
    if (_state)
        return _state;
    let result;
    if (!fs.existsSync(LICENSE_PATH)) {
        result = trialState('NO_LICENSE_FILE');
        console.warn('[license] 未發現授權檔 license.lic，系統進入「試用受限模式」（2 席／30 天／全模組）。請聯絡供應商核發正式授權檔。');
        _state = result;
        return result;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(LICENSE_PATH, 'utf8'));
        const v = verifyPayload(raw);
        if (!v.valid) {
            // 驗章失敗：fail-closed，進入試用受限模式（標記 tampered）
            result = v.state;
            console.warn('[license] ⚠️ 授權檔驗證失敗（' + v.reason + '），系統進入「試用受限模式」。請聯絡供應商核發正確授權檔。');
            _state = result;
            return result;
        }
        result = v.state;
    }
    catch (e) {
        result = trialState('PARSE_ERROR:' + e.message, true);
        console.warn('[license] ⚠️ 授權檔解析失敗：', e.message, '（試用受限模式）');
    }
    _state = result;
    return result;
}
/**
 * 非快取驗證：對傳入的原始 .lic（物件或字串）做 RSA 公鑰驗章 + 過期檢查，
 * 不改變系統目前從磁碟載入的授權狀態。供「匯入授權」端點驗證上傳檔使用。
 */
function verifyLicense(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        }
        catch (e) {
            return { valid: false, reason: 'PARSE_ERROR:' + e.message, state: trialState('PARSE_ERROR:' + e.message, true) };
        }
    }
    return verifyPayload(parsed);
}
/** 清除快取，使下次 loadState() 重新讀取磁碟上的 license.lic（匯入生效後呼叫） */
function reload() {
    _state = null;
}
/** 模組是否授權：試用模式全開；licensed 模式查 modules（含 '*' 全開）；expired 全關 */
function isModuleEnabled(name) {
    const s = loadState();
    if (s.mode === 'trial')
        return true;
    if (s.mode === 'expired')
        return false;
    if (s.mode === 'licensed')
        return s.license.modules.includes('*') || s.license.modules.includes(name);
    return false;
}
/** 席次上限：試用模式 = 2；licensed 模式 seats（0 = 不限）；其餘 = 0 */
function seatsLimit() {
    const s = loadState();
    if (s.mode === 'trial')
        return TRIAL_SEATS;
    if (s.mode === 'licensed')
        return s.license.seats || 0;
    return 0;
}
function isExpired() {
    return loadState().mode === 'expired';
}
/** 供 UI / API 讀取的授權狀態快照 */
function getState() {
    const s = loadState();
    if (!s.license)
        return { valid: s.valid, mode: s.mode, reason: s.reason, tampered: s.tampered };
    const l = s.license;
    return {
        valid: s.valid,
        mode: s.mode,
        reason: s.reason,
        tampered: s.tampered,
        trial: s.mode === 'trial',
        trialSeats: TRIAL_SEATS,
        trialDays: TRIAL_DAYS,
        licensee: l.licensee,
        product: l.product,
        versionRange: l.versionRange,
        plan: l.plan,
        modules: l.modules,
        seats: l.seats,
        issuedAt: l.issuedAt,
        expiresAt: l.expiresAt,
        binding: l.binding,
        boundToThisDevice: l.binding ? ((_getInstallInfo().installId || '').trim() === l.binding) : null,
    };
}
