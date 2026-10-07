'use strict';
/** 公司檔案（公司名稱 / Logo / 系統背景圖） */
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../lib/db-dual');
const { requireAuth, requireManager } = require('../lib/auth');
const { cfg } = require('../lib/config');
const audit = require('../lib/audit');
const { str } = require('../lib/util');
const { getInstallInfo } = require('../lib/install');

function wrap(fn) {
  return (req, res, next) => {
    try { return Promise.resolve(fn(req, res, next)).catch(next); }
    catch (e) { next(e); }
  };
}

const router = express.Router();

// 上傳目錄
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// multer 設定
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const prefix = file.fieldname === 'logo' ? 'logo' : 'bg';
    cb(null, `${prefix}_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(png|jpeg|gif|webp|bmp)$/.test(file.mimetype);
    cb(ok ? null : new Error('僅支援圖片格式（PNG/JPEG/GIF/WEBP/BMP）'), ok);
  },
});

// 讀取參數
const getParam = async (key, def) => {
  const r = await db.prepare('SELECT value FROM parameters WHERE key=?').get(key);
  return r ? r.value : def;
};
// 儲存參數
const setParam = async (key, value, label, group) => {
  await db.prepare(
    `INSERT INTO parameters (key, value, label, group_name) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now','localtime')`
  ).run(key, value, label, group);
};

/** 公開端點：讀取公司檔案（登入頁也能用，不需認證） */
router.get('/', wrap(async (req, res) => {
  let installId = '';
  try { installId = getInstallInfo().installId || ''; } catch (_) { /* ignore */ }
  res.json({
    // 系統名稱（單一來源＝config.json app_name；前端登入頁副標題與分頁標題用）
    systemName: cfg.app_name,
    // 裝置識別（INS/H3）：隨機安裝序號，登入頁/sidebar 可顯示，供支援辨識裝置
    installId,
    companyName: await getParam('company_name', ''),
    companyNameEn: await getParam('company_name_en', ''),
    companyTaxId: await getParam('company_tax_id', ''),
    companyAddress: await getParam('company_address', ''),
    companyPhone: await getParam('company_phone', ''),
    companyFax: await getParam('company_fax', ''),
    companyWebsite: await getParam('company_website', ''),
    companyLogo: await getParam('company_logo', ''),
    systemBackground: await getParam('system_background', ''),
  });
}));

/** 儲存公司資訊（名稱 / 英文名稱 / 統編 / 地址 / 電話 / 傳真） */
router.put('/', requireAuth, requireManager, wrap(async (req, res) => {
  const b = req.body || {};
  const name = str(b.companyName);
  const nameEn = str(b.companyNameEn);
  const taxId = str(b.companyTaxId);
  const address = str(b.companyAddress);
  const phone = str(b.companyPhone);
  const fax = str(b.companyFax);
  const website = str(b.companyWebsite);
  if (name !== undefined) {
    await setParam('company_name', name, '公司名稱', 'company');
  }
  if (nameEn !== undefined) {
    await setParam('company_name_en', nameEn, '公司英文名稱', 'company');
  }
  if (taxId !== undefined) {
    await setParam('company_tax_id', taxId, '公司統編', 'company');
  }
  if (address !== undefined) {
    await setParam('company_address', address, '公司地址', 'company');
  }
  if (phone !== undefined) {
    await setParam('company_phone', phone, '公司電話', 'company');
  }
  if (fax !== undefined) {
    await setParam('company_fax', fax, '公司傳真', 'company');
  }
  if (website !== undefined) {
    await setParam('company_website', website, '公司網址', 'company');
  }
  audit.log(req, 'update', 'company_profile', '', `companyName=${name}, nameEn=${nameEn}, taxId=${taxId}, address=${address}, phone=${phone}, fax=${fax}, website=${website}`);
  res.json({ ok: true, companyName: name, companyNameEn: nameEn, companyTaxId: taxId, companyAddress: address, companyPhone: phone, companyFax: fax, companyWebsite: website });
}));

/** 上傳 Logo */
router.post('/logo', requireAuth, requireManager, upload.single('logo'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇圖片檔案' });
  const url = `/uploads/${req.file.filename}`;
  // 刪除舊 Logo
  const oldLogo = await getParam('company_logo', '');
  if (oldLogo && oldLogo.startsWith('/uploads/')) {
    const oldPath = path.join(UPLOAD_DIR, path.basename(oldLogo));
    if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch {} }
  }
  await setParam('company_logo', url, '公司 Logo', 'company');
  audit.log(req, 'upload', 'company_logo', '', url);
  res.json({ ok: true, companyLogo: url });
}));

/** 刪除 Logo */
router.delete('/logo', requireAuth, requireManager, wrap(async (req, res) => {
  const oldLogo = await getParam('company_logo', '');
  if (oldLogo && oldLogo.startsWith('/uploads/')) {
    const oldPath = path.join(UPLOAD_DIR, path.basename(oldLogo));
    if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch {} }
  }
  await setParam('company_logo', '', '公司 Logo', 'company');
  audit.log(req, 'delete', 'company_logo', '', oldLogo);
  res.json({ ok: true });
}));

/** 上傳系統背景圖 */
router.post('/background', requireAuth, requireManager, upload.single('background'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '請選擇圖片檔案' });
  const url = `/uploads/${req.file.filename}`;
  // 刪除舊背景
  const oldBg = await getParam('system_background', '');
  if (oldBg && oldBg.startsWith('/uploads/')) {
    const oldPath = path.join(UPLOAD_DIR, path.basename(oldBg));
    if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch {} }
  }
  await setParam('system_background', url, '系統背景圖', 'company');
  audit.log(req, 'upload', 'system_background', '', url);
  res.json({ ok: true, systemBackground: url });
}));

/** 清除系統背景圖 */
router.delete('/background', requireAuth, requireManager, wrap(async (req, res) => {
  const oldBg = await getParam('system_background', '');
  if (oldBg && oldBg.startsWith('/uploads/')) {
    const oldPath = path.join(UPLOAD_DIR, path.basename(oldBg));
    if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch {} }
  }
  await setParam('system_background', '', '系統背景圖', 'company');
  audit.log(req, 'delete', 'system_background', '', oldBg);
  res.json({ ok: true });
}));

module.exports = router;
