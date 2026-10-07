// @ts-nocheck
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';

const ACTION_LABELS: any = {
  create: '新增', update: '修改', delete: '刪除', deactivate: '停用',
  login: '登入', login_mfa: 'MFA 登入', logout: '登出',
  change_password: '改密碼', mfa_enable: '啟用 MFA', mfa_disable: '停用 MFA',
  mfa_disable_admin: '管理者停用 MFA', restore: '還原', vacuum: 'VACUUM',
  export: '匯出', import: '匯入',
};
const ENTITY_LABELS: any = {
  users: '使用者', customers: '客戶', products: '產品', orders: '訂單',
  quotations: '報價單', shipments: '出貨單', receivables: '應收', payables: '應付',
  auth: '認證', audit_logs: '日誌',
};

function fmtAction(a: string) {
  return ACTION_LABELS[a] || a;
}
function fmtEntity(e: string) {
  return ENTITY_LABELS[e] || e;
}

export default function AuditLog() {
  const rows = useSignal<any[]>([]);
  const total = useSignal(0);
  const page = useSignal(0);
  const pageSize = useSignal(20);
  const entity = useSignal('');
  const action = useSignal('');
  const keyword = useSignal('');
  const actor = useSignal('');
  const from = useSignal('');
  const to = useSignal('');
  const busy = useSignal(false);
  const msg = useSignal('');

  const load = async () => {
    busy.value = true;
    msg.value = '';
    try {
      const r = await api.get('/audit', {
        entity: entity.value,
        action: action.value,
        keyword: keyword.value,
        actor: actor.value,
        from: from.value,
        to: to.value,
        limit: pageSize.value,
        offset: page.value * pageSize.value,
      });
      rows.value = r.rows || [];
      total.value = r.total || 0;
    } catch (e: any) {
      msg.value = e.message || '載入失敗';
    } finally {
      busy.value = false;
    }
  };

  useEffect(() => { load(); }, []);

  const pageCount = () => Math.max(1, Math.ceil(total.value / pageSize.value));
  const resetPage = () => { page.value = 0; load(); };

  return (
    <div class="view audit-log">
      <h2>操作日誌查詢</h2>
      <p class="muted">查詢系統內重要資料的新增／修改／刪除與登入等軌跡（保留最長 365 天）。</p>

      <div class="audit-filters">
        <label>物件
          <select value={entity.value} onChange={(e: any) => (entity.value = e.currentTarget.value)}>
            <option value="">全部</option>
            <option value="users">使用者</option>
            <option value="customers">客戶</option>
            <option value="products">產品</option>
            <option value="orders">訂單</option>
            <option value="quotations">報價單</option>
            <option value="shipments">出貨單</option>
            <option value="receivables">應收</option>
            <option value="payables">應付</option>
          </select>
        </label>
        <label>動作
          <select value={action.value} onChange={(e: any) => (action.value = e.currentTarget.value)}>
            <option value="">全部</option>
            <option value="create">新增</option>
            <option value="update">修改</option>
            <option value="delete">刪除</option>
            <option value="deactivate">停用</option>
            <option value="login">登入</option>
            <option value="login_mfa">MFA 登入</option>
            <option value="change_password">改密碼</option>
            <option value="mfa_enable">啟用 MFA</option>
            <option value="mfa_disable">停用 MFA</option>
          </select>
        </label>
        <label>操作者（工號）
          <input type="text" placeholder="工號關鍵字" value={actor.value}
            onInput={(e: any) => (actor.value = e.currentTarget.value)} />
        </label>
        <label>關鍵字
          <input type="text" placeholder="物件ID / 細節" value={keyword.value}
            onInput={(e: any) => (keyword.value = e.currentTarget.value)} />
        </label>
        <label class="date-pair">
          <span>起</span>
          <input type="date" value={from.value} onChange={(e: any) => (from.value = e.currentTarget.value)} />
          <span>迄</span>
          <input type="date" value={to.value} onChange={(e: any) => (to.value = e.currentTarget.value)} />
        </label>
        <div class="btn-row">
          <button class="btn-primary" onClick={resetPage} disabled={busy.value}>查詢</button>
          <button class="btn-ghost" onClick={() => {
            entity.value = ''; action.value = ''; actor.value = ''; keyword.value = ''; from.value = ''; to.value = '';
            resetPage();
          }}>清除</button>
        </div>
      </div>

      {msg.value ? <div class="login-msg">{msg.value}</div> : null}

      <div class="audit-meta">共 {total.value} 筆，第 {page.value + 1} / {pageCount()} 頁</div>

      <table class="tbl audit-tbl">
        <thead>
          <tr>
            <th>時間</th><th>操作者</th><th>動作</th><th>物件</th><th>物件ID</th><th>細節</th>
          </tr>
        </thead>
        <tbody>
          {rows.value.length === 0 ? (
            <tr><td colspan={6} class="muted" style="text-align:center;padding:18px">尚無符合的日誌</td></tr>
          ) : rows.value.map((r: any) => (
            <tr key={r.id}>
              <td class="nowrap">{r.created_at}</td>
              <td>{r.emp_id}{r.user_name ? `（${r.user_name}）` : ''}</td>
              <td>{fmtAction(r.action)}</td>
              <td>{fmtEntity(r.entity)}</td>
              <td>{r.entity_id || '—'}</td>
              <td class="audit-detail">{r.detail || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div class="audit-pager">
        <button disabled={page.value <= 0 || busy.value} onClick={() => { page.value--; load(); }}>上一頁</button>
        <button disabled={page.value + 1 >= pageCount() || busy.value} onClick={() => { page.value++; load(); }}>下一頁</button>
      </div>
    </div>
  );
}
AuditLog.title = '操作日誌查詢';
