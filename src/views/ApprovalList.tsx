// 文件簽核三子頁共用（待簽核 / 已簽核 / 待更改）
//
// ⚠️ 本頁會「混列多種文件類型」（供應商訂單 / 出貨單 / 客戶報價單），
//    因此清單與檢視一律使用後端提供的通用欄位：
//      doc_type / doc_label / doc_no / doc_date / party_name / party_label
//    切勿再把 docType 寫死成 'supplier-order'，否則其他文件類型會出現
//    「單號空白」＋點檢視時 404「文件不存在」。
import { useSignal, useComputed } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';
import Table from '../ui/Table.tsx';
import Pagination from '../ui/Pagination.tsx';
import Modal from '../ui/Modal.tsx';
import { esc, num, date, tag } from '../ui/format.ts';

const APPROVAL_STATUS: any = {
  none: ['未送核', 'gray'],
  pending: ['待簽核', 'blue'],
  approved: ['已同意', 'green'],
  rejected: ['已否決', 'red'],
  returned: ['待修改', 'yellow'],
};
const _ACTION_LABEL: any = { submit: '送核', approve: '核准', reject: '駁回', return: '退回' };

// docType → 該單據的編輯頁 hash（退回後「開啟編輯」用）
const EDIT_HASH: any = {
  'supplier-order': 'supplier-orders',
  'shipment': 'shipments',
  'quote': 'quotes',
};
// 後端 doc_label 若缺（舊資料）時的回退表
const DOC_LABEL_FALLBACK: any = {
  'supplier-order': '供應商訂單',
  'shipment': '出貨單',
  'quote': '客戶報價單',
};

const docLabel = (r: any) => r?.doc_label || DOC_LABEL_FALLBACK[r?.doc_type] || r?.doc_type || '';
const partyLabel = (r: any) => r?.party_label || '對象';
/** 唯一鍵：不同文件類型可能有相同 id，須以 docType:id 區辨 */
const rowKey = (r: any) => `${r.doc_type}:${r.id}`;

export default function ApprovalList({ mode, title: _title }: any) {
  const rows = useSignal([]);
  const loading = useSignal(true);
  const kw = useSignal('');
  const page = useSignal(1);
  const pageSize = useSignal(20);
  const detail = useSignal<any>(null);
  const showDetail = useSignal(false);
  const comment = useSignal('');
  const delegateName = useSignal('');
  const busy = useSignal(false);

  const load = async () => {
    loading.value = true;
    try { rows.value = await api.get(`/approvals/${mode}`); }
    catch (e: any) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };
  useEffect(() => { load(); }, [mode]);

  const filtered = useComputed(() => {
    const k = kw.value.trim().toLowerCase();
    if (!k) return rows.value;
    return rows.value.filter((r: any) => [r.doc_no, r.party_name, r.submitter_name, r.note, docLabel(r)]
      .filter(Boolean).some((v: any) => String(v).toLowerCase().includes(k)));
  });
  const pagedRows = useComputed(() => {
    const start = (page.value - 1) * pageSize.value;
    return filtered.value.slice(start, start + pageSize.value);
  });
  const resetPage = () => { page.value = 1; };

  // 依文件類型打對應的檢視 API（docType:id 唯一鍵）
  const openDetail = async (r: any) => {
    try {
      const full = await api.get(`/approvals/doc/${r.doc_type}/${r.id}`);
      detail.value = full;
      showDetail.value = true;
      comment.value = '';
      delegateName.value = '';
    } catch (e: any) { toast(e.message, 'err'); }
  };

  const act = async (action: string) => {
    if (!detail.value) return;
    busy.value = true;
    try {
      await api.post(`/approvals/doc/${detail.value.doc_type}/${detail.value.id}/${action}`,
        { comment: comment.value, delegate_name: delegateName.value.trim() });
      toast(action === 'approve' ? '已核准' : action === 'reject' ? '已駁回' : '已退回', 'ok');
      showDetail.value = false;
      load();
    } catch (e: any) { toast(e.message, 'err'); }
    finally { busy.value = false; }
  };

  // 待簽核列表的使用者必為當前關卡核決人（後端已過濾），可直接行使核准/駁回/退回
  const canApprove = mode === 'pending';

  const columns = [
    { key: 'approval', label: '簽核狀態', render: (r: any) => {
        const st = APPROVAL_STATUS[r.approval_status] || APPROVAL_STATUS.none;
        return tag(st[0], st[1]);
      } },
    { key: 'doc_label', label: '單據別', render: (r: any) => esc(docLabel(r)) },
    { key: 'doc_no', label: '單號', render: (r: any) => `<b>${esc(r.doc_no || '-')}</b>` },
    { key: 'party_name', label: '對象', render: (r: any) => esc(r.party_name || '-') },
    { key: 'amount_total', label: '金額', render: (r: any) => num(r.amount_total) },
    { key: 'doc_date', label: '日期', render: (r: any) => date(r.doc_date) || '-' },
    { key: 'submitter_name', label: '送核人', render: (r: any) => r.submitter_name || '-' },
    { key: '_act', label: '動作', render: (r: any) => `<button class="btn btn-sm" data-view="${rowKey(r)}">檢視</button>` },
  ];

  const onTblClick = (e: any) => {
    const b = e.target?.closest?.('[data-view]');
    if (b) {
      const key = String(b.dataset.view);
      const r = rows.value.find((x: any) => rowKey(x) === key);
      if (r) openDetail(r);
    }
  };

  return (
    <>
      <div class="toolbar">
        <div class="fld"><label>關鍵字</label>
          <input value={kw.value} onInput={(e: any) => { kw.value = e.currentTarget.value; resetPage(); }}
            placeholder="單號／對象／送核人" /></div>
        <div class="spacer" />
        <button class="btn" onClick={load}>重新整理</button>
      </div>
      {loading.value
        ? <div class="empty">載入中…</div>
        : <>
            {!rows.value.length
              ? <div class="empty">{mode === 'pending' ? '目前沒有待您核決的文件' : mode === 'done' ? '尚無已同意文件' : '目前沒有被退回的文件'}</div>
              : <div onClick={onTblClick}><Table columns={columns} rows={pagedRows.value} /></div>}
            <Pagination page={page.value} pageSize={pageSize.value} total={filtered.value.length}
              onPageChange={(p: any) => (page.value = p)}
              onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
          </>}
      {showDetail.value && detail.value && (
        <ApprovalDetailModal d={detail.value} mode={mode} comment={comment.value}
          onComment={(v: any) => (comment.value = v)}
          delegateName={delegateName.value} onDelegate={(v: any) => (delegateName.value = v)}
          canApprove={canApprove} busy={busy.value}
          onAct={act}
          onEdit={() => {
            const h = EDIT_HASH[detail.value.doc_type];
            showDetail.value = false;
            if (h) location.hash = `#/${h}?edit=${detail.value.id}`;
            else toast('此文件類型不支援開啟編輯', 'warn');
          }}
          onClose={() => (showDetail.value = false)} />
      )}
    </>
  );
}

function ApprovalDetailModal({ d, mode, comment, onComment, delegateName, onDelegate, canApprove, busy, onAct, onEdit, onClose }: any) {
  const step = d.approval_step;
  const flow = d.approval_flow;
  const items = d.items || [];
  const logs = d.logs || [];
  const label = docLabel(d);

  // 狀態圖示：已同意✓／已否決✗／待修改↺／目前關卡○
  const statusIcon = (l: any) => {
    if (l.status_label === '已同意' || l.action === 'approve') return <span style="color:#16a34a;font-weight:700">✓</span>;
    if (l.status_label === '已否決' || l.action === 'reject') return <span style="color:#dc2626;font-weight:700">✗</span>;
    if (l.status_label === '待修改' || l.action === 'return') return <span style="color:#d97706;font-weight:700">↺</span>;
    return <span style="color:#9ca3af">○</span>;
  };
  // 耗時：finished_at - notified_at
  const duration = (l: any) => {
    if (!l.notified_at || !l.finished_at) return '-';
    const ms = new Date(String(l.finished_at).replace(' ', 'T')).getTime()
      - new Date(String(l.notified_at).replace(' ', 'T')).getTime();
    if (isNaN(ms) || ms < 0) return '-';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}秒`;
    if (s < 3600) return `${Math.floor(s / 60)}分${s % 60}秒`;
    return `${Math.floor(s / 3600)}時${Math.floor((s % 3600) / 60)}分`;
  };
  return (
    <Modal title={`${d.doc_no || ''} — 簽核檢視`} wide onClose={onClose}
      saveText="關閉" onSave={onClose}>
      <div class="form-grid" style="margin-bottom:10px">
        <div><label class="f">單據別</label><b>{esc(label)}</b></div>
        <div><label class="f">單號</label><b>{esc(d.doc_no || '')}</b></div>
        <div><label class="f">{esc(partyLabel(d))}</label>{esc(d.party_name || '')}{d.party_code ? `（${esc(d.party_code)}）` : ''}</div>
        <div><label class="f">單據日期</label>{date(d.doc_date) || '-'}</div>
        <div><label class="f">金額</label><b>{num(d.amount_total)}</b></div>
        <div><label class="f">簽核狀態</label>
          {(APPROVAL_STATUS[d.approval_status] || APPROVAL_STATUS.none)[0]}</div>
      </div>
      {step && (
        <div style="background:#f4f7fb;border:1px solid #dbe3f0;border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:13px">
          <b>目前關卡：</b>{esc(step.step_name || `第 ${step.step_no} 層`)}
          {flow && flow.steps && flow.steps.length > 1 && <span style="color:#6b7280">（共 {flow.steps.length} 層）</span>}
          ｜ 核決主管：{step.approver_ids?.length ? step.approver_ids.map((id: any) => d._userNames?.[id] || `#${id}`).join('、') : '（未設定）'}
        </div>
      )}
      {items.length > 0 && (
        <div style="margin-bottom:10px">
          <div style="font-weight:600;font-size:13px;margin-bottom:6px">單據明細</div>
          <table class="tbl-simple" style="width:100%;font-size:12.5px">
            <thead><tr><th>料號</th><th>品名規格</th><th style="text-align:right">數量</th><th>單位</th><th style="text-align:right">單價</th><th style="text-align:right">金額</th></tr></thead>
            <tbody>
              {items.map((it: any) => (
                <tr><td>{esc(it.part_no || '')}</td><td>{esc(it.description || '')}</td>
                  <td style="text-align:right">{num(it.qty)}</td><td>{esc(it.unit || 'PCS')}</td>
                  <td style="text-align:right">{num(it.unit_price)}</td><td style="text-align:right">{num(it.amount)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style="background:#fafbfe;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:12px">
        <div style="font-weight:600;font-size:13px;margin-bottom:6px">簽核歷史</div>
        {!logs.length && <div style="font-size:12.5px;color:#6b7280">尚未送核</div>}
        {logs.length > 0 && (
          <table class="tbl-simple" style="width:100%;font-size:12px">
            <thead>
              <tr>
                <th>流程狀態</th><th>關卡名稱</th><th>核決人員</th><th>狀態</th>
                <th>簽核意見</th><th>代理人</th><th>送達時間</th><th>結束時間</th><th>耗時</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l: any) => (
                <tr>
                  <td>{esc(l.status_label || (l.action === 'submit' ? '送件' : l.action === 'pending' ? '待核' : '-'))}</td>
                  <td>{esc(l.step_name || (l.step_no > 0 ? `第 ${l.step_no} 層` : ''))}</td>
                  <td>{esc(l.actor_name || '（待核）')}</td>
                  <td>{statusIcon(l)}</td>
                  <td style="max-width:220px">{l.comment ? esc(l.comment) : '-'}</td>
                  <td>{esc(l.delegate_name || '-')}</td>
                  <td style="white-space:nowrap">{l.notified_at || '-'}</td>
                  <td style="white-space:nowrap">{l.finished_at || '-'}</td>
                  <td style="white-space:nowrap;color:#6b7280">{duration(l)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {mode === 'pending' && canApprove && (
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 12px">
          <label class="f">核決意見（可留空）</label>
          <textarea value={comment} onInput={(e: any) => onComment(e.currentTarget.value)} rows={2} style="width:100%;margin-top:4px"
            placeholder="請填寫核准／駁回／退回意見…" />
          <label class="f" style="margin-top:8px">代簽人（代理人核簽時填寫，本人親簽請留空）</label>
          <input value={delegateName} onInput={(e: any) => onDelegate(e.currentTarget.value)}
            placeholder="例如：張主任（代理人）" style="width:100%;margin-top:4px" />
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn btn-primary" disabled={busy} onClick={() => onAct('approve')}>核准</button>
            <button class="btn btn-danger" disabled={busy} onClick={() => onAct('reject')}>駁回</button>
            <button class="btn btn-warn" disabled={busy} onClick={() => onAct('return')}>退回</button>
            {busy && <span style="font-size:12px;color:#6b7280;align-self:center">處理中…</span>}
          </div>
        </div>
      )}
      {mode === 'returned' && (
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 12px;font-size:13px">
          此文件已被退回，可<b>開啟編輯</b>修改後重新送核。
          <div style="margin-top:8px">
            <button class="btn btn-primary" onClick={onEdit}>開啟編輯</button>
          </div>
        </div>
      )}
      {mode === 'done' && (
        <div style="font-size:12.5px;color:#6b7280">已同意／已否決文件為終態，不可再修改。</div>
      )}
    </Modal>
  );
}
