import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from './api.ts';
import { token, user, route, companyInfo, systemName, appVersion, edition, licenseState, installId, DEFAULT_SYSTEM_NAME } from './store.ts';
import { setMoneyDecimals } from './ui/format.ts';
import ToastHost from './ui/Toast.tsx';
import { GROUP_ICONS, GROUP_COLORS, ITEM_ICONS } from './ui/NavIcons.tsx';

import Dashboard from './views/Dashboard.tsx';
import Quotations from './views/Quotations.tsx';
import Statements from './views/Statements.tsx';
import Orders from './views/Orders.tsx';
import Shipments from './views/Shipments.tsx';
import Receivables from './views/Receivables.tsx';
import Customers from './views/Customers.tsx';
import Products from './views/Products.tsx';
import Suppliers from './views/Suppliers.tsx';
import Reports from './views/Reports.tsx';
import Admin from './views/Admin.tsx';
import Manual from './views/Manual.tsx';
import BuildManual from './views/BuildManual.tsx';
import AdminManual from './views/AdminManual.tsx';
import MailSettings from './views/MailSettings.tsx';
import MailLogs from './views/MailLogs.tsx';
import ArTerms from './views/ArTerms.tsx';
import FormEditor from './views/FormEditor.tsx';
import SystemAppearance from './views/SystemAppearance.tsx';
import SystemBackup from './views/SystemBackup.tsx';
import LicenseAdmin from './views/LicenseAdmin.tsx';
import SystemMap from './views/SystemMap.tsx';
import { ConfirmHost } from './ui/Modal.tsx';
import PwaInstall from './ui/PwaInstall.tsx';
import SupplierQuotes from './views/SupplierQuotes.tsx';
import SupplierOrders from './views/SupplierOrders.tsx';
import SupplierShipments from './views/SupplierShipments.tsx';
import Payables from './views/Payables.tsx';
import ApprovalFlows from './views/ApprovalFlows.tsx';
import ApprovalPending from './views/ApprovalPending.tsx';
import ApprovalDone from './views/ApprovalDone.tsx';
import ApprovalReturned from './views/ApprovalReturned.tsx';
import DocVerify from './views/DocVerify.tsx';
import SystemUpdate from './views/SystemUpdate.tsx';
import Inventory from './views/Inventory.tsx';
import NetworkSettings from './views/NetworkSettings.tsx';
import AuditLog from './views/AuditLog.tsx';
import SecuritySettings from './views/SecuritySettings.tsx';

// 父子階層：group 為可收合的父項，children 為子項
const NAV = [
  {
    group: '總覽',
    children: [
      { key: 'system-map', label: '系統地圖', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'dashboard', label: '營運儀表板', roles: ['admin', 'manager', 'accounting', 'sales'] },
    ],
  },
  {
    group: '文件簽核',
    children: [
      { key: 'approval-pending', label: '待簽核', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'approval-done', label: '已同意', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'approval-returned', label: '待更改', roles: ['admin', 'manager', 'accounting', 'sales'] },
    ],
  },


  {
    group: '客戶服務管理',
    children: [
      { key: 'customers', label: '客戶資料', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'quotes', label: '客戶報價單', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'orders', label: '客戶訂單管理', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'shipments', label: '出貨與單據', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'receivables', label: '應收帳款', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'customer-statements', label: '客戶對帳單', roles: ['admin', 'manager', 'accounting', 'sales'] },
    ],
  },
  {
    group: '供應鏈管理',
    children: [
      { key: 'suppliers', label: '供應商工廠', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'supplier-quotes', label: '供應商報價單', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'supplier-orders', label: '供應商訂單', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'supplier-shipments', label: '供應商出貨與單據', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'inventory', label: '庫存管理', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'payables', label: '應付帳款', roles: ['admin', 'manager', 'accounting', 'sales'] },
    ],
  },
  {
    group: '主檔',
    children: [
      { key: 'products', label: '產品料號', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'form-editor', label: '表單編輯', roles: ['admin', 'manager', 'accounting', 'sales'] },
    ],
  },
  {
    group: '分析與管理',
    children: [
      { key: 'reports', label: '報表分析', roles: ['admin', 'manager', 'accounting', 'sales'] },
            { key: 'approval-flows', label: '電子簽核', roles: ['admin', 'manager'] },
      { key: 'doc-verify', label: '文件驗證', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'manual', label: '操作手冊', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'build-manual', label: '建置手冊', roles: ['admin'], superOnly: true },
    ],
  },
  {
    group: '系統與管理',
    children: [
      { key: 'admin', label: '系統管理', roles: ['admin', 'manager', 'accounting'] },
      { key: 'system-update', label: '系統更新', roles: ['admin', 'manager'] },
      { key: 'system-appearance', label: '系統外觀', roles: ['admin', 'manager'] },
      { key: 'ar-terms', label: '帳期規則', roles: ['admin', 'manager'] },
      { key: 'mail-settings', label: '郵件設定', roles: ['admin', 'manager'] },
      { key: 'mail-logs', label: '郵件發送紀錄', roles: ['admin', 'manager'] },
      { key: 'system-backup', label: '系統備份', roles: ['admin', 'manager'] },
      { key: 'audit-log', label: '操作日誌查詢', roles: ['admin', 'manager'] },
      { key: 'security-settings', label: '安全設定（MFA）', roles: ['admin', 'manager', 'accounting', 'sales'] },
      { key: 'license', label: '授權管理', roles: ['admin'], superOnly: true },
      { key: 'network-settings', label: '網路設定', roles: ['admin'], superOnly: true },
    ],
  },
];


const VIEWS: any = {
  dashboard: Dashboard, quotes: Quotations, orders: Orders, shipments: Shipments, receivables: Receivables, 'customer-statements': Statements,
  customers: Customers, products: Products, suppliers: Suppliers, reports: Reports, admin: Admin,
  'supplier-quotes': SupplierQuotes, 'supplier-orders': SupplierOrders,
  'supplier-shipments': SupplierShipments, payables: Payables,
  'inventory': Inventory,
  'mail-settings': MailSettings, 'mail-logs': MailLogs,
  manual: Manual, 'build-manual': BuildManual, 'admin-manual': AdminManual,
  'ar-terms': ArTerms,
  'form-editor': FormEditor,
  'system-appearance': SystemAppearance,
  'system-backup': SystemBackup,
  'license': LicenseAdmin,
  'system-map': SystemMap,
  'approval-flows': ApprovalFlows,
  'approval-pending': ApprovalPending,
  'approval-done': ApprovalDone,
  'approval-returned': ApprovalReturned,
  'doc-verify': DocVerify,
  'system-update': SystemUpdate,
  'network-settings': NetworkSettings,
  'audit-log': AuditLog,
  'security-settings': SecuritySettings,
};

const ROLE_LABEL: any = { admin: '管理者', manager: '主管', accounting: '會計', sales: '業務' };

/** sidebar 第三行：授權方案 / 授權狀況標籤（試用版 / 已到期 / 方案名） */
function licenseBadge() {
  const s = licenseState.value || {};
  const mode = s.mode;
  if (mode === 'trial') return '試用版 Trial';
  if (mode === 'expired') return '授權已到期';
  // licensed：優先顯示方案標籤（Trial / Starter / Professional ...）
  if (s.plan) return s.plan;
  return s.licensee ? `已授權（${s.licensee}）` : '已授權';
}

/* ============ 登入 ============ */
function Login() {
  const empId = useSignal('');
  const pwd = useSignal('');
  const msg = useSignal('');
  const busy = useSignal(false);
  // 🔒 B2：首次登入強制改密
  const forceChange = useSignal(false);
  const newPwd = useSignal('');
  const confirmPwd = useSignal('');
  const changeMsg = useSignal('');
  const changeBusy = useSignal(false);
  // 🔒 MFA：登入第二步（TOTP）狀態
  const mfaChallenge = useSignal('');
  const mfaCode = useSignal('');
  const mfaMsg = useSignal('');
  const mfaBusy = useSignal(false);
  // 🔒 MFA：技術強制首綁（角色需 MFA 但尚未啟用）
  const mfaSetupToken = useSignal('');
  const mfaSetupData = useSignal<any>(null); // { secret, otpauthUrl, qrDataUrl }
  const mfaSetupCode = useSignal('');
  const mfaSetupMsg = useSignal('');
  const mfaSetupBusy = useSignal(false);

  // 登入頁掛載時即載入公司資訊（名稱/Logo/背景圖），登入前就能正確顯示設定值
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/company-profile', { cache: 'no-store' });
        const p = await r.json();
        if (!alive) return;
        companyInfo.value = {
          name: p.companyName || '',
          nameEn: p.companyNameEn || '',
          taxId: p.companyTaxId || '',
          address: p.companyAddress || '',
          phone: p.companyPhone || '',
          fax: p.companyFax || '',
          logo: p.companyLogo || '',
          background: p.systemBackground || '',
        };
        if (p.systemBackground) {
          document.documentElement.style.setProperty('--sys-bg-image', `url("${p.systemBackground}")`);
          document.body.classList.add('has-sys-bg');
        }
        // 系統名稱（來源＝config.json app_name）：登入頁副標題 + 瀏覽器分頁標題
        systemName.value = p.systemName || DEFAULT_SYSTEM_NAME;
      } catch { /* 保留目前值 */ }
    })();
    return () => { alive = false; };
  }, []);

  const doLogin = async (e: any) => {
    e.preventDefault();
    if (!empId.value || !pwd.value) { msg.value = '請輸入工號與密碼'; return; }
    busy.value = true; msg.value = '';
    try {
      const r = await api.login(empId.value.trim(), pwd.value);
      if (r.mfaRequired) {
        mfaChallenge.value = r.challengeToken;
        mfaMsg.value = '已啟用二階段驗證，請輸入 Authenticator App 上的 6 位動態碼。';
        return;
      }
      // 🔒 MFA 技術強制首綁：角色需 MFA 但尚未啟用 → 顯示綁定面板
      if (r.mfaSetupRequired) {
        mfaSetupToken.value = r.setupToken;
        mfaSetupMsg.value = '基於資安政策，您的帳號必須先綁定 MFA（二階段驗證）才能登入。請用 Authenticator App 掃描下方 QR 並輸入動態碼。';
        await startMfaSetup();
        return;
      }
      api.setToken(r.token);
      const me = await api.get('/auth/me');
      // 🔒 B2：首次登入強制改密——停留在登入頁並顯示改密表單
      if (me.user.mustChangePwd) {
        forceChange.value = true;
        changeMsg.value = '首次登入，為保障資安請先設定新密碼（至少 8 碼，且同時含英文字母與數字）。';
        return;
      }
      user.value = me.user;
      route.value = 'system-map';
    } catch (err) {
      msg.value = err.message || '登入失敗';
    } finally {
      busy.value = false;
    }
  };

  // 🔒 MFA：第二步驗證（TOTP）後完成登入
  const doVerifyMfa = async (e: any) => {
    e.preventDefault();
    if (!mfaCode.value) { mfaMsg.value = '請輸入 6 位驗證碼'; return; }
    mfaBusy.value = true; mfaMsg.value = '';
    try {
      const r = await api.post('/auth/verify-mfa', { challengeToken: mfaChallenge.value, code: mfaCode.value });
      api.setToken(r.token);
      const me = await api.get('/auth/me');
      if (me.user.mustChangePwd) {
        mfaChallenge.value = '';
        forceChange.value = true;
        changeMsg.value = '首次登入，為保障資安請先設定新密碼（至少 8 碼，且同時含英文字母與數字）。';
        return;
      }
      user.value = me.user;
      route.value = 'system-map';
    } catch (err) {
      mfaMsg.value = err.message || '驗證失敗';
    } finally {
      mfaBusy.value = false;
    }
  };

  // 🔒 MFA：技術強制首綁——取得 QR / 密鑰
  const startMfaSetup = async () => {
    mfaSetupBusy.value = true; mfaSetupMsg.value = '';
    try {
      const r = await api.post('/auth/mfa/setup-start', { setupToken: mfaSetupToken.value });
      mfaSetupData.value = r;
    } catch (e: any) { mfaSetupMsg.value = e.message || '取得綁定資料失敗'; }
    finally { mfaSetupBusy.value = false; }
  };

  // 🔒 MFA：技術強制首綁——輸入 TOTP 完成啟用並登入
  const doFinishMfaSetup = async (e: any) => {
    e.preventDefault();
    if (!mfaSetupCode.value) { mfaSetupMsg.value = '請輸入 6 位驗證碼'; return; }
    mfaSetupBusy.value = true; mfaSetupMsg.value = '';
    try {
      const r = await api.post('/auth/mfa/setup-finish', { setupToken: mfaSetupToken.value, code: mfaSetupCode.value });
      api.setToken(r.token);
      const me = await api.get('/auth/me');
      mfaSetupToken.value = ''; mfaSetupData.value = null;
      if (me.user.mustChangePwd) {
        forceChange.value = true;
        changeMsg.value = '首次登入，為保障資安請先設定新密碼（至少 8 碼，且同時含英文字母與數字）。';
        return;
      }
      user.value = me.user;
      route.value = 'system-map';
    } catch (err) {
      mfaSetupMsg.value = err.message || '綁定失敗';
    } finally {
      mfaSetupBusy.value = false;
    }
  };

  // 🔒 B2：強制改密提交
  const doForceChange = async (e: any) => {
    e.preventDefault();
    if (newPwd.value !== confirmPwd.value) { changeMsg.value = '兩次輸入的新密碼不一致'; return; }
    changeBusy.value = true; changeMsg.value = '';
    try {
      await api.post('/auth/change-password', { old_password: pwd.value, new_password: newPwd.value });
      const me = await api.get('/auth/me');
      forceChange.value = false;
      user.value = me.user;
      route.value = 'system-map';
    } catch (err) {
      changeMsg.value = err.message || '修改失敗';
    } finally {
      changeBusy.value = false;
    }
  };

  return (
    <div class="login-wrap">
      <div class="login-card">
        {companyInfo.value.logo ? (
          <img src={companyInfo.value.logo} alt="公司 Logo" class="login-logo" />
        ) : null}
        <h1>{companyInfo.value.name}</h1>
        <p class="muted">{systemName.value || DEFAULT_SYSTEM_NAME}</p>

        {mfaSetupToken.value ? (
          <form onSubmit={doFinishMfaSetup}>
            <p class="muted">MFA 二階段驗證綁定</p>
            {mfaSetupData.value ? (
              <>
                <p>請用 Authenticator App 掃描下方 QR Code，或手動輸入密鑰：</p>
                <div class="mfa-qr"><img src={mfaSetupData.value.qrDataUrl} alt="MFA QR Code" /></div>
                <div class="mfa-secret">密鑰（Secret）：<code>{mfaSetupData.value.secret}</code></div>
              </>
            ) : <p>正在準備綁定資料…</p>}
            <label>輸入 App 顯示的 6 位動態碼以完成啟用</label>
            <input type="text" placeholder="6 位驗證碼" value={mfaSetupCode.value}
              onInput={(e: any) => (mfaSetupCode.value = e.currentTarget.value)} inputmode="numeric" autocomplete="one-time-code" />
            <button type="submit" disabled={mfaSetupBusy.value || !mfaSetupCode.value}>完成綁定並登入</button>
            <div class="login-msg">{mfaSetupMsg.value}</div>
          </form>
        ) : mfaChallenge.value ? (
          <form onSubmit={doVerifyMfa}>
            <label>動態驗證碼（TOTP）</label>
            <input type="text" placeholder="請輸入 6 位驗證碼" value={mfaCode.value}
              onInput={(e: any) => (mfaCode.value = e.currentTarget.value)} autocomplete="one-time-code" inputmode="numeric" />
            <button type="submit" disabled={mfaBusy.value}>{mfaBusy.value ? '驗證中…' : '驗證並登入'}</button>
            <div class="login-msg">{mfaMsg.value}</div>
          </form>
        ) : forceChange.value ? (
          <form onSubmit={doForceChange}>
            <label>目前密碼</label>
            <input type="password" placeholder="請輸入目前密碼" value={pwd.value}
              onInput={(e: any) => (pwd.value = e.currentTarget.value)} autocomplete="current-password" />
            <label>新密碼（至少 8 碼，含英文與數字）</label>
            <input type="password" placeholder="請輸入新密碼" value={newPwd.value}
              onInput={(e: any) => (newPwd.value = e.currentTarget.value)} autocomplete="new-password" />
            <label>確認新密碼</label>
            <input type="password" placeholder="請再次輸入新密碼" value={confirmPwd.value}
              onInput={(e: any) => (confirmPwd.value = e.currentTarget.value)} autocomplete="new-password" />
            <button type="submit" disabled={changeBusy.value}>{changeBusy.value ? '設定中…' : '設定並登入'}</button>
            <div class="login-msg">{changeMsg.value}</div>
          </form>
        ) : (
          <form onSubmit={doLogin}>
            <label>工號</label>
            <input type="text" placeholder="請輸入工號" value={empId.value}
              onInput={(e: any) => (empId.value = e.currentTarget.value)} autocomplete="username" />
            <label>密碼</label>
            <input type="password" placeholder="請輸入密碼" value={pwd.value}
              onInput={(e: any) => (pwd.value = e.currentTarget.value)} autocomplete="current-password" />
            <button type="submit" disabled={busy.value}>{busy.value ? '登入中…' : '登入'}</button>
            <div class="login-msg">{msg.value}</div>
          </form>
        )}
        <div class="login-hint">🔒 帳號識別一律使用「工號」。{forceChange.value ? '為保障資安，首次登入必須修改密碼。' : '初始管理員由系統管理者安全建立與交付。'}</div>
      </div>
    </div>
  );
}

/* ============ 主佈局 ============ */
function Shell() {
  const title = useSignal('儀表板');
  const View = VIEWS[route.value] || Dashboard;

  useEffect(() => {
    const onHash = () => {
      // 去掉 query（支援掃 QR 直連：#/doc-verify?q=<指紋>）
      const key = (location.hash.replace(/^#\//, '').split('?')[0]) || 'system-map';
      route.value = VIEWS[key] ? key : 'system-map';
    };
    window.addEventListener('hashchange', onHash);
    // 啟動時讀取系統設定（主題）與公司檔案（名稱/Logo/背景圖）
    (async () => {
      try {
        const [s, p] = await Promise.all([
          api.get('/system-settings').catch(() => ({ theme: 'light' })),
          fetch('/api/company-profile', { cache: 'no-store' }).then((r: any) => r.json()).catch(() => ({})),
        ]);
        // 套用主題
        const theme = s.theme || 'light';
        document.documentElement.setAttribute('data-theme', theme);
        // 套用全系統金額小數點位數（未設定＝0 位）
        setMoneyDecimals(s.money_decimals);
        // 套用公司資訊（未設定時為空白，不顯示預設名稱）
        companyInfo.value = {
          name: p.companyName || '',
          nameEn: p.companyNameEn || '',
          taxId: p.companyTaxId || '',
          address: p.companyAddress || '',
          phone: p.companyPhone || '',
          fax: p.companyFax || '',
          logo: p.companyLogo || '',
          background: p.systemBackground || '',
        };
        // 套用背景圖到 CSS 變數
        if (p.systemBackground) {
          document.documentElement.style.setProperty('--sys-bg-image', `url("${p.systemBackground}")`);
          document.body.classList.add('has-sys-bg');
        } else {
          document.documentElement.style.setProperty('--sys-bg-image', 'none');
          document.body.classList.remove('has-sys-bg');
        }
        // 系統名稱（來源＝config.json app_name）：已登入時同樣套用分頁標題
        systemName.value = p.systemName || DEFAULT_SYSTEM_NAME;
        // 裝置識別（INS/H3）：供 sidebar 顯示，支援辨識裝置
        installId.value = p.installId || '';
      } catch { /* ignore */ }
    })();

    // 啟動時讀取版本號與授權狀態（供 sidebar 第三行標示：授權方案 / 版本）
    (async () => {
      try {
        const [ver, lic] = await Promise.all([
          fetch('/api/version', { cache: 'no-store' }).then((r: any) => r.json()).catch(() => ({})),
          api.get('/license-state').catch(() => ({})),
        ]);
        if (ver && ver.version) appVersion.value = ver.version;
        if (ver && ver.edition) edition.value = ver.edition;
        if (lic && lic.mode) licenseState.value = lic;
      } catch { /* ignore */ }
    })();
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    title.value = (VIEWS[route.value] && VIEWS[route.value].title) || '儀表板';
  }, [route.value]);

  const logout = async () => {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    api.setToken(null);
    user.value = null;
  };

  const role = user.value?.role;
  // 收合狀態：{ [group]: true } 表示已收合；預設全部展開
  const collapsed = useSignal<any>({});
  const toggleGroup = (label: any) => {
    const next = { ...collapsed.value };
    next[label] = !next[label];
    collapsed.value = next;
  };
  // 主功能區（整個 sidebar）收合狀態
  const sidebarCollapsed = useSignal(false);
  const toggleSidebar = () => { sidebarCollapsed.value = !sidebarCollapsed.value; };

  return (
    <div class={'app' + (sidebarCollapsed.value ? ' sidebar-collapsed' : '')}>
      <aside class="sidebar">
        <div class="brand">
          {companyInfo.value.logo ? (
            <img src={companyInfo.value.logo} alt="Logo" class="brand-logo" />
          ) : null}
          <span>
            {companyInfo.value.name}
            <small>{systemName.value || DEFAULT_SYSTEM_NAME}</small>
            <small class="brand-lic">{licenseBadge()}{appVersion.value ? '　Ver.' + appVersion.value : ''}{installId.value ? '　裝置 ' + installId.value.slice(-8).toUpperCase() : ''}</small>
          </span>
        </div>
        <nav>
          {NAV.map((g: any) => {
            const items = (g.children || []).filter((n: any) => {
              if (!(n.roles || []).includes(role)) return false;
              // 供應商專屬（superOnly）：僅超級管理員（isSuperAdmin）可見
              if (n.superOnly && !user.value?.isSuperAdmin) return false;
      // 單機盒裝版：隱藏網路設定（僅網路企業版開放）
      if (n.key === 'network-settings' && edition.value === 'single') return false;
              return true;
            });
            if (!items.length) return null;
            // 收合完全由使用者點擊控制；初始 collapsed 為空=全展開，深連結/重整時所屬群組預設仍展開
            const isCollapsed = !!collapsed.value[g.group];
            const GIcon = GROUP_ICONS[g.group];
            const mod = GROUP_COLORS[g.group] || '#5EEAD4';
            return (
              <div class="nav-group" style={`--mod:${mod}`}>
                <button
                  type="button"
                  class={`nav-group-toggle${isCollapsed ? '' : ' expanded'}`}
                  onClick={() => toggleGroup(g.group)}
                  aria-expanded={!isCollapsed}
                >
                  {GIcon ? <span class="nav-ico" aria-hidden="true"><GIcon /></span> : null}
                  <span class="nav-group-label">{g.group}</span>
                  <span class="nav-chevron">▾</span>
                </button>
                <div class={`nav-submenu${isCollapsed ? '' : ' open'}`}>
                  {items.map((n: any) => {
                    const IIcon = ITEM_ICONS[n.key];
                    return (
                      <a href={`#/${n.key}`} class={route.value === n.key ? 'active' : ''}>
                        {IIcon ? <span class="nav-ico" aria-hidden="true"><IIcon /></span> : null}
                        <span>{n.label}</span>
                      </a>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>
        <div class="sidebar-foot">
          <div id="user-box">
            <div><b>{user.value?.emp_id || user.value?.username}</b> {user.value?.name}</div>
            <div class="muted" style="color:#7FA3BC">{ROLE_LABEL[role] || role}</div>
          </div>
          <button class="btn-ghost" onClick={logout}>登出</button>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <button class="sidebar-toggle" onClick={toggleSidebar} title={sidebarCollapsed.value ? "展開功能區" : "收合功能區"} aria-label="切換功能區">{sidebarCollapsed.value ? "☰" : "◀"}</button>
          <div id="page-title">{title.value}</div>
          <div class="page-actions" id="page-actions" />
        </header>
        <PwaInstall />
        <section class="content">
          <View />
        </section>
      </main>
    </div>
  );
}

export default function App() {
  // 重整頁面時 token 已由 localStorage 還原，但 user 為 null。
  // 在此頂層主動以 /auth/me 重建 user（只要 token 未到期，就不會被踢回登入）。
  const initializing = useSignal(true);
  useEffect(() => {
    if (token.value && !user.value) {
      api.get('/auth/me').then((me) => {
        // 🔒 B2：仍須改密者不自动進入主頁，停在登入（改密）流程
        if (!me.user.mustChangePwd) user.value = me.user;
      }).catch(() => {
        // token 失效/到期 → 清除（api.request 的 401 處理已清，此處再保險）
        api.setToken(null);
      }).finally(() => {
        initializing.value = false;
      });
    } else {
      initializing.value = false;
    }
  }, []);

  // 還原中：顯示載入畫面，避免閃一下登入頁
  if (initializing.value) {
    return (
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:12px;background:var(--bg,#f4f6f9)">
        <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
        <div style="width:28px;height:28px;border:3px solid #2d5a87;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite" />
        <div class="muted">載入中…</div>
      </div>
    );
  }

  return (
    <>
      {token.value && user.value ? <Shell /> : <Login />}
      <ToastHost />
      <ConfirmHost />
      <div id="modal-root" />
    </>
  );
}
