// 全域狀態（Preact signals）
import { signal } from '@preact/signals';

const TOKEN_KEY = 'app_token';

export const token = signal(localStorage.getItem(TOKEN_KEY) || null);
export const user = signal(null);
export const toasts = signal([]);
// 確認對話框狀態（宣告式 ConfirmHost 使用；confirmDialog() 僅設定 signal 並回傳 Promise）
export const confirmBox = signal<{ msg: string; resolve: (_v: boolean) => void } | null>(null);
// 全域公司資訊（從 /api/company-profile 讀取，系統外觀頁面可修改）
// 初始值為空：未設定公司名稱時，所有頁面預設顯示空白（不顯示預設名稱）
export const companyInfo = signal({ name: '', nameEn: '', taxId: '', address: '', phone: '', fax: '', logo: '', background: '' });

// 系統名稱（單一來源：config.json 的 app_name，由 /api/company-profile 提供）
// 用於登入頁副標題與瀏覽器分頁標題；取不到時回退 DEFAULT_SYSTEM_NAME。
// 註：index.html 的靜態 <title> 需與 DEFAULT_SYSTEM_NAME 保持一致（JS 載入後會即時覆蓋）。
export const DEFAULT_SYSTEM_NAME = '輔凰商貿訂單暨應收帳款系統';
export const systemName = signal('');
systemName.subscribe((v: any) => { if (v) document.title = v; });

// 系統版本號（來源：/api/version，讀根 version.json）
export const appVersion = signal('');
// 系統版本類型（'single'=單機盒裝版 / 'network'=網路企業版 / ''=未標示，預設網路版）
export const edition = signal('');
// 裝置識別（來源：/api/company-profile 公開欄位 installId，使用者登入前後皆可得）
export const installId = signal('');
// 授權狀態快照（來源：/api/license-state，所有登入使用者可讀；供 sidebar 顯示授權方案/版本）
export const licenseState = signal<any>({ mode: 'open', plan: '', licensee: '', expiresAt: '' });

// token 變動時同步 localStorage
token.subscribe((v: any) => {
  if (v) localStorage.setItem(TOKEN_KEY, v);
  else localStorage.removeItem(TOKEN_KEY);
});

let toastId = 0;
export function toast(msg: any, type = '') {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, msg, type }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t: any) => t.id !== id);
  }, 3000);
}

/** 目前路由（hash）。去掉 query 部分（#/doc-verify?q=xxx 仍路由到 doc-verify，query 由該頁自行讀取） */
export const route = signal(((location.hash.replace(/^#\//, '').split('?')[0]) || 'system-map'));

export function navigate(key: any) {
  location.hash = '#/' + key;
}
