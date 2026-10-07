// API 封裝：自動附加 Bearer Token，統一錯誤處理（ESM 版，供 Preact 使用）
import { token, user } from './store.ts';

async function request(method: string, path: string, body: any = null, opts: any = {}) {
  const headers: any = {};
  if (!opts.noAuth) {
    const t = token.value;
    if (t) headers.Authorization = 'Bearer ' + t;
  }
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch('/api' + path, {
    method, headers,
    body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
  });
  if (res.status === 401 && !opts.noAuth) {
    token.value = null;
    user.value = null;
    throw new Error('登入已逾時，請重新登入');
  }
  if (opts.binary) return res;
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
  return data;
}

/** 共用：把 binary response 轉為 blob 並觸發瀏覽器下載（B4 重構：消除三處重複） */
function blobDownload(res: any, filename: any) {
  return res.blob().then((blob: any) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'download';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  });
}

export const api = {
  getToken: () => token.value,
  setToken: (t: any) => { token.value = t; },
  get: (p: string, o: any = undefined) => {
    // o 為 query 參數（物件的非空值附加為 query string）
    let url = p;
    if (o && typeof o === 'object') {
      const sp = new URLSearchParams();
      Object.entries(o).forEach(([k, v]: any) => {
        if (v !== '' && v !== undefined && v !== null) sp.set(k, String(v));
      });
      const qs = sp.toString();
      if (qs) url = p + (p.includes('?') ? '&' : '?') + qs;
    }
    return request('GET', url, null, undefined);
  },
  post: (p: string, b: any = undefined, o: any = undefined) => request('POST', p, b, o),
  put: (p: string, b: any = undefined, o: any = undefined) => request('PUT', p, b, o),
  del: (p: string, o: any = undefined) => request('DELETE', p, null, o),
  login: (empId: string, password: string) => request('POST', '/auth/login', { empId, password }, { noAuth: true }),

  /** 下載 Excel（報表匯出／匯入範本） */
  download: async (path: any, filename: any) => {
    const res = await request('GET', path, null, { binary: true });
    return blobDownload(res, filename || 'export.xlsx');
  },

  /** 在瀏覽器內嵌 PDF viewer 檢視 */
  openPdf: async (path: any) => {
    const res = await request('GET', path, null, { binary: true });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },

  /** 直接下載 PDF */
  downloadPdf: async (path: any, filename: any) => {
    const res = await request('GET', path, null, { binary: true });
    return blobDownload(res, filename || 'export.pdf');
  },

  /** 批次合併下載 PDF（POST，走統一 request 含 401 處理） */
  downloadBatchPdf: async (body: any, filename: any) => {
    const res = await request('POST', '/pdf/batch', body, { binary: true });
    return blobDownload(res, filename || 'batch.pdf');
  },

  /** Email 寄送（POST） */
  sendEmail: async (path: any, body: any) => {
    return request('POST', path, body);
  },

  emailPreview: async () => request('GET', '/email/preview'),

  /** 郵件設定（SMTP） */
  getMailConfig: () => request('GET', '/mail-config'),
  saveMailConfig: (data: any) => request('POST', '/mail-config', data),
  testMailConfig: (testEmail: any) => request('POST', '/mail-config/test', { test_email: testEmail }),

  /** 裝置識別（H3） */
  getInstallInfo: () => request('GET', '/system/install-info'),

  /** 診斷資訊（H4，JSON） */
  getDiagnostics: () => request('GET', '/system/diagnostics'),

  /** 下載診斷包 ZIP（H4） */
  downloadDiagnostics: async () => {
    const res = await request('GET', '/system/diagnostics/download', null, { binary: true });
    return blobDownload(res, 'diagnostics-' + Date.now() + '.zip');
  },

  /** 還原演練（H2，非破壞性） */
  restoreDrill: () => request('POST', '/system/backup/restore-drill'),

  /** 資料庫 VACUUM（M2） */
  vacuumDb: () => request('POST', '/system/db/vacuum'),

  /** 郵件發送紀錄 */
  getMailLogs: (params: any = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.search) q.set('search', params.search);
    if (params.page) q.set('page', String(params.page));
    if (params.pageSize) q.set('pageSize', String(params.pageSize));
    return request('GET', '/mail-logs?' + q.toString());
  },

  /** 手冊外部化（Markdown 動態載入） */
  getManual: (type: any) => request('GET', '/manuals/' + type),
};

export default api;
