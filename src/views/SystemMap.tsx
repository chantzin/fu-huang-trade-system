// 系統地圖（登入後首頁，功能模組總覽，HR 配色風格）
import { user, route, companyInfo, edition } from '../store.ts';

const ROLE_LABEL: any = { admin: '管理者', manager: '主管', accounting: '會計', sales: '業務' };

// 功能群組定義（HR 多色風格：red/green/blue 三主色各 3 變體 + dark）
const GROUPS = [
  {
    title: '營運作業',
    color: 'red',
    mods: [
      { key: 'dashboard', label: '儀表板', roles: ['admin', 'manager', 'accounting', 'sales'] },
    ],
  },
  {
    title: '客戶服務管理',
    color: 'red-2',
    mods: [
      { key: 'customers', label: '客戶資料', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'quotes', label: '客戶報價單', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'orders', label: '客戶訂單管理', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'shipments', label: '出貨與單據', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'receivables', label: '應收帳款', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'customer-statements', label: '客戶對帳單', roles: ['admin', 'manager', 'accounting', 'sales'] },
    ],
  },
  {
    title: '供應鏈管理',
    color: 'green-2',
    mods: [
      { key: 'suppliers', label: '供應商工廠', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'supplier-quotes', label: '供應商報價單', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'supplier-orders', label: '供應商訂單', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'supplier-shipments', label: '供應商出貨與單據', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'inventory', label: '庫存管理', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'payables', label: '應付帳款', roles: ['admin', 'manager', 'accounting', 'sales'] },
    ],
  },
  {
    title: '主檔與表單',
    color: 'green',
    mods: [
      { key: 'products', label: '產品料號', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'form-editor', label: '表單編輯', roles: ['admin', 'manager', 'accounting', 'sales'] },
    ],
  },
  {
    title: '分析與簽核',
    color: 'blue',
    mods: [
      { key: 'reports', label: '報表分析', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'approval-flows', label: '電子簽核設定', roles: ['admin', 'manager'] },
      { key: 'approval-pending', label: '待簽核', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'approval-done', label: '已同意', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'approval-returned', label: '待更改', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'doc-verify', label: '文件驗證', roles: ['admin', 'manager', 'accounting', 'sales'] },
    ],
  },
  {
    title: '系統與管理',
    color: 'dark',
    wide: true,
    mods: [
      { key: 'admin', label: '系統管理（參數/使用者/匯率/日誌）', roles: ['admin', 'manager', 'accounting'] },
      { key: 'system-update', label: '系統更新', roles: ['admin', 'manager'] },
      { key: 'system-appearance', label: '系統外觀', roles: ['admin', 'manager'] },
      { key: 'ar-terms', label: '帳期規則管理', roles: ['admin', 'manager'] },
      { key: 'mail-settings', label: '郵件設定', roles: ['admin', 'manager'] },
      { key: 'mail-logs', label: '郵件發送紀錄', roles: ['admin', 'manager'] },
      { key: 'system-backup', label: '系統備份（手動/排程/異地同步/還原）', roles: ['admin', 'manager'] },
      { key: 'license', label: '授權管理', roles: ['admin'], superOnly: true },
      { key: 'network-settings', label: '網路設定（內部 IP / 對外 / HTTPS / 憑證）', roles: ['admin'], superOnly: true },
      { key: 'audit-log', label: '操作日誌查詢', roles: ['admin', 'manager'] },
      { key: 'security-settings', label: '安全設定（MFA）', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'manual', label: '操作手冊', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'build-manual', label: '建置手冊', roles: ['admin'], superOnly: true },
    ],
  },
];

export default function SystemMap() {
  const role = user.value?.role || 'sales';
  const userName = user.value?.name || user.value?.emp_id || '使用者';
  const roleLabel = ROLE_LABEL[role] || role;

  const goTo = (key: any) => {
    route.value = key;
    location.hash = '#/' + key;
  };

  return (
    <div class="sysmap-wrap">
      <div class="sysmap-header">
        <h1 class="sysmap-title">{companyInfo.value.name ? `${companyInfo.value.name} · 系統地圖` : '系統地圖'}</h1>
        <p class="sysmap-sub">
          親愛的 <span>{userName}</span>（<span>{roleLabel}</span>），歡迎使用本系統。<br />
          以下為功能模組總覽，點擊模組可直接進入對應功能，或點擊下方按鈕進入系統作業。<br />
          系統產出文件的頁尾會列示列印時間、文件指紋、頁碼，並標示由輔凰商貿系統製作。
        </p>
      </div>

      <div class="sysmap-canvas">
        <div class="sysmap-grid">
          {GROUPS.map((g: any) => {
            const visibleMods = g.mods.filter((m: any) => {
            if (!(m.roles || []).includes(role)) return false;
            if (m.superOnly && !user.value?.isSuperAdmin) return false;
            if (m.key === 'network-settings' && edition.value === 'single') return false;
            return true;
          });
            if (!visibleMods.length) return null;
            return (
              <div class={`sysmap-group sysmap-group-${g.color}${g.wide ? ' sysmap-group-wide' : ''}`}>
                <h3 class="sysmap-group-title">{g.title}</h3>
                <div class="sysmap-mods">
                  {visibleMods.map((m: any) => (
                    <a class="sysmap-mod" onClick={() => goTo(m.key)} style="cursor:pointer">{m.label}</a>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div class="sysmap-footer">
        <button class="btn-enter-admin" onClick={() => goTo('dashboard')}>
          進入系統作業
        </button>
        <p class="sysmap-note">本圖為系統功能總覽，僅供瀏覽。進入後將依您的權限顯示可操作的功能。</p>
      </div>
    </div>
  );
}
SystemMap.title = '系統地圖';


