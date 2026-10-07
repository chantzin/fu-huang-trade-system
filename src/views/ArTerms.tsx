// 帳期規則管理（多樣式，每筆有唯一 ID）
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';
import Table from '../ui/Table.tsx';
import Pagination from '../ui/Pagination.tsx';
import Modal, { confirmDialog } from '../ui/Modal.tsx';
import { esc, tag } from '../ui/format.ts';

const BASIS_OPTIONS = [
  { value: 'month_end', label: '結帳月底 + 月結天數' },
  { value: 'next_month_start', label: '次月 1 日 + (天數-1)' },
  { value: 'cash', label: '現金款（當天收款）' },
  { value: 'prepaid', label: '預付款（訂單時預收）' },
];

const columns = [
  { key: 'id', label: 'ID', num: true, width: 60 },
  { key: 'name', label: '規則名稱', render: (r: any) => `<b>${esc(r.name)}</b>` },
  { key: 'basis_label', label: '推導方式' },
  { key: 'days', label: '月結天數', num: true, render: (r: any) => (r.basis === 'cash' || r.basis === 'prepaid') ? '—' : r.days },
  { key: 'description', label: '說明', render: (r: any) => esc(r.description || '') },
  { key: 'is_system', label: '類型', render: (r: any) => r.is_system ? tag('系統預設', 'blue') : tag('自訂', 'gray') },
  { key: 'is_active', label: '狀態', render: (r: any) => r.is_active ? tag('啟用', 'green') : tag('停用', 'gray') },
];

export default function ArTerms() {
  const list = useSignal([]);
  const loading = useSignal(false);
  const modalOpen = useSignal(false);
  const editing = useSignal(null); // null=新增, object=修改
  const form = useSignal({ name: '', basis: 'month_end', days: 30, description: '' });
  const page = useSignal(1);
  const pageSize = useSignal(20);

  const load = async () => {
    loading.value = true;
    try { list.value = await api.get('/ar-terms'); }
    catch (e) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };
  useEffect(() => { load(); }, []);

  const openAdd = () => {
    editing.value = null;
    form.value = { name: '', basis: 'month_end', days: 30, description: '' };
    modalOpen.value = true;
  };
  const openEdit = (r: any) => {
    editing.value = r;
    form.value = { name: r.name, basis: r.basis, days: r.days, description: r.description || '' };
    modalOpen.value = true;
  };
  const save = async () => {
    const f = form.value;
    if (!f.name.trim()) return toast('請輸入規則名稱', 'warn');
    if ((f.basis === 'month_end' || f.basis === 'next_month_start') && (!f.days || f.days <= 0)) {
      return toast('月結天數必須大於 0', 'warn');
    }
    try {
      if (editing.value) {
        await api.put('/ar-terms/' + editing.value.id, f);
        toast('規則已更新', 'ok');
      } else {
        await api.post('/ar-terms', f);
        toast('規則已新增', 'ok');
      }
      modalOpen.value = false;
      load();
    } catch (e) { toast(e.message, 'err'); }
  };
  const remove = async (r: any) => {
    if (r.is_system) return toast('系統預設規則不可刪除', 'warn');
    const ok = await confirmDialog(`確定刪除規則「${r.name}」？`);
    if (!ok) return;
    try { await api.del('/ar-terms/' + r.id); toast('規則已刪除', 'ok'); load(); }
    catch (e) { toast(e.message, 'err'); }
  };
  const toggle = async (r: any) => {
    try { await api.put('/ar-terms/' + r.id + '/toggle'); load(); }
    catch (e) { toast(e.message, 'err'); }
  };

  const paged = list.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value);

  return (
    <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0">帳期規則管理</h3>
        <button class="btn btn-primary" onClick={openAdd}>＋ 新增規則</button>
      </div>

      <Table
        columns={columns}
        rows={paged}
        loading={loading.value}
        actions={(r: any) => (
          <div style="display:flex;gap:6px;white-space:nowrap">
            <button class="btn btn-sm" onClick={() => openEdit(r)}>修改</button>
            <button class={`btn btn-sm ${r.is_active ? 'btn-warning' : 'btn-success'}`} onClick={() => toggle(r)}>
              {r.is_active ? '停用' : '啟用'}
            </button>
            {!r.is_system && <button class="btn btn-sm btn-danger" onClick={() => remove(r)}>刪除</button>}
          </div>
        )}
      />

      <Pagination
        total={list.value.length}
        page={page.value}
        pageSize={pageSize.value}
        onPageChange={(p: any) => (page.value = p)}
        onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }}
      />

      <div class="calc-note" style="margin-top:14px">
        💡 「系統預設」規則不可刪除，但可修改名稱/天數/說明或停用。<br />
        💡 停用的規則不會出現在客戶主檔的「交易條件」下拉選單中。<br />
        💡 刪除規則前，請確認沒有客戶使用該規則。
      </div>

      {modalOpen.value && (
        <Modal
          title={editing.value ? `修改規則：${editing.value.name}` : '新增帳期規則'}
          onSave={save}
          saveText={editing.value ? '儲存修改' : '新增規則'}
          onClose={() => (modalOpen.value = false)}
        >
          <div class="form-grid">
            <div>
              <label class="f">規則名稱 *</label>
              <input value={form.value.name} onInput={(e: any) => (form.value = { ...form.value, name: e.currentTarget.value })}
                placeholder="例如：月結 30 天" style="width:100%" />
            </div>
            <div>
              <label class="f">推導方式 *</label>
              <select value={form.value.basis} onChange={(e: any) => (form.value = { ...form.value, basis: e.currentTarget.value })} style="width:100%">
                {BASIS_OPTIONS.map((o: any) => (
                  <option value={o.value} selected={o.value === form.value.basis}>{o.label}</option>
                ))}
              </select>
            </div>
            {(form.value.basis === 'month_end' || form.value.basis === 'next_month_start') && (
              <div>
                <label class="f">月結天數 *</label>
                <input type="number" value={form.value.days} onInput={(e: any) => (form.value = { ...form.value, days: Number(e.currentTarget.value) })}
                  min="1" style="width:100%" />
              </div>
            )}
            <div style="grid-column:1/-1">
              <label class="f">說明</label>
              <textarea value={form.value.description} onInput={(e: any) => (form.value = { ...form.value, description: e.currentTarget.value })}
                placeholder="規則說明（選填）" rows={2} style="width:100%" />
            </div>
            {(form.value.basis === 'cash' || form.value.basis === 'prepaid') && (
              <div style="grid-column:1/-1;font-size:12px;color:#6b7280;background:#f8f9fa;padding:8px 12px;border-radius:6px">
                ℹ️ 現金款／預付款的兌現日＝基準日（當天），不需設定月結天數。
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
ArTerms.title = '帳期規則管理';
