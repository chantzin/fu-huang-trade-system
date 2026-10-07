// 出貨與單據管理（Level B / Preact）
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
import { esc, num, date } from '../ui/format.ts';

const canManage = () => ['admin', 'manager'].includes(user.value?.role);

export default function Shipments() {
  const rows = useSignal([]);
  const kw = useSignal('');
  const cust = useSignal('');
  const from = useSignal('');
  const to = useSignal('');
  const loading = useSignal(true);
  const showModal = useSignal(false);
  const showEmailModal = useSignal(false);
  const emailIds = useSignal([]);
  const previewUrl = useSignal('');
  const showPreview = useSignal(false);
  const editing = useSignal(null);
  const showUpload = useSignal(false);
  const uploadTarget = useSignal(null);
  const listRef = useRef(null);
  const pendingRef = useRef(null);
  const customersRef = useRef([]);
  const ordersRef = useRef([]);
  const page = useSignal(1);
  const pageSize = useSignal(20);

  const load = async () => {
    loading.value = true;
    try {
      const [list, customers, orders] = await Promise.all([api.get('/shipments'), api.get('/customers'), api.get('/orders')]);
      rows.value = list; customersRef.current = customers; ordersRef.current = orders;
    } catch (e) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };
  useEffect(() => {
    try { pendingRef.current = JSON.parse(localStorage.getItem('mj.pendingBatch') || 'null'); } catch { pendingRef.current = null; }
    try { localStorage.removeItem('mj.pendingBatch'); } catch { /* ignore */ }
    load();
  }, []);

  const filtered = useComputed(() => {
    const k = kw.value.trim().toLowerCase(), c = cust.value, f = from.value, t = to.value;
    if (!k && !c && !f && !t) return rows.value;
    return rows.value.filter((r: any) =>
      (!k || [r.shipment_no, r.order_no, r.declaration_no, r.invoice_no].filter(Boolean).some((v: any) => String(v).toLowerCase().includes(k))) &&
      (!c || String(r.customer_id) === c) &&
      (!f || (r.ship_date || '') >= f) &&
      (!t || (r.ship_date || '') <= t));
  });

  const pagedRows = useComputed(() => {
    const start = (page.value - 1) * pageSize.value;
    return filtered.value.slice(start, start + pageSize.value);
  });

  const resetPage = () => { page.value = 1; };

  const selectAll = (root: any, checked: any) => { root.querySelectorAll('.sel-one').forEach((c: any) => { c.checked = checked; }); };
  const selectedIds = () => [...(listRef.current?.querySelectorAll('.sel-one:checked') || [])].map((c: any) => Number(c.dataset.id));

  const doBatchPdf = async () => {
    const ids = selectedIds();
    if (!ids.length) return toast('請先勾選出貨單', 'warn');
    try { await api.downloadBatchPdf({ type: 'shipments', ids }, `批次出貨_${new Date().toISOString().slice(0, 10)}.pdf`); toast(`已合併 ${ids.length} 張出貨單為 1 個 PDF`, 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  const doBatchEmail = () => {
    const ids = selectedIds();
    if (!ids.length) return toast('請先勾選出貨單', 'warn');
    emailIds.value = ids;
    showEmailModal.value = true;
  };
  const doSendEmails = async (p: any) => {
    const ids = emailIds.value;
    try {
      const r = await api.sendEmail('/email/send-batch', { items: ids.map((id: any) => ({ type: 'shipment', id })), to: p.to, subject: p.subject || `出貨單通知（${ids.length} 份）`, html: p.html, bcc: p.bcc, extraAttachments: p.extraAttachments });
      toast(`已寄出 ${r.sent} 封郵件` + (r.skipped && r.skipped.length ? `，${r.skipped.length} 組略過` : ''), 'ok');
      if (r.details && r.details[0] && r.details[0].previewUrl) { toast('測試模式：預覽郵件 ' + r.details[0].previewUrl, 'ok'); }
    } catch (e) { toast(e.message, 'err'); }
  };

  useEffect(() => {
    if (!pendingRef.current || !listRef.current) return;
    const pend = pendingRef.current; pendingRef.current = null;
    const pf = pend.filter || {};
    if (pf.customer) cust.value = pf.customer;
    if (pf.from) from.value = pf.from;
    if (pf.to) to.value = pf.to;
    setTimeout(() => {
      const selAll = listRef.current?.querySelector('#sel-all');
      if (selAll) { selAll.checked = true; selectAll(listRef.current, true); }
      if (pend.act === 'pdf') setTimeout(() => doBatchPdf(), 200);
      else if (pend.act === 'email') setTimeout(() => doBatchEmail(), 200);
    }, 250);
  }, [rows.value]);

  const openForm = (cur: any) => { editing.value = cur; showModal.value = true; };
  const openUpload = (cur: any) => { uploadTarget.value = cur; showUpload.value = true; };
  const downloadPdf = (cur: any) => api.downloadPdf(`/pdf/shipments/${cur.id}`, `出貨單_${cur.shipment_no}.pdf`);
  const delShipment = async (cur: any) => {
    if (await confirmDialog(`確定刪除出貨單「${cur.shipment_no}」？`)) {
      try { await api.del('/shipments/' + cur.id); toast('出貨紀錄已刪除', 'ok'); load(); }
      catch (e) { toast(e.message, 'err'); }
    }
  };
  const onListChange = (e: any) => { if (e.target && e.target.id === 'sel-all') selectAll(listRef.current, e.target.checked); };

  const doSubmit = async (cur: any) => {
    try {
      await api.post(`/approvals/doc/shipment/${cur.id}/submit`, {});
      toast(`出貨單 ${cur.shipment_no} 已發起簽核`, 'ok');
      load();
    } catch (e: any) { toast(e.message, 'err'); }
  };

  const statusBadge = (s: any) => {
    const map: any = {
      none: '<span style="color:#9ca3af">未送核</span>',
      pending: '<span style="color:#2563eb;font-weight:600">待簽核</span>',
      approved: '<span style="color:#16a34a;font-weight:600">已同意</span>',
      rejected: '<span style="color:#dc2626;font-weight:600">已否決</span>',
      returned: '<span style="color:#d97706;font-weight:600">待修改</span>',
    };
    return map[s] || s;
  };

  const columns = [
    { key: '_sel', label: '<input type="checkbox" id="sel-all" />', html: true, render: (r: any) => `<input type="checkbox" class="sel-one" data-id="${r.id}" />` },
    { key: 'shipment_no', label: '出貨單號', render: (r: any) => `<b>${esc(r.shipment_no)}</b>` },
    { key: 'order_no', label: '訂單編號' },
    { key: 'customer_name', label: '客戶' },
    { key: 'ship_date', label: '出貨日', render: (r: any) => date(r.ship_date) },
    { key: 'qty', label: '數量', num: true, render: (r: any) => num(r.qty) },
    { key: 'declaration_no', label: '進口報單' },
    { key: 'invoice_no', label: '發票號碼' },
    { key: 'invoice_date', label: '發票日期', render: (r: any) => date(r.invoice_date) },
    { key: 'approval_status', label: '簽核狀態', html: true, render: (r: any) => statusBadge(r.approval_status) },
    { key: 'file_path', label: '檔案', render: (r: any) => r.file_path ? `<a href="/api/shipments/file/${encodeURIComponent(String(r.file_path).split('/').pop())}" target="_blank">下載</a>` : '' },
    { key: 'created_by_name', label: '登錄者' },
  ];

  return (
    <>
      <div class="toolbar">
        <div class="fld"><label>關鍵字</label><input value={kw.value} onInput={(e: any) => { kw.value = e.currentTarget.value; resetPage(); }} placeholder="出貨單號／訂單編號／報單／發票" /></div>
        <div class="fld"><label>客戶</label><select value={cust.value} onChange={(e: any) => { cust.value = e.currentTarget.value; resetPage(); }}>
          <option value="">全部</option>{customersRef.current.map((c: any) => <option value={c.id}>{esc(c.name)}</option>)}</select></div>
        <div class="fld"><label>出貨日起</label><input type="date" value={from.value} onInput={(e: any) => { from.value = e.currentTarget.value; resetPage(); }} /></div>
        <div class="fld"><label>出貨日迄</label><input type="date" value={to.value} onInput={(e: any) => { to.value = e.currentTarget.value; resetPage(); }} /></div>
        <div class="spacer" />
        <button class="btn btn-primary" onClick={() => openForm(null)}>＋ 登錄出貨</button>
        <button class="btn btn-pdf" onClick={doBatchPdf}>📄 批次合併列印</button>
        <button class="btn btn-mail" onClick={doBatchEmail}>✉️ 批次寄 Email</button>
      </div>
      {loading.value
        ? <div class="empty">載入中…</div>
        : <>
            <div ref={listRef} onChange={onListChange}>
              <Table columns={columns} rows={pagedRows.value} actions={(r: any) => (
                <div style="display:flex;gap:6px;white-space:nowrap">
                  <button class="btn btn-sm" onClick={() => openForm(r)}>編輯</button>
                  <button class="btn btn-sm" onClick={() => openUpload(r)}>上傳單據</button>
                  <button class="btn btn-sm" onClick={() => { previewUrl.value = `/api/pdf/shipments/${r.id}?token=${encodeURIComponent(localStorage.getItem('app_token') || '')}`; showPreview.value = true; }}>預覽</button>
                  <button class="btn btn-sm btn-pdf" onClick={() => downloadPdf(r)} title="下載出貨單 PDF">📄 出貨單</button>
                  {(r.approval_status === 'none' || r.approval_status === 'returned') && <button class="btn btn-sm btn-primary" onClick={() => doSubmit(r)}>送簽</button>}
                  {canManage() && <button class="btn btn-sm btn-danger" onClick={() => delShipment(r)}>刪除</button>}
                </div>
              )} />
            </div>
            <Pagination page={page.value} pageSize={pageSize.value} total={filtered.value.length}
              onPageChange={(p: any) => (page.value = p)}
              onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
          </>}
      {showModal.value && (
        <ShipFormModal d={editing.value} orders={ordersRef.current}
          onClose={() => { showModal.value = false; load(); }} />
      )}
      {showUpload.value && (
        <UploadModal target={uploadTarget.value}
          onClose={() => { showUpload.value = false; load(); }} />
      )}
      {showEmailModal.value && (
        <EmailModal count={emailIds.value.length} type="出貨單"
          attachments={emailIds.value.map((id: any) => rows.value.find((r: any) => String(r.id) === String(id))?.shipment_no || '').filter(Boolean).map((no: any) => `shipment-${no}.pdf`)}
          onConfirm={doSendEmails}
          onClose={() => (showEmailModal.value = false)} />
      )}
      {showPreview.value && (
        <PdfPreviewModal title="出貨單預覽" pdfUrl={previewUrl.value}
          onClose={() => (showPreview.value = false)} />
      )}
    </>
  );
}
Shipments.title = '出貨與單據';

function ShipFormModal({ d, orders, onClose }: any) {
  const isNew = !d || !d.id;
  const form = useSignal({
    shipment_no: d?.shipment_no || '',
    order_id: d?.order_id || 0,
    ship_date: d?.ship_date || new Date().toISOString().slice(0, 10),
    qty: d?.qty || 0,
    declaration_no: d?.declaration_no || '',
    invoice_no: d?.invoice_no || '',
    invoice_date: d?.invoice_date || '',
    note: d?.note || '',
  });
  const busy = useSignal(false);
  const set = (k: any, v: any) => (form.value = { ...form.value, [k]: v });
  const orderOpts = (orders || []).map((o: any) => [o.id, `${o.order_no} — ${o.customer_name || ''}`]);

  const save = async () => {
    const f = form.value;
    if (!Number(f.order_id)) return toast('請選擇所屬訂單', 'warn');
    busy.value = true;
    try {
      const p = {
        shipment_no: f.shipment_no,
        order_id: Number(f.order_id),
        ship_date: f.ship_date,
        qty: Number(f.qty || 0),
        declaration_no: f.declaration_no,
        invoice_no: f.invoice_no,
        invoice_date: f.invoice_date,
        note: f.note,
      };
      if (isNew) await api.post('/shipments', p);
      else await api.put('/shipments/' + d.id, p);
      toast(isNew ? '出貨已登錄' : '出貨紀錄已更新', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    finally { busy.value = false; }
  };

  return (
    <Modal title={isNew ? '登錄出貨' : `編輯出貨 — ${d.shipment_no}`} onSave={save} onClose={onClose}>
      <div class="form-grid">
        <div><label class="f">出貨單號（留空自動產生）</label><input value={form.value.shipment_no} onInput={(e: any) => set('shipment_no', e.currentTarget.value)} style="width:100%" /></div>
        <div>
          <label class="f">所屬訂單 *</label>
          <select value={form.value.order_id} onChange={(e: any) => set('order_id', e.currentTarget.value)} style="width:100%">
            <option value={0}>（請選擇）</option>
            {orderOpts.map((o: any) => <option value={o[0]}>{esc(o[1])}</option>)}
          </select>
        </div>
        <div><label class="f">出貨日期 *</label><input type="date" value={form.value.ship_date} onInput={(e: any) => set('ship_date', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">數量</label><input type="number" value={form.value.qty} onInput={(e: any) => set('qty', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">進口報單號碼</label><input value={form.value.declaration_no} onInput={(e: any) => set('declaration_no', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">發票號碼</label><input value={form.value.invoice_no} onInput={(e: any) => set('invoice_no', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">發票日期</label><input type="date" value={form.value.invoice_date} onInput={(e: any) => set('invoice_date', e.currentTarget.value)} style="width:100%" /></div>
        <div style="grid-column:1/-1"><label class="f">備註</label><textarea value={form.value.note} onInput={(e: any) => set('note', e.currentTarget.value)} rows={2} style="width:100%" /></div>
      </div>
      <div class="calc-note">出貨登錄後，系統會自動回寫訂單的「出貨日」並把狀態推進為「已出貨」。</div>
      {busy.value && <div style="font-size:12px;color:#6b7280;margin-top:6px">儲存中…</div>}
    </Modal>
  );
}

function UploadModal({ target, onClose }: any) {
  const file = useSignal(null);
  const busy = useSignal(false);

  const save = async () => {
    if (!file.value) return toast('請選擇檔案', 'warn');
    busy.value = true;
    try {
      const fd = new FormData(); fd.append('file', file.value);
      await api.post('/shipments/' + target.id + '/file', fd);
      toast('檔案已上傳', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    finally { busy.value = false; }
  };

  return (
    <Modal title={`上傳單據 — ${target?.shipment_no}`} saveText="上傳" onSave={save} onClose={onClose}>
      <div class="form-grid">
        <div>
          <label class="f">選擇檔案（進口報單／發票，≤20MB）</label>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx"
            onChange={(e: any) => (file.value = e.currentTarget.files?.[0] || null)} />
          {file.value && <div style="margin-top:6px;font-size:12px;color:#5A6270">{file.value.name}</div>}
        </div>
      </div>
      {busy.value && <div style="font-size:12px;color:#6b7280;margin-top:6px">上傳中…</div>}
    </Modal>
  );
}
