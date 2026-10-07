// @ts-nocheck

'use strict';

Object.defineProperty(exports, "__esModule", { value: true });

exports.runEtl = runEtl;

exports.runNow = runNow;

exports.runScheduled = runScheduled;

exports.lastResult = lastResult;

exports.startSched = startSched;

/**

 * MySQL 平行驗證線自動排程

 *

 * 行為：

 *   - runEtl()      LIVE SQLite → MySQL 同步（每日排程先跑，確保比對基準最新）

 *   - runNow()      執行 parity 比對（手動 API 用），回傳 {ok,passed,failed,...}

 *   - runScheduled() 先 ETL 再 parity（排程觸發，ETL 失敗也續跑 parity 留紀錄）

 *   - startSched()  server.js 開機呼叫（每日 cfg.parity.runHour 觸發）

 *   - lastResult()  讀最後一次 parity 結果（audit_logs）

 *

 * 用法：

 *   const parity = require('./parity');

 *   parity.startSched();                 // 開機排程（ETL+parity 鏈）

 *   const r = await parity.runNow();     // 手動立刻比對（管理員 API 用）

 *   const e = await parity.runEtl();     // 手動立刻同步

 *

 * 🔒 硬規則

 *   - 同時只能跑一個 process（檔案鎖 _parity.lock），防止 ETL/parity 重疊

 *   - 跑失敗不 throw，只回傳 ok:false 與錯誤訊息，避免干擾主流程

 *   - 結果寫 audit_logs，主動告知管理員 SQLite vs MySQL 是否對齊

 *   - ETL 與 parity 都以 DB_FILE（本 server 實際在用的 SQLite）為來源，

 *     不會搬運/比對到過期的 程式/data/trade.sqlite

 */

const { spawn } = require('child_process');

const path = require('path');

const fs = require('fs');

const { cfg } = require('./config');

const { db, DB_FILE } = require('./db');

const audit = require('./audit');

const ROOT = path.join(__dirname, '..');

// 程式_mysql 平行線固定位於專案根（./程式_mysql）。

// ⚠️ 注意：Source 的 app root 是 程式（parent=專案根，含 程式_mysql）；

//    但 LIVE 的 app root 是 <app_root>（parent 不含 程式_mysql）。

//    故不可用 ROOT/.. 推算，改採絕對路徑（可用 MYSQL_DIR 環境變數覆寫以利移植）。

const MYSQL_DIR = process.env.MYSQL_DIR || './程式_mysql';

const SCRIPT = path.join(MYSQL_DIR, 'scripts', 'check-mysql-parity.mjs');

const ETL_SCRIPT = path.join(MYSQL_DIR, 'scripts', 'etl-sqlite-to-mysql.mjs');

const LOCK = path.join(ROOT, '_parity.lock');

const TIMEOUT_MS = 5 * 60 * 1000; // 單支腳本上限 5 min

const LOCK_TTL_MS = 30 * 60 * 1000; // 鎖最長存活 30 min（防崩潰殘留卡死）

/** 取得最後一次 parity 結果（從 audit_logs） */

function lastResult() {

    try {

        const r = db.prepare("SELECT detail FROM audit_logs WHERE action='mysql_parity_check' ORDER BY id DESC LIMIT 1").get();

        return r ? safeParse(r.detail) : null;

    }

    catch {

        return null;

    }

}

function safeParse(s) { try {

    return JSON.parse(s);

}

catch {

    return null;

} }

/* ============================ 檔案鎖 ============================ */

function lockAge() {

    try {

        return Date.now() - fs.statSync(LOCK).mtimeMs;

    }

    catch {

        return Infinity;

    }

}

function acquireLock() {

    if (fs.existsSync(LOCK) && lockAge() < LOCK_TTL_MS)

        return false;

    try {

        fs.writeFileSync(LOCK, String(process.pid));

        return true;

    }

    catch {

        return false;

    }

}

function releaseLock() { try {

    fs.unlinkSync(LOCK);

}

catch { /* ignore */ } }

/**

 * 共用子程序呼叫：ETL 或 parity 腳本。

 * 強制以 DB_FILE（本 server 實際 DB）覆寫 APP_SQLITE，無論 server 如何啟動都比對正確來源。

 * @param {string} scriptPath 腳本絕對路徑

 * @returns {Promise<{ok:boolean,code:number,out:string,err:string|null,at:string}>}

 */

function spawnScript(scriptPath) {

    return new Promise((resolve) => {

        if (!fs.existsSync(scriptPath)) {

            return resolve({ ok: false, error: `找不到腳本：${scriptPath}（MySQL 平行線未建？）` });

        }

        let child;

        try {

            child = spawn(process.execPath, [scriptPath], {

                cwd: MYSQL_DIR,

                // 🔒 關鍵：無論 ETL 或 parity，來源一律是本 server 實際在用的 SQLite（DB_FILE）

                env: Object.assign({}, process.env, { APP_SQLITE: DB_FILE }),

                stdio: ['ignore', 'pipe', 'pipe'],

            });

        }

        catch (e) {

            // spawn 建構期就拋錯（如 DB_FILE 未定義）→ 直接回錯，鎖由呼叫方 finally 清理

            return resolve({ ok: false, error: `spawn 失敗：${e.message}` });

        }

        let out = '';

        let err = '';

        child.stdout.on('data', (b) => { out += b.toString(); });

        child.stderr.on('data', (b) => { err += b.toString(); });

        const timer = setTimeout(() => {

            try {

                child.kill();

            }

            catch { /* ignore */ }

            resolve({ ok: false, error: `逾時（5 min）`, out, err: err.trim() || null, at: new Date().toISOString() });

        }, TIMEOUT_MS);

        child.on('close', (code) => {

            clearTimeout(timer);

            resolve({

                ok: code === 0,

                code,

                out: out.trim(),

                err: err.trim() || null,

                at: new Date().toISOString(),

            });

        });

        child.on('error', (e) => {

            clearTimeout(timer);

            resolve({ ok: false, error: `spawn 失敗：${e.message}`, at: new Date().toISOString() });

        });

    });

}

/* ============================ ETL ============================ */

/** LIVE SQLite → MySQL 同步（每日排程先跑，確保 parity 比對基準最新） */

async function runEtl() {

    return spawnScript(ETL_SCRIPT);

}

/* ============================ Parity（手動 API） ============================ */

/** parity 比對一次（手動 API 用）。獨佔鎖，回傳 {ok,passed,failed,...} 相容舊路由 */

async function runNow() {

    if (!acquireLock()) {

        return { ok: false, error: `其他流程佔用鎖（${Math.round(lockAge() / 1000)}s 前啟動）` };

    }

    try {

        const r = await spawnScript(SCRIPT);

        const summary = buildParitySummary(r);

        try {

            audit.log(null, 'mysql_parity_check', '程式_mysql', null, summary);

        }

        catch { /* ignore */ }

        return summary;

    }

    finally {

        releaseLock();

    }

}

/** 從 parity 腳本輸出解析通過/失敗項數，組成統一 summary */

function buildParitySummary(r) {

    const out = r.out || '';

    const passMatch = out.match(/通過 (\d+) 項/);

    const failMatch = out.match(/失敗 (\d+) 項/);

    return {

        ok: r.ok,

        code: r.code,

        passed: passMatch ? Number(passMatch[1]) : 0,

        failed: failMatch ? Number(failMatch[1]) : 0,

        out: out.split('\n').slice(-10).join('\n'),

        err: r.err || null,

        at: r.at || new Date().toISOString(),

    };

}

/* ============================ 排程鏈：先 ETL 再 parity ============================ */

/**

 * 排程觸發：先 ETL 同步 LIVE→MySQL，再 parity 比對。

 * 共用同一把鎖，確保不與手動 runNow / 另一次排程重疊。

 * ETL 失敗仍續跑 parity（留紀錄），但會在前後 log 明確標示 ETL 異常。

 */

async function runScheduled() {

    if (!acquireLock()) {

        console.log('[parity] 跳過本次排程：其他流程佔用鎖');

        return;

    }

    try {

        // 1) ETL：LIVE SQLite → MySQL

        console.log('[parity] 排程：先跑 ETL 同步 LIVE→MySQL...');

        const etl = await spawnScript(ETL_SCRIPT);

        if (etl.ok) {

            console.log('[parity] ETL 完成 ✅');

        }

        else {

            console.warn('[parity] ETL 失敗 ❌：' + (etl.error || etl.err || '未知錯誤'));

            console.warn('[parity] ETL 末段輸出：\n' + (etl.out || '').split('\n').slice(-10).join('\n'));

        }

        // 2) parity 比對（基準已是最新）

        console.log('[parity] 排程：再跑 parity 比對...');

        const r = await spawnScript(SCRIPT);

        const summary = buildParitySummary(r);

        try {

            audit.log(null, 'mysql_parity_check', '程式_mysql', null, summary);

        }

        catch { /* ignore */ }

        if (r.ok) {

            console.log(`[parity] 雙邊對齊 ✅ 通過 ${summary.passed} 項（0 失敗）`);

        }

        else if (summary.passed || summary.failed) {

            console.warn(`[parity] 雙邊對齊 ❌ 失敗 ${summary.failed} 項 / 通過 ${summary.passed} 項`);

            console.warn('[parity] 末段輸出：\n' + summary.out);

        }

        else {

            console.warn('[parity] 跑失敗：' + (r.error || '未知錯誤'));

        }

    }

    finally {

        releaseLock();

    }

}

/* ============================ 排程安裝 ============================ */

/** 與 botfx/gc 同款的排程：cfg.parity.runHour 觸發，跨日 / 開機補抓 */

let schedInstalled = false;

function startSched() {

    if (schedInstalled)

        return;

    schedInstalled = true;

    const runHour = Number((cfg.parity && cfg.parity.runHour) != null ? cfg.parity.runHour : 7);

    const enabled = !cfg.parity || cfg.parity.enabled !== false;

    if (!enabled) {

        console.log('[parity] 已停用（cfg.parity.enabled=false）');

        return;

    }

    let lastRunDate = ''; // YYYY-MM-DD

    const run = async () => {

        const now = new Date();

        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        if (now.getHours() !== runHour)

            return;

        if (lastRunDate === today)

            return;

        lastRunDate = today;

        // 🔒 每日先 ETL 再 parity，確保比對基準為當日最新，排程結果穩定 0 失敗

        await runScheduled();

    };

    setTimeout(run, 15000); // 開機後 15 秒先跑一次

    setInterval(run, 10 * 60 * 1000); // 之後每 10 分鐘檢查一次（hour 匹配才跑）

    console.log(`[parity] 排程已啟用：每日 ${runHour}:00 先 ETL 再 parity`);

}

