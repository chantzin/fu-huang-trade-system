// 操作日誌 Tab（系統管理）
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../../api.ts';
import { toast } from '../../store.ts';
import Table from '../../ui/Table.tsx';
import Pagination from '../../ui/Pagination.tsx';
import { esc } from '../../ui/format.ts';

export default function LogsTab() {
  const logs = useSignal([]);
  const page = useSignal(1);
  const pageSize = useSignal(50);
  useEffect(() => { api.get('/params/audit-logs?limit=300').then((l: any) => { logs.value = l; }).catch((e: any) => toast(e.message, 'err')); }, []);
  const pagedLogs = () => {
    const start = (page.value - 1) * pageSize.value;
    return logs.value.slice(start, start + pageSize.value);
  };
  return (
    <div class="card"><h3>操作日誌（最近 300 筆）</h3>
      <Table columns={[
        { key: 'created_at', label: '時間' },
        { key: 'emp_id', label: '工號' },
        { key: 'user_name', label: '姓名' },
        { key: 'action', label: '動作' },
        { key: 'entity', label: '資料表' },
        { key: 'entity_id', label: '對象' },
        { key: 'detail', label: '摘要', render: (r: any) => esc(r.detail || '') },
      ]} rows={pagedLogs()} empty="尚無紀錄" />
      <Pagination page={page.value} pageSize={pageSize.value} total={logs.value.length}
        onPageChange={(p: any) => (page.value = p)}
        onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
    </div>
  );
}
