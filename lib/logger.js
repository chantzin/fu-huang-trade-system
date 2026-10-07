// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.installGlobalHandlers = installGlobalHandlers;
/**
 * 檔案日誌：包裝 console（既有呼叫點一行都不用改）→ 每日一檔 logs/app-YYYY-MM-DD.log
 * 必須在 server.js 最早期掛載，否則初始化錯誤捕不到。
 */
const fs = require('fs');
const path = require('path');
const { cfg } = require('./config');
const DIR = (cfg.log && cfg.log.dir) || path.join(__dirname, '..', 'logs');
const KEEP_DAYS = Number((cfg.log && cfg.log.keepDays) || 14);
if (!fs.existsSync(DIR)) {
    try {
        fs.mkdirSync(DIR, { recursive: true });
    }
    catch { /* ignore */ }
}
function pad(n) { return String(n).padStart(2, '0'); }
function file() {
    const d = new Date();
    return path.join(DIR, `app-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`);
}
/** Error 物件的屬性不可枚舉，JSON.stringify 會得到 {}，必須特判 */
function fmt(a) {
    if (a instanceof Error)
        return `${a.name || 'Error'}: ${a.message}${a.stack ? '\n' + a.stack : ''}`;
    if (typeof a === 'string')
        return a;
    try {
        return JSON.stringify(a);
    }
    catch {
        return String(a);
    }
}
function write(level, args) {
    const d = new Date();
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const line = `[${ts}] [${level}] ${Array.from(args).map(fmt).join(' ')}\n`;
    try {
        fs.appendFileSync(file(), line, 'utf8');
    }
    catch { /* ignore */ }
}
const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
console.log = (...a) => { write('INFO', a); orig.log(...a); };
console.info = (...a) => { write('INFO', a); orig.info(...a); };
console.warn = (...a) => { write('WARN', a); orig.warn(...a); };
console.error = (...a) => { write('ERROR', a); orig.error(...a); };
/** 每日清理過期日誌 */
function sweep() {
    try {
        const cutoff = Date.now() - KEEP_DAYS * 86400000;
        for (const f of fs.readdirSync(DIR)) {
            const p = path.join(DIR, f);
            if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(f))
                continue;
            if (fs.statSync(p).mtimeMs < cutoff)
                fs.unlinkSync(p);
        }
    }
    catch { /* ignore */ }
}
sweep();
/** 未捕捉例外 → 落檔後交 watchdog 重啟（維持 fail-fast，不吞例外） */
function installGlobalHandlers() {
    process.on('uncaughtException', (err) => {
        write('FATAL', ['uncaughtException', err]);
        process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
        write('FATAL', ['unhandledRejection', reason]);
    });
}
