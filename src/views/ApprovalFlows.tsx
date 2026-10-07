// 電子簽核 — 流程設定（分析與管理）
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';
import Table from '../ui/Table.tsx';
import Modal, { confirmDialog } from '../ui/Modal.tsx';
import { esc, tag } from '../ui/format.ts';

// ⚠️ 僅為 API 失敗時的後備清單。正常情況下拉由後端 GET /approvals/doc-types 提供（單一來源），
//    以免前後端各維護一份而再度發生「前端清單缺某類型 → 該單據無法送簽」的問題。
const DOC_OPTIONS: any = {
  'supplier-order': '供應商訂單',
  'shipment': '出貨單',
  'quote': '客戶報價單',
};

export default function ApprovalFlows() {
  const rows = useSignal([]);
  const docTypes = useSignal<any[]>([]);
  const allUsers = useSignal([]);
  const loading = useSignal(true);
  const showModal = useSignal(false);
  const editing = useSignal<any>(null);

  const load = async () => {
    loading.value = true;
    try {
      const [res, types] = await Promise.all([
        api.get('/approvals/flows'),
        api.get('/approvals/doc-types').catch(() => []),
      ]);
      rows.value = res;
      // 文件類型清單由後端提供（單一來源）；API 失敗時退回後備清單
      docTypes.value = Array.isArray(types) && types.length
        ? types
        : Object.entries(DOC_OPTIONS).map(([value, label]: any) => ({ value, label, used: false }));
      // 彙整所有流程的使用者清單（供新增/編輯 Modal 選核決人）
      const map = new Map<number, any>();
      (res || []).forEach((f: any) => (f.users || []).forEach((u: any) => map.set(u.id, u)));
      allUsers.value = [...map.values()];
    }
    catch (e: any) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };
  useEffect(() => { load(); }, []);

  const del = async (f: any) => {
    if (await confirmDialog(`確定刪除簽核流程「${f.name}」？相關文件簽核紀錄不受影響。`)) {
      try { await api.del('/approvals/flows/' + f.id); toast('流程已刪除', 'ok'); load(); }
      catch (e: any) { toast(e.message, 'err'); }
    }
  };

  const docLabel = (v: string) => docTypes.value.find((t: any) => t.value === v)?.label || DOC_OPTIONS[v] || v;

  const columns = [
    { key: 'doc_type', label: '文件類型', render: (r: any) => docLabel(r.doc_type) },
    { key: 'name', label: '流程名稱', render: (r: any) => `<b>${esc(r.name)}</b>` },
    { key: '_steps', label: '簽核層數', render: (r: any) => (r.steps?.length || 0) + ' 層' },
    { key: '_approvers', label: '核決主管', render: (r: any) => {
        const names = (r.steps || []).map((s: any) => {
          const ids = String(s.approver_ids || '').split(',').filter(Boolean).map(Number);
          const ns = ids.map((id: any) => {
            const u = (r.users || []).find((x: any) => x.id === id);
            return u ? `${u.name}（${u.emp_id}）` : `#${id}`;
          });
          return `${s.step_name || `第 ${s.step_no} 層`}：${ns.length ? ns.join('、') : '未設定'}`;
        });
        return names.join('<br/>');
      } },
    { key: 'active', label: '啟用', render: (r: any) => tag(r.active ? '啟用中' : '已停用', r.active ? 'green' : 'gray') },
  ];

  return (
    <>
      <div class="toolbar">
        <div class="fld" style="font-size:13px;color:#6b7280;align-self:center">
          設定文件簽核流程：可多層核決，每層可多選核決主管。
        </div>
        <div class="spacer" />
        <button class="btn btn-primary" onClick={() => { editing.value = null; showModal.value = true; }}>＋ 新增流程</button>
      </div>
      {loading.value
        ? <div class="empty">載入中…</div>
        : <Table columns={columns} rows={rows.value} actions={(r: any) => (
            <div style="display:flex;gap:6px;white-space:nowrap">
              <button class="btn btn-sm" onClick={() => { editing.value = r; showModal.value = true; }}>編輯</button>
              <button class="btn btn-sm btn-danger" onClick={() => del(r)}>刪除</button>
            </div>
          )} />}
      {showModal.value && (
        <FlowFormModal d={editing.value} users={allUsers.value} docTypes={docTypes.value}
          onClose={() => (showModal.value = false)}
          onSaved={() => { showModal.value = false; load(); }} />
      )}
    </>
  );
}
ApprovalFlows.title = '電子簽核';

function FlowFormModal({ d, users = [], docTypes = [], onClose, onSaved }: any) {
  const isNew = !d || !d.id;
  // 文件類型清單來自後端（單一來源）；新增時只列「尚未設定流程」者，避免送出被後端打回
  const all = docTypes.length
    ? docTypes
    : Object.entries(DOC_OPTIONS).map(([value, label]: any) => ({ value, label, used: false }));
  const pickable = isNew ? all.filter((t: any) => !t.used) : all;
  const options = (isNew ? pickable : all).slice();
  if (!isNew && !options.some((t: any) => t.value === d.doc_type)) {
    options.unshift({ value: d.doc_type, label: DOC_OPTIONS[d.doc_type] || d.doc_type, used: true });
  }
  const form = useSignal({
    doc_type: d?.doc_type || (pickable[0] && pickable[0].value) || 'supplier-order',
    name: d?.name || '',
    active: d?.active === undefined ? 1 : d.active,
  });
  const steps = useSignal(d?.steps?.length
    ? d.steps.map((s: any) => ({ step_no: s.step_no, step_name: s.step_name || '', approver_ids: String(s.approver_ids || '').split(',').filter(Boolean).map(Number) }))
    : [{ step_no: 1, step_name: '主管核決', approver_ids: [] }]);
  const busy = useSignal(false);

  const set = (k: any, v: any) => (form.value = { ...form.value, [k]: v });

  const addStep = () => {
    const next = steps.value.map((s: any) => ({ ...s }));
    next.push({ step_no: next.length + 1, step_name: `第 ${next.length + 1} 層核決`, approver_ids: [] });
    steps.value = next;
  };
  const removeStep = (i: number) => {
    if (steps.value.length <= 1) return toast('至少保留一層簽核', 'warn');
    const next = steps.value.filter((_: any, idx: any) => idx !== i).map((s: any, idx: any) => ({ ...s, step_no: idx + 1 }));
    steps.value = next;
  };
  const setStepName = (i: number, v: string) => {
    const next = steps.value.map((s: any, idx: any) => (idx === i ? { ...s, step_name: v } : s));
    steps.value = next;
  };
  const toggleApprover = (i: number, uid: number) => {
    const next = steps.value.map((s: any, idx: any) => {
      if (idx !== i) return s;
      const ids = s.approver_ids.includes(uid)
        ? s.approver_ids.filter((x: number) => x !== uid)
        : [...s.approver_ids, uid];
      return { ...s, approver_ids: ids };
    });
    steps.value = next;
  };

  const save = async () => {
    if (isNew && !options.length) return toast('所有文件類型都已設定簽核流程，請改用「編輯」調整既有流程', 'warn');
    if (!form.value.name.trim()) return toast('請填寫流程名稱', 'warn');
    if (!steps.value.length) return toast('至少需要一層簽核', 'warn');
    busy.value = true;
    try {
      const p = {
        doc_type: form.value.doc_type,
        name: form.value.name.trim(),
        active: form.value.active ? 1 : 0,
        steps: steps.value.map((s: any) => ({ step_name: s.step_name, approver_ids: s.approver_ids })),
      };
      if (isNew) await api.post('/approvals/flows', p);
      else await api.put('/approvals/flows/' + d.id, p);
      toast(isNew ? '簽核流程已建立' : '簽核流程已更新', 'ok');
      onSaved?.();
    } catch (e: any) { toast(e.message, 'err'); }
    finally { busy.value = false; }
  };

  return (
    <Modal title={isNew ? '新增簽核流程' : `編輯簽核流程：${d.name || ''}`} wide onSave={save}
      saveText={isNew ? '建立流程' : '儲存'} onClose={onClose}>
      <div class="form-grid">
        <div>
          <label class="f">文件類型 *</label>
          <select value={form.value.doc_type} disabled={!isNew} style="width:100%">
            {options.length
              ? options.map((t: any) => <option value={t.value}>{t.label}</option>)
              : <option value="">（所有文件類型皆已設定流程）</option>}
          </select>
        </div>
        <div><label class="f">流程名稱 *</label>
          <input value={form.value.name} onInput={(e: any) => set('name', e.currentTarget.value)} style="width:100%" placeholder="如：供應商訂單簽核" /></div>
        <div>
          <label class="f">啟用</label>
          <select value={form.value.active} onChange={(e: any) => set('active', Number(e.currentTarget.value))} style="width:100%">
            <option value={1}>啟用中</option><option value={0}>停用</option>
          </select>
        </div>
      </div>

      <div style="margin-top:14px;font-weight:600;font-size:13.5px">簽核層級（依序簽核，每層可多選核決主管）</div>
      {steps.value.map((s: any, i: number) => (
        <div key={i} style="border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-top:8px;background:#fafbfe">
          <div style="display:flex;gap:8px;align-items:center">
            <span class="tag t-blue">第 {i + 1} 層</span>
            <input value={s.step_name} onInput={(e: any) => setStepName(i, e.currentTarget.value)}
              placeholder="步驟名稱（如：主管核決）" style="flex:1;min-width:120px" />
            <button class="btn btn-sm btn-danger" onClick={() => removeStep(i)}>移除</button>
          </div>
          <div style="margin-top:8px;font-size:12.5px;color:#6b7280">核決主管（可多選）：</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px">
            {users.map((u: any) => (
              <label key={u.id} style="display:inline-flex;align-items:center;gap:4px;border:1px solid #dbe3f0;border-radius:6px;padding:3px 8px;font-size:12.5px;background:#fff;cursor:pointer">
                <input type="checkbox" checked={s.approver_ids.includes(u.id)}
                  onChange={() => toggleApprover(i, u.id)} />
                {esc(u.name)}（{esc(u.emp_id)}）
                {u.role === 'manager' && <span class="tag t-green" style="font-size:9.5px">主管</span>}
              </label>
            ))}
            {!users.length && <span style="color:#c0392b;font-size:12.5px">尚無使用者，請先到「系統管理」建立使用者</span>}
          </div>
        </div>
      ))}
      <div style="margin-top:10px">
        <button class="btn btn-sm" onClick={addStep}>＋ 新增一層核決</button>
      </div>
      {busy.value && <div style="font-size:12px;color:#6b7280;margin-top:6px">儲存中…</div>}
    </Modal>
  );
}
