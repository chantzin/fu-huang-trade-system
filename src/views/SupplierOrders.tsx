// 供應商訂單（採購單，供應鏈 / Preact）
import { useSignal, useComputed } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import api from '../api.ts';
import { user } from '../store.ts';
import { toast } from '../store.ts';
import Table from '../ui/Table.tsx';
import Pagination from '../ui/Pagination.tsx';
import Modal, { confirmDialog } from '../ui/Modal.tsx';
import EmailModal from '../ui/EmailModal.tsx';
import PdfPreviewModal from '../ui/PdfPreviewModal.tsx';
import { esc, num, date, tag } from '../ui/format.ts';
import { ScItemsEditor } from './SupplierQuotes.tsx';

const canManage = () => ['admin', 'manager'].includes(user.value?.role);
const todayStr = () => new Date().toISOString().slice(0, 10);
const STATUS: any = { draft: '草稿', confirmed: '已確認', partial: '部分進貨', received: '已進貨', cancelled: '已取消' };
/* 簽核狀態（與出貨單／報價單一致） */
const APPROVAL_STATUS: any = {
  none: '<span style="color:#9ca3af">未送核</span>',
  pending: '<span style="color:#2563eb;font-weight:600">待簽核</span>',
  approved: '<span style="color:#16a34a;font-weight:600">已同意</span>',
  rejected: '<span style="color:#dc2626;font-weight:600">已否決</span>',
  returned: '<span style="color:#d97706;font-weight:600">待修改</span>',
};
const approvalBadge = (s: any) => APPROVAL_STATUS[s] || APPROVAL_STATUS.none;
const canSubmitApproval = (r: any) =>
  r.approval_status === 'none' || (r.approval_status === 'returned' && r.submitter_id === user.value?.id);

export default function SupplierOrders() {
  const rows = useSignal([]);
  const kw = useSignal('');
  const supplier = useSignal('');
  const loading = useSignal(true);
  const showModal = useSignal(false);
  const editing = useSignal(null);
  const suppliersRef = useSignal([]);
  const page = useSignal(1);
  const pageSize = useSignal(20);
  const listRef = useRef<any>(null);
  const emailIds = useSignal([]);
  const showEmailModal = useSignal(false);
  const previewUrl = useSignal('');
  const showPreview = useSignal(false);

  const load = async () => {
    loading.value = true;
    try {
      const [list, sups] = await Promise.all([api.get('/supplier-orders'), api.get('/suppliers')]);
      rows.value = list; suppliersRef.value = sups;
      // 支援從「文件簽核 → 待更改」跳轉：?edit=ID 自動開啟編輯
      const m = location.hash.match(/[?&]edit=(\d+)/);
      if (m) {
        const r = list.find((x: any) => String(x.id) === m[1]);
        if (r) { editing.value = r; showModal.value = true; }
      }
    } catch (e) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };
  useEffect(() => { load(); }, []);

  const filtered = useComputed(() => {
    const k = kw.value.trim().toLowerCase(), s = supplier.value;
    if (!k && !s) return rows.value;
    return rows.value.filter((r: any) =>
      (!k || [r.order_no, r.supplier_name, r.content, r.note].filter(Boolean).some((v: any) => String(v).toLowerCase().includes(k))) &&
      (!s || String(r.supplier_id) === s));
  });

  const pagedRows = useComputed(() => {
    const start = (page.value - 1) * pageSize.value;
    return filtered.value.slice(start, start + pageSize.value);
  });
  const resetPage = () => { page.value = 1; };

  const del = async (cur: any) => {
    if (await confirmDialog(`確定刪除供應商訂單「${cur.order_no}」？`)) {
      try { await api.del('/supplier-orders/' + cur.id); toast('訂單已刪除', 'ok'); load(); }
      catch (e) { toast(e.message, 'err'); }
    }
  };

  const selectAll = (root: any, checked: any) => {
    root.querySelectorAll('.sel-one').forEach((c: any) => { c.checked = checked; });
  };
  const selectedIds = () => [...(listRef.current?.querySelectorAll('.sel-one:checked') || [])].map((c: any) => Number(c.dataset.id));
  const onListChange = (e: any) => {
    if (e.target && e.target.id === 'sel-all') selectAll(listRef.current, e.target.checked);
  };
  const doSubmitApproval = async (r: any) => {
    try {
      const res = await api.post(`/approvals/doc/supplier-order/${r.id}/submit`, {});
      toast(`已送簽（${res.approval_flow?.name || ''}）`, 'ok');
      load();
    } catch (e: any) { toast(e.message, 'err'); }
  };
  const doBatchPdf = async () => {
    const ids = selectedIds();
    if (!ids.length) return toast('請先勾選訂單', 'warn');
    try {
      const d = new Date();
      const p = (n: any) => String(n).padStart(2, '0');
      await api.downloadBatchPdf({ type: 'supplier-orders', ids }, `採購單_批次_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.pdf`);
      toast(`已合併 ${ids.length} 張採購單為 1 個 PDF`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  const doBatchEmail = () => {
    const ids = selectedIds();
    if (!ids.length) return toast('請先勾選訂單', 'warn');
    emailIds.value = ids;
    showEmailModal.value = true;
  };
  const doSendEmails = async (p: any) => {
    const ids = emailIds.value;
    try {
      const r = await api.sendEmail('/email/send-batch', {
        items: ids.map((id: any) => ({ type: 'supplier-order', id })),
        to: p.to,
        subject: p.subject || `採購單通知（${ids.length} 份）`,
        html: p.html,
        bcc: p.bcc,
        extraAttachments: p.extraAttachments,
      });
      toast(`已寄出 ${r.sent} 封郵件` + (r.skipped && r.skipped.length ? `，${r.skipped.length} 組略過` : ''), 'ok');
      if (r.details && r.details[0] && r.details[0].previewUrl) { toast('測試模式：預覽郵件 ' + r.details[0].previewUrl, 'ok'); }
    } catch (e) { toast(e.message, 'err'); }
  };

  const columns = [
    { key: '_sel', label: '<input type="checkbox" id="sel-all" />', html: true, render: (r: any) => `<input type="checkbox" class="sel-one" data-id="${r.id}" />` },
    { key: 'order_no', label: '採購單號', render: (r: any) => `<b>${esc(r.order_no)}</b>` },
    { key: 'order_date', label: '訂單日期', render: (r: any) => date(r.order_date) },
    { key: 'due_date', label: '交期', render: (r: any) => date(r.due_date) },
    { key: 'supplier_name', label: '供應商' },
    { key: 'content', label: '採購內容' },
    { key: 'status', label: '狀態', render: (r: any) => STATUS[r.status] || r.status },
    { key: 'approval_status', label: '簽核狀態', html: true, render: (r: any) => approvalBadge(r.approval_status) },
    { key: 'note', label: '備註' },
  ];

  return (
    <>
      <div class="toolbar">
        <div class="fld"><label>關鍵字</label><input value={kw.value} onInput={(e: any) => { kw.value = e.currentTarget.value; resetPage(); }} placeholder="採購單號／供應商／料號" /></div>
        <div class="fld"><label>供應商</label><select value={supplier.value} onChange={(e: any) => { supplier.value = e.currentTarget.value; resetPage(); }}>
          <option value="">全部</option>{suppliersRef.value.map((s: any) => <option value={s.id}>{esc(s.name)}</option>)}</select></div>
        <div class="spacer" />
        <button class="btn" onClick={doBatchPdf}>批次合併列印</button>
        <button class="btn btn-mail" onClick={doBatchEmail}>批次寄 E-mail</button>
        <button class="btn btn-primary" onClick={() => { editing.value = null; showModal.value = true; }}>＋ 新增訂單</button>
      </div>
      {loading.value
        ? <div class="empty">載入中…</div>
        : <>
            <div ref={listRef} onChange={onListChange}>
              <Table columns={columns} rows={pagedRows.value} actions={(r: any) => (
                <div style="display:flex;gap:6px;white-space:nowrap">
                  {canSubmitApproval(r) && <button class="btn btn-sm btn-primary" onClick={() => doSubmitApproval(r)}>送簽</button>}
                  <button class="btn btn-sm" onClick={() => { editing.value = r; showModal.value = true; }}>編輯</button>
                  <button class="btn btn-sm" onClick={() => { previewUrl.value = `/api/pdf/supplier-orders/${r.id}?token=${encodeURIComponent(localStorage.getItem('app_token') || '')}`; showPreview.value = true; }}>預覽</button>
                  <button class="btn btn-sm" onClick={() => window.open(`/api/pdf/supplier-orders/${r.id}?token=${encodeURIComponent(localStorage.getItem('app_token') || '')}`, '_blank')}>列印</button>
                  {canManage() && <button class="btn btn-sm btn-danger" onClick={() => del(r)}>刪除</button>}
                </div>
              )} />
            </div>
            <Pagination page={page.value} pageSize={pageSize.value} total={filtered.value.length}
              onPageChange={(p: any) => (page.value = p)}
              onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
          </>}
      {showModal.value && (
        <SupplierOrderFormModal d={editing.value} suppliers={suppliersRef.value}
          onClose={() => (showModal.value = false)}
          onSaved={() => { showModal.value = false; load(); }} />
      )}
      {showEmailModal.value && (
        <EmailModal count={emailIds.value.length} type="採購單"
          defaultEmails={emailIds.value.map((id: any) => rows.value.find((r: any) => String(r.id) === String(id))?.supplier_email || '').filter(Boolean).filter((v: any, i: any, a: any) => a.indexOf(v) === i).join(', ')}
          defaultSubject={`燿申科技有限公司訂購單 訂單編號:${emailIds.value.map((id: any) => rows.value.find((r: any) => String(r.id) === String(id))?.order_no || '').filter(Boolean).join('、')} 請確認後回覆交期`}
          attachments={emailIds.value.map((id: any) => rows.value.find((r: any) => String(r.id) === String(id))?.order_no || '').filter(Boolean).map((no: any) => `supplier-order-${no}.pdf`)}
          onConfirm={doSendEmails}
          onClose={() => (showEmailModal.value = false)} />
      )}
      {showPreview.value && (
        <PdfPreviewModal title="採購單預覽" pdfUrl={previewUrl.value}
          onClose={() => (showPreview.value = false)} />
      )}
    </>
  );
}
SupplierOrders.title = '供應商訂單';

function SupplierOrderFormModal({ d, suppliers, onClose, onSaved }: any) {
  const isNew = !d || !d.id;
  const form = useSignal({
    order_no: d?.order_no || '',
    order_date: d?.order_date || todayStr(),
    due_date: d?.due_date || '',
    supplier_id: d?.supplier_id || 0,
    tax_rate: d?.tax_rate ?? 0.05,
    currency: d?.currency || 'TWD',
    exchange_rate: d?.exchange_rate ?? 1,
    status: d?.status || 'draft',
    note: d?.note || '',
  });
  const items = useSignal(d?.items?.length ? d.items.map((i: any) => ({ ...i })) : [defaultItem()]);
  const products = useSignal(null);
  const busy = useSignal(false);

  useEffect(() => {
    api.get('/products').then((p: any) => (products.value = p)).catch(() => {});
  }, []);

  const set = (k: any, v: any) => (form.value = { ...form.value, [k]: v });
  const subtotal = items.value.reduce((s: number, it: any) => s + num(it.amount), 0);
  const taxTotal = items.value.reduce((s: number, it: any) => s + num(it.tax_amount), 0);
  const grand = items.value.reduce((s: number, it: any) => s + num(it.total), 0);

  const save = async () => {
    const f = form.value;
    if (!Number(f.supplier_id)) return toast('請選擇供應商', 'warn');
    const clean = items.value.filter((i: any) => String(i.part_no || '').trim());
    if (!clean.length) return toast('至少需要一筆採購明細', 'warn');
    busy.value = true;
    try {
      const p = {
        order_no: f.order_no, order_date: f.order_date, due_date: f.due_date,
        supplier_id: Number(f.supplier_id), tax_rate: Number(f.tax_rate || 0),
        currency: f.currency, exchange_rate: Number(f.exchange_rate || 1),
        status: f.status, note: f.note, items: clean,
      };
      if (isNew) await api.post('/supplier-orders', p);
      else await api.put('/supplier-orders/' + d.id, p);
      toast(isNew ? '供應商訂單已建立' : '供應商訂單已更新', 'ok');
      onSaved?.();
    } catch (e) { toast(e.message, 'err'); }
    finally { busy.value = false; }
  };

  const supOpts = [[0, '（請選擇）']].concat((suppliers || []).map((s: any) => [s.id, s.name]));

  return (
    <Modal title={isNew ? '新增供應商訂單' : `採購單 ${d.order_no || ''}`} wide onSave={save}
      saveText={isNew ? '建立訂單' : '儲存'} onClose={onClose}>
      <div class="form-grid">
        <div><label class="f">採購單號（留空自動產生）</label><input value={form.value.order_no} onInput={(e: any) => set('order_no', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">訂單日期 *</label><input type="date" value={form.value.order_date} onInput={(e: any) => set('order_date', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">交期</label><input type="date" value={form.value.due_date} onInput={(e: any) => set('due_date', e.currentTarget.value)} style="width:100%" /></div>
        <div>
          <label class="f">供應商 *</label>
          <select value={form.value.supplier_id} onChange={(e: any) => set('supplier_id', e.currentTarget.value)} style="width:100%">
            {supOpts.map((o: any) => <option value={o[0]}>{esc(o[1])}</option>)}
          </select>
        </div>
        <div><label class="f">稅率 %</label><input type="number" step={0.01} value={Number(form.value.tax_rate) * 100} onInput={(e: any) => set('tax_rate', Number(e.currentTarget.value || 0) / 100)} style="width:100%" /></div>
        <div><label class="f">幣別</label>
          <select value={form.value.currency} onChange={(e: any) => set('currency', e.currentTarget.value)} style="width:100%">
            <option value="TWD">TWD 台幣</option>
            <option value="USD">USD 美金</option>
            <option value="JPY">JPY 日圓</option>
            <option value="CNY">CNY 人民幣</option>
            <option value="EUR">EUR 歐元</option>
          </select>
        </div>
        <div><label class="f">匯率（對台幣）</label><input type="number" step={0.0001} value={form.value.exchange_rate} onInput={(e: any) => set('exchange_rate', Number(e.currentTarget.value || 1))} style="width:100%" /></div>
        <div>
          <label class="f">狀態</label>
          <select value={form.value.status} onChange={(e: any) => set('status', e.currentTarget.value)} style="width:100%">
            {Object.entries(STATUS).map(([v, t]: any) => <option value={v}>{t}</option>)}
          </select>
        </div>
        <div style="grid-column:1/-1"><label class="f">備註</label><textarea value={form.value.note} onInput={(e: any) => set('note', e.currentTarget.value)} rows={2} style="width:100%" /></div>
      </div>
      <ScItemsEditor items={items.value} products={products.value}
        taxRate={Number(form.value.tax_rate ?? 0.05)} onChange={(v: any) => (items.value = v)} title="採購明細" />
      <div class="calc-note">小計 {num(subtotal)} ｜ 稅額 {num(taxTotal)} ｜ <b>總計 {num(grand)}</b></div>
      {busy.value && <div style="font-size:12px;color:#6b7280;margin-top:6px">儲存中…</div>}
    </Modal>
  );
}

function defaultItem() {
  return { product_id: 0, part_no: '', description: '', qty: 1, unit: 'PCS', unit_price: 0, tax_rate: 0.05, amount: 0, tax_amount: 0, total: 0 };
}
