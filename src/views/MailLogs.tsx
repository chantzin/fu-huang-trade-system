// 郵件發送紀錄（從 audit_logs 查詢 email 相關紀錄，含統計與篩選）
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';
import Pagination from '../ui/Pagination.tsx';

export default function MailLogs() {
  const loading = useSignal(true);
  const rows = useSignal([]);
  const total = useSignal(0);
  const summary = useSignal({ total: 0, sent: 0, failed: 0 });

  // 篩選
  const statusFilter = useSignal('all');
  const search = useSignal('');
  const page = useSignal(1);
  const pageSize = useSignal(50);

  // 展開的紀錄（檢視詳情）
  const expandedId = useSignal(null);

  useEffect(() => {
    loadLogs();
  }, [statusFilter.value, page.value, pageSize.value]);

  async function loadLogs() {
    loading.value = true;
    try {
      const r = await api.getMailLogs({
        status: statusFilter.value,
        search: search.value,
        page: page.value,
        pageSize: pageSize.value,
      });
      rows.value = r.rows || [];
      total.value = r.total || 0;
      summary.value = r.summary || { total: 0, sent: 0, failed: 0 };
    } catch (e) {
      toast('載入郵件發送紀錄失敗：' + e.message, 'err');
    } finally {
      loading.value = false;
    }
  }

  function doSearch() {
    page.value = 1;
    loadLogs();
  }

  function setStatus(s: any) {
    statusFilter.value = s;
    page.value = 1;
  }

  function toggleExpand(id: any) {
    expandedId.value = expandedId.value === id ? null : id;
  }

  function statusBadge(status: any) {
    if (status === 'failed') {
      return <span style="background:#FDEDEC;color:#C0392B;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600">失敗</span>;
    }
    return <span style="background:#E6F7EC;color:#1B8A3A;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600">成功</span>;
  }

  function actionLabel(action: any) {
    const map: any = {
      'email.send': '寄送單據',
      'email.send_failed': '寄送失敗',
      'email.test': '測試郵件',
      'email.test_failed': '測試失敗',
    };
    return map[action] || action;
  }

  function entityLabel(entity: any) {
    const map: any = {
      order: '訂單', shipment: '出貨單', batch: '批次寄送', mail_config: '測試',
    };
    return map[entity] || entity || '';
  }

  return (
    <div>
      {/* 統計卡片 */}
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
        <div class="card" style="padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#0F766E">{summary.value.total}</div>
          <div style="font-size:12px;color:#98A0AC;margin-top:2px">總發送次數</div>
        </div>
        <div class="card" style="padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#1B8A3A">{summary.value.sent}</div>
          <div style="font-size:12px;color:#98A0AC;margin-top:2px">成功</div>
        </div>
        <div class="card" style="padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#C0392B">{summary.value.failed}</div>
          <div style="font-size:12px;color:#98A0AC;margin-top:2px">失敗</div>
        </div>
      </div>

      {/* 篩選列 */}
      <div class="card" style="padding:14px 16px;margin-bottom:16px">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          {/* 狀態篩選 */}
          <div style="display:flex;gap:4px">
            {[
              { v: 'all', label: '全部' },
              { v: 'sent', label: '成功' },
              { v: 'failed', label: '失敗' },
            ].map((opt: any) => (
              <button onClick={() => setStatus(opt.v)}
                style={`padding:6px 14px;border-radius:6px;font-size:13px;cursor:pointer;border:1px solid;${statusFilter.value === opt.v
                  ? 'background:#0F766E;color:#fff;border-color:#0F766E'
                  : 'background:#fff;color:#5A6270;border-color:#D1D5DB'}`}>
                {opt.label}
              </button>
            ))}
          </div>

          {/* 關鍵字搜尋 */}
          <input type="text" value={search.value}
            onInput={(e: any) => (search.value = e.currentTarget.value)}
            onKeyDown={(e: any) => { if (e.key === 'Enter') doSearch(); }}
            placeholder="搜尋收件者 / 單號 / 操作者"
            style="flex:1;min-width:200px;padding:7px 12px;border:1px solid #D1D5DB;border-radius:6px;font-size:13px" />
          <button onClick={doSearch}
            style="padding:7px 16px;background:#0F766E;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer">
            🔍 搜尋
          </button>
          <button onClick={() => { search.value = ''; statusFilter.value = 'all'; page.value = 1; doSearch(); }}
            style="padding:7px 14px;background:#F4F6F8;color:#5A6270;border:1px solid #D1D5DB;border-radius:6px;font-size:13px;cursor:pointer">
            重置
          </button>
        </div>
      </div>

      {/* 紀錄列表 */}
      <div class="card" style="padding:0;overflow:hidden">
        {loading.value ? (
          <div style="padding:40px;text-align:center;color:#98A0AC">載入中…</div>
        ) : rows.value.length === 0 ? (
          <div style="padding:40px;text-align:center;color:#98A0AC">
            <div style="font-size:32px;margin-bottom:8px">📭</div>
            尚無郵件發送紀錄
          </div>
        ) : (
          <div>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead>
                <tr style="background:#F4F6F8">
                  <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #E4E7EB;width:140px">時間</th>
                  <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #E4E7EB;width:80px">操作者</th>
                  <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #E4E7EB;width:90px">類型</th>
                  <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #E4E7EB">收件者 / 主旨</th>
                  <th style="padding:10px 12px;text-align:center;border-bottom:1px solid #E4E7EB;width:70px">狀態</th>
                  <th style="padding:10px 12px;text-align:center;border-bottom:1px solid #E4E7EB;width:60px">詳情</th>
                </tr>
              </thead>
              <tbody>
                {rows.value.map((r: any) => (
                  <>
                    <tr style={{ borderBottom: '1px solid #F0F2F5', cursor: 'pointer' }}
                      onClick={() => toggleExpand(r.id)}
                      onMouseOver={(e: any) => (e.currentTarget.style.background = '#F8FAFB')}
                      onMouseOut={(e: any) => (e.currentTarget.style.background = 'transparent')}>
                      <td style="padding:10px 12px;font-size:12px;color:#5A6270;white-space:nowrap">{r.created_at}</td>
                      <td style="padding:10px 12px;font-size:12px;color:#333">{r.emp_id || '-'}</td>
                      <td style="padding:10px 12px;font-size:12px;color:#333">
                        <span style="background:#ECFDF5;color:#0F766E;padding:2px 8px;border-radius:4px;font-size:11px">
                          {entityLabel(r.entity)}
                        </span>
                      </td>
                      <td style="padding:10px 12px;font-size:13px;color:#333">
                        <div style="font-weight:500">{r.subject || actionLabel(r.action)}</div>
                        {r.recipient && <div style="font-size:11px;color:#98A0AC;margin-top:2px">📧 {r.recipient}</div>}
                      </td>
                      <td style="padding:10px 12px;text-align:center">{statusBadge(r.status)}</td>
                      <td style="padding:10px 12px;text-align:center;font-size:12px;color:#0F766E">
                        {expandedId.value === r.id ? '▲' : '▼'}
                      </td>
                    </tr>
                    {expandedId.value === r.id && (
                      <tr style="background:#F8FAFB">
                        <td colspan={6} style="padding:12px 16px">
                          <div style="font-size:12px;color:#5A6270;line-height:1.8">
                            <div><b>紀錄 ID：</b>{r.id}</div>
                            <div><b>動作：</b>{r.action}</div>
                            <div><b>實體：</b>{r.entity} #{r.entity_id || '-'}</div>
                            <div><b>詳細資料：</b></div>
                            <pre style="background:#fff;border:1px solid #E4E7EB;border-radius:6px;padding:10px;margin-top:6px;font-size:11.5px;overflow-x:auto;white-space:pre-wrap;word-break:break-all">
                              {JSON.stringify(r.detail, null, 2)}
                            </pre>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 分頁 */}
        {total.value > 0 && (
          <Pagination page={page.value} pageSize={pageSize.value} total={total.value}
            onPageChange={(p: any) => (page.value = p)}
            onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
        )}
      </div>

      {/* 說明 */}
      <div style="margin-top:12px;font-size:12px;color:#98A0AC;line-height:1.7">
        💡 郵件發送紀錄來自系統操作日誌（audit_logs），保留期限依系統設定（預設 180 天）。
        點擊任一列可展開檢視詳細資料（含收件者、messageId、錯誤訊息等）。
      </div>
    </div>
  );
}

MailLogs.title = '郵件發送紀錄';
