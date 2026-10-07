// 基礎 RBAC 權限控制模組
// 角色定義與權限矩陣
const ROLES = {
  admin: { label: '系統管理員', level: 100 },
  manager: { label: '主管', level: 80 },
  accounting: { label: '會計', level: 60 },
  sales: { label: '業務', level: 40 },
};

// 權限定義：每個權限對應可執行的角色等級
const PERMISSIONS = {
  // 系統管理
  'system:manage': 80,       // 系統管理（manager 以上）
  'system:admin': 100,       // 使用者管理、操作日誌（admin 專用）
  'system:appearance': 80,   // 系統外觀
  'system:backup': 80,       // 系統備份
  'system:mail': 80,         // 郵件設定
  'system:params': 80,       // 參數設定
  'system:ar-terms': 80,     // 帳期規則
  // 主檔
  'master:write': 80,        // 新增/修改/刪除主檔
  'master:read': 40,         // 檢視主檔
  // 交易單據
  'transaction:write': 60,   // 新增/修改單據（accounting 以上）
  'transaction:delete': 80,  // 刪除單據（manager 以上）
  'transaction:read': 40,     // 檢視單據
  // 財務
  'finance:write': 60,       // 應收應付操作
  'finance:read': 40,        // 檢視財務
  // 報表
  'report:read': 40,         // 檢視報表
};

function getRoleLevel(role) {
  return ROLES[role]?.level || 0;
}

function hasPermission(userRole, permission) {
  const requiredLevel = PERMISSIONS[permission];
  if (requiredLevel === undefined) return false;
  return getRoleLevel(userRole) >= requiredLevel;
}

// Express 中介層：檢查權限
function requirePermission(permission) {
  return (req, res, next) => {
    const userRole = req.user?.role;
    if (!userRole) return res.status(401).json({ error: '未登入或登入已逾時' });
    if (!hasPermission(userRole, permission)) {
      return res.status(403).json({ error: `權限不足（需要 ${permission}）` });
    }
    next();
  };
}

// Express 中介層：僅 admin
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '僅系統管理員可執行此操作' });
  }
  next();
}

module.exports = { ROLES, PERMISSIONS, getRoleLevel, hasPermission, requirePermission, requireAdmin };
