/**
 * Express Request 全域擴充：本系統慣用的掛載欄位
 * - req.user：requireAuth 通過後掛上的登入使用者（含 empId）
 * - req.file / req.files：multer 上傳
 */
declare global {
  namespace Express {
    interface Request {
      user?: any;
      file?: any;
      files?: any;
    }
  }
}

export {};
