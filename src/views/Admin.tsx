// 系統管理：使用者（工號）/ 參數設定 / 匯率歷程 / Excel 匯入 / 操作日誌 / 系統資訊
// V2 報告建議：拆分為獨立檔案降低單檔複雜度（原本 502 行 → 容器 ~40 行）
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { user } from '../store.ts';
import UsersTab from './admin/UsersTab.tsx';
import ParamsTab from './admin/ParamsTab.tsx';
import RatesTab from './admin/RatesTab.tsx';
import ImportTab from './admin/ImportTab.tsx';
import LogsTab from './admin/LogsTab.tsx';
import AboutTab from './admin/AboutTab.tsx';

export default function Admin() {
  const role = user.value?.role;
  const metaSig = useSignal(null);
  const active = useSignal(role === 'admin' ? 'users' : 'params');

  useEffect(() => { if (role !== 'sales') api.get('/params/meta').then((m: any) => { metaSig.value = m; }).catch(() => {}); }, [role]);

  if (role === 'sales') return <div class="empty">此頁面僅限主管以上使用</div>;

  const tabs = [];
  if (role === 'admin') tabs.push({ key: 'users', label: '使用者管理' });
  tabs.push({ key: 'params', label: '參數設定' });
  tabs.push({ key: 'rates', label: '匯率歷程' });
  tabs.push({ key: 'import', label: 'Excel 匯入' });
  if (role === 'admin') tabs.push({ key: 'logs', label: '操作日誌' });
  tabs.push({ key: 'about', label: '系統資訊' });

  return (
    <>
      <div class="card">
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          {tabs.map((t: any) =>
            <button class={`btn ${t.key === active.value ? 'btn-primary' : ''}`} onClick={() => (active.value = t.key)}>{t.label}</button>)}
        </div>
      </div>
      {active.value === 'users' && <UsersTab />}
      {active.value === 'params' && <ParamsTab />}
      {active.value === 'rates' && <RatesTab meta={metaSig.value} />}
      {active.value === 'import' && <ImportTab />}
      {active.value === 'logs' && <LogsTab />}
      {active.value === 'about' && <AboutTab meta={metaSig.value} />}
    </>
  );
}
Admin.title = '系統管理';
