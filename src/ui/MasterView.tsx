// 主檔 CRUD 通用元件（對應舊 customers/products/suppliers 三個近似 view）
// 透過 props 配置化，避免重複程式碼。表單 body 以 HTML 字串產生（與舊 MJ.ui 一致）。
import { useSignal, useComputed } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import api from '../api.ts';
import { user } from '../store.ts';
import { toast } from '../store.ts';
import Table from './Table.tsx';
import Pagination from './Pagination.tsx';
import Modal, { confirmDialog } from './Modal.tsx';
import { formData } from './form.ts';

export default function MasterView({ title, listUrl, columns, deps = [], buildForm, validate, searchable, rowLabel, newDefaults = {}, delMsg }: any) {
  const rows = useSignal([]);
  const kw = useSignal('');
  const loading = useSignal(true);
  const showModal = useSignal(false);
  const editing = useSignal(null);
  const ctx = useRef<any>({});
  const page = useSignal(1);
  const pageSize = useSignal(20);

  const canWrite = () => ['admin', 'manager'].includes(user.value?.role);

  const load = async () => {
    loading.value = true;
    try {
      const urls = [listUrl, ...deps.map((d: any) => d.url)];
      const res = await Promise.all(urls.map((u: any) => api.get(u)));
      rows.value = res[0];
      deps.forEach((d: any, i: any) => { ctx.current[d.key] = res[i + 1]; });
    } catch (e) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };
  useEffect(() => { load(); }, []);

  const filtered = useComputed(() => {
    const k = kw.value.trim().toLowerCase();
    if (!k) return rows.value;
    return rows.value.filter((r: any) => searchable(r).some((v: any) => String(v || '').toLowerCase().includes(k)));
  });

  const pagedRows = useComputed(() => {
    const start = (page.value - 1) * pageSize.value;
    return filtered.value.slice(start, start + pageSize.value);
  });

  const onKwChange = (e: any) => { kw.value = e.currentTarget.value; page.value = 1; };

  const openForm = (cur: any) => { editing.value = cur; showModal.value = true; };
  const onListClick = async (e: any) => {
    const id = e.target.dataset.edit || e.target.dataset.del;
    if (!id) return;
    const cur = rows.value.find((r: any) => String(r.id) === String(id));
    if (e.target.dataset.edit) return openForm(cur);
    if (e.target.dataset.del) {
      const msg = delMsg ? delMsg(cur) : `確定刪除「${rowLabel(cur)}」？`;
      if (!(await confirmDialog(msg))) return;
      const r = await api.del(listUrl + '/' + id);
      toast(r.deactivated ? `${rowLabel(cur)} 已被引用，已改為停用` : `${rowLabel(cur)} 已刪除`, 'ok');
      load();
    }
  };

  const actions = (r: any) => canWrite()
    ? `<button class="btn btn-sm" data-edit="${r.id}">編輯</button> <button class="btn btn-sm btn-danger" data-del="${r.id}">刪除</button>`
    : '';

  const d = editing.value || Object.assign({}, newDefaults);

  return (
    <>
      <div class="toolbar">
        <div class="fld"><label>關鍵字</label><input value={kw.value} onInput={onKwChange} placeholder="搜尋…" /></div>
        <div class="spacer" />
        {canWrite() && <button class="btn btn-primary" onClick={() => openForm(null)}>＋ 新增</button>}
      </div>
      {loading.value
        ? <div class="empty">載入中…</div>
        : <>
            <div onClick={onListClick}><Table columns={columns} rows={pagedRows.value} actions={actions} /></div>
            <Pagination page={page.value} pageSize={pageSize.value} total={filtered.value.length}
              onPageChange={(p: any) => (page.value = p)}
              onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
          </>}
      {showModal.value && (
        <Modal
          title={editing.value ? `編輯 ${title} — ${rowLabel(editing.value)}` : `新增 ${title}`}
          body={buildForm(ctx.current, d)}
          saveText="儲存"
          onClose={() => (showModal.value = false)}
          onSave={async (bodyEl: any) => {
            const p = formData(bodyEl);
            const v = validate ? validate(p) : true;
            if (v !== true) throw new Error(v);
            if (editing.value) await api.put(listUrl + '/' + editing.value.id, p);
            else await api.post(listUrl, p);
            toast(editing.value ? '已更新' : '已建立', 'ok');
            showModal.value = false;
            load();
          }}
        />
      )}
    </>
  );
}
