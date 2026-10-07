// @ts-nocheck
'use strict';
/**
 * 系統維運端點（H2/H3/H4/M2 匯聚）：裝置識別、診斷包、還原演練、VACUUM
 * 掛載於 /api/system（server.ts）。所有路由均需 admin。
 * - GET  /install-info          裝置識別（installId / 環境 / 版本）
 * - GET  /diagnostics           診斷資訊（JSON，供頁面顯示）
 * - GET  /diagnostics/download  診斷包 ZIP 下載（application/zip）
 * - POST /backup/restore-drill  真實還原演練（非破壞性：還原至暫存 DB 後比對列數）
 * - POST /db/vacuum             執行 SQLite VACUUM，回傳前後檔案大小
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { requireAdmin } = require('../lib/auth');
const { db, DATA_DIR, DB_FILE } = require('../lib/db-dual');
const { getInstallInfo } = require('../lib/install');
const { collectDiagnostics, buildDiagnosticsZip } = require('../lib/diagnostics');
const audit = require('../lib/audit');
const backup = require('./backup');

const router = express.Router();

/** 裝置識別資訊 */
router.get('/install-info', requireAdmin, (req, res) => {
  try { res.json(getInstallInfo()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/** 診斷資訊（JSON） */
router.get('/diagnostics', requireAdmin, (req, res) => {
  try { res.json(collectDiagnostics()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/** 診斷包 ZIP 下載 */
router.get('/diagnostics/download', requireAdmin, (req, res) => {
  try {
    const zip = buildDiagnosticsZip();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="diagnostics-${ts}.zip"`);
    res.send(zip);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 真實還原演練（非破壞性） */
router.post('/backup/restore-drill', requireAdmin, (req, res) => {
  try {
    const result = runRestoreDrill();
    audit.log(req, 'drill', '系統還原演練', '', '還原演練：' + (result.pass ? '通過' : '失敗') +
      ' 來源=' + (result.source || '') + ' 表數=' + (result.tables || 0) +
      (result.mismatches && result.mismatches.length ? ' 不一致=' + result.mismatches.length : ''));
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** SQLite VACUUM（釋出閒置空間） */
router.post('/db/vacuum', requireAdmin, (req, res) => {
  try {
    const f = DB_FILE || db.name;
    const before = fs.existsSync(f) ? fs.statSync(f).size : 0;
    db.exec('VACUUM');
    const after = fs.existsSync(f) ? fs.statSync(f).size : 0;
    audit.log(req, 'maintain', '資料庫', '', `VACUUM 完成：${before} → ${after} bytes（釋出 ${Math.max(0, before - after)}）`);
    res.json({ ok: true, beforeBytes: before, afterBytes: after, reclaimedBytes: Math.max(0, before - after) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 還原演練核心：取最新備份 → 解密 → 還原至暫存 DB → 比對列數 → 清理 */
function runRestoreDrill() {
  const files = fs.readdirSync(backup.BACKUP_DIR)
    .filter((f) => backup.BACKUP_NAMES_RE.test(f))
    .sort()
    .reverse();
  if (!files.length) return { pass: false, reason: 'NO_BACKUP' };
  const fp = path.join(backup.BACKUP_DIR, files[0]);
  const payload = backup.parseBackupContent(fs.readFileSync(fp));
  const tmp = path.join(DATA_DIR, '_drill_tmp_' + Date.now() + '.sqlite');
  try {
    const r = backup.restorePayloadToDb(payload, tmp);
    const tdb = new Database(tmp, { readonly: true });
    const mismatches = [];
    for (const t of Object.keys(payload.tables || {})) {
      const expected = (payload.tables[t].rows || []).length;
      let got = -1;
      try { got = tdb.prepare('SELECT COUNT(*) c FROM ' + t).get().c; } catch (_) { got = -1; }
      if (got !== expected) mismatches.push({ table: t, expected, got });
    }
    tdb.close();
    return {
      pass: mismatches.length === 0,
      source: files[0],
      tables: Object.keys(payload.tables || {}).length,
      restoredTables: r.tables,
      mismatches,
    };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

module.exports = router;
