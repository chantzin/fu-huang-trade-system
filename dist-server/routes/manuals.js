'use strict';
/**
 * 手冊外部化 API（routes/manuals.js）
 *
 * 讀取 docs/ 目錄下的 Markdown 檔案並回傳，供前端動態載入渲染。
 * 非技術人員可直接編輯 .md 檔案，不需修改程式碼或重新部署。
 *
 * GET /api/manuals/operation  → 操作手冊 Markdown 內容
 * GET /api/manuals/build       → 建置手冊 Markdown 內容（僅 admin/manager）
 */
const fs = require('fs');
const path = require('path');
const express = require('express');

const router = express.Router();

// docs 目錄路徑（優先使用環境變數，否則依佈署布局自動解析）
// 開發期：routes/manuals.js → 上層即專案根 → <root>/docs
// 佈署期：dist-server/routes/manuals.js → 需再上一層才到 <app>/docs
const DOCS_DIR = (() => {
  if (process.env.APP_MANUALS_DIR) return process.env.APP_MANUALS_DIR;
  const candidates = [
    path.join(__dirname, '..', 'docs'),
    path.join(__dirname, '..', '..', 'docs'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
})();

/**
 * 讀取 Markdown 檔案
 * @param {string} filename - 檔名（operation.md / build.md）
 * @returns {string} Markdown 內容
 */
function readManual(filename) {
  const filePath = path.join(DOCS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    throw new Error(`手冊檔案不存在：${filename}（路徑：${filePath}）`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * 取得手冊的最後修改時間
 * @param {string} filename - 檔名
 * @returns {string} ISO 格式時間字串
 */
function getLastModified(filename) {
  const filePath = path.join(DOCS_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  return stat.mtime.toISOString();
}

// GET /api/manuals/operation — 操作手冊（全角色可見）
router.get('/operation', (req, res) => {
  try {
    const content = readManual('operation.md');
    res.json({
      ok: true,
      type: 'operation',
      title: '操作手冊',
      content,
      lastModified: getLastModified('operation.md'),
      docsDir: DOCS_DIR,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/manuals/build — 建置手冊（僅 admin/manager）
router.get('/build', (req, res) => {
  // 權限檢查：由中間層 requireManager 處理，這裡只做雙重確認
  try {
    const content = readManual('build.md');
    res.json({
      ok: true,
      type: 'build',
      title: '建置手冊',
      content,
      lastModified: getLastModified('build.md'),
      docsDir: DOCS_DIR,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/manuals/admin — 管理者手冊（僅 admin/manager）
router.get('/admin', (req, res) => {
  try {
    const content = readManual('admin.md');
    res.json({
      ok: true,
      type: 'admin',
      title: '管理者手冊',
      content,
      lastModified: getLastModified('admin.md'),
      docsDir: DOCS_DIR,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
