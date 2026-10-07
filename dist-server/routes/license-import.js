'use strict';
/**
 * 授權檔匯入（管理者 / 主管）
 * ------------------------------------------------------------
 * 端點：
 *   GET  /api/license        目前授權狀態快照（同 server.ts 原 GET /api/license）
 *   POST /api/license/import 上傳 .lic（multipart 欄位 lic）→ 驗章 → 寫入 license.lic → reload → 回傳新狀態
 *
 * 安全設計：
 *   - requireAuth + requireManager 雙重保護（僅登入之管理者/主管可匯入）。
 *   - 匯入前先以公鑰驗章 + 過期檢查；簽章無效或解析錯誤直接 400，不寫入。
 *   - 寫入成功後 reload() 清除快取，後續 getState()/guard 即讀新檔。
 *   - 此路由本身在 guard 中被列為安全路由（expired 時仍可用以續約）。
 *   - 失敗時臨時上傳檔一律清理。
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const multer = require('multer');

const { requireAuth, requireSuperAdmin } = require('../lib/auth');
const { verifyLicense, reload, getState, LICENSE_PATH } = require('../lib/license');
const audit = require('../lib/audit');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();
// 授權檔匯入屬供應商專屬操作：僅超級管理員（empId 等同 bootstrapAdmin.empId，預設 ADMIN）可執行
router.use(requireAuth);
router.use(requireSuperAdmin);

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB 上限（授權檔極小）
});

/* 目前授權狀態 */
router.get('/', wrap(async (req, res) => {
  res.json(getState());
}));

/* 匯入授權檔 */
router.post('/import', upload.single('lic'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未收到授權檔（欄位名稱應為 lic）' });

  const orig = req.file.originalname || '';
  if (!/\.(lic|json)$/i.test(orig)) {
    try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    return res.status(400).json({ error: '授權檔須為 .lic 或 .json 檔' });
  }

  let rawText;
  try { rawText = fs.readFileSync(req.file.path, 'utf8'); }
  catch (e) {
    try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    return res.status(400).json({ error: '無法讀取上傳的授權檔：' + e.message });
  }

  // 先驗章（不改變系統目前狀態）
  const v = verifyLicense(rawText);
  try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }

  if (!v.valid) {
    let msg = '授權檔驗證失敗（' + v.reason + '），未寫入系統。請確認檔案由供應商簽發且未被竄改。';
    if (v.reason === 'BINDING_MISMATCH') {
      msg = '此授權檔綁定的裝置序號（Install ID）與本機不符，無法匯入。請向供應商確認是否為「本機授權管理」頁面顯示的裝置序號所核發；若已換機/重灌，請申請重新簽發。';
    }
    return res.status(400).json({ valid: false, reason: v.reason, error: msg });
  }

  // 通過驗證 → 寫入 license.lic（保留原始文字，確保簽章位元組一致）
  try {
    fs.writeFileSync(LICENSE_PATH, rawText, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: '寫入授權檔失敗：' + e.message });
  }

  // 清除快取並重新載入，使新授權立即生效
  reload();
  const newState = getState();

  // M1 稽核：授權檔匯入成功納入操作日誌（供稽核覆蓋完整性）
  audit.log(req, 'import', 'license', '', `匯入授權檔：licensee=${(newState.licensee || '—')} seats=${(newState.seats || 0)} expiresAt=${(newState.expiresAt || '—')}`);

  console.log(`[license] 授權檔已由管理員 ${req.user && (req.user.emp_id || req.user.username)} 匯入並生效：` +
    `licensee=${newState.licensee || '—'} seats=${newState.seats || 0} expiresAt=${newState.expiresAt || '—'}`);
  res.json({
    ok: true,
    msg: '授權檔已匯入並生效。',
    state: newState,
    importedAt: new Date().toISOString(),
  });
}));

module.exports = router;
