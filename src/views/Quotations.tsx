import { useSignal } from '@preact/signals';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';
import Modal from '../ui/Modal.tsx';
import Table from '../ui/Table.tsx';
import EmailModal from '../ui/EmailModal.tsx';
import PdfPreviewModal from '../ui/PdfPreviewModal.tsx';
import Pagination from '../ui/Pagination.tsx';
import { esc, date, num, tag } from '../ui/format.ts';

const todayStr = () => new Date().toISOString().slice(0, 10);

const STATUS: any = { draft: '草稿', confirmed: '已報價', expired: '已失效', cancelled: '作廢' };
const STATUS_TAG: any = { draft: 'gray', confirmed: 'blue', expired: 'orange', cancelled: 'red' };

/* 簽核狀態（與出貨單一致） */
const APPROVAL_STATUS: any = {
  none: '<span style="color:#9ca3af">未送核</span>',
  pending: '<span style="color:#2563eb;font-weight:600">待簽核</span>',
  approved: '<span style="color:#16a34a;font-weight:600">已同意</span>',
  rejected: '<span style="color:#dc2626;font-weight:600">已否決</span>',
  returned: '<span style="color:#d97706;font-weight:600">待修改</span>',
};
const approvalBadge = (s: any) => APPROVAL_STATUS[s] || APPROVAL_STATUS.none;

let productsCache: any = null;

function defaultItem() {
  return { product_id: 0, part_no: '', description: '', qty: 1, unit: 'PCS', unit_price: 0, tax_rate: 0.05 };
}

export default function Quotations() {
  const rows = useSignal([]);
  const kw = useSignal('');
  const cust = useSignal('');
  const st = useSignal('');
  const loading = useSignal(true);
  const showModal = useSignal(false);
  const editing = useSignal(null);
  const page = useSignal(1);
  const pageSize = useSignal(20);
  const customersRef = useSignal<any>([]);
  const listRef = useRef<any>(null);
  const emailIds = useSignal([]);
  const showEmailModal = useSignal(false);
  const previewUrl = useSignal('');
  const showPreview = useSignal(false);

  const load = async () => {
    loading.value = true;
    try {
      const p: any = {};
      if (kw.value) p.keyword = kw.value;
      if (cust.value) p.customer_id = cust.value;
      if (st.value) p.status = st.value;
      const list = await api.get('/quotes', p);
      rows.value = list;
      if (!customersRef.value.length) {
        const cs = await api.get('/customers');
        customersRef.value = cs;
      }
    } catch (e) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };
  useEffect(() => { load(); }, []);
  const resetPage = () => (page.value = 1);

  const filtered = useMemo(() => rows.value, [rows.value]);
  const pagedRows = useMemo(() => {
    const start = (page.value - 1) * pageSize.value;
    return filtered.slice(start, start + pageSize.value);
  }, [filtered, page.value, pageSize.value]);

  const openForm = (d: any) => { editing.value = d; showModal.value = true; };
  const doDelete = async (d: any) => {
    if (!confirm(`確定刪除報價單 ${d.quotation_no}？`)) return;
    try { await api.del('/quotes/' + d.id); toast('已刪除', 'ok'); load(); }
    catch (e) { toast(e.message, 'err'); }
  };
  const onListClick = async (e: any) => {
    const t = e.target;
    const id = t.dataset.edit || t.dataset.print || t.dataset.del || t.dataset.preview || t.dataset.submit;
    if (!id) return;
    const cur = rows.value.find((r: any) => String(r.id) === String(id));
    if (!cur) return;
    if (t.dataset.edit) openForm(cur);
    else if (t.dataset.print) window.open(`/api/pdf/quotes/${cur.id}?token=${encodeURIComponent(localStorage.getItem('app_token') || '')}`, '_blank');
    else if (t.dataset.preview) { previewUrl.value = `/api/pdf/quotes/${cur.id}?token=${encodeURIComponent(localStorage.getItem('app_token') || '')}`; showPreview.value = true; }
    else if (t.dataset.submit) doSubmit(cur);
    else if (t.dataset.del) doDelete(cur);
  };

  /* 送簽（與出貨單一致） */
  const doSubmit = async (cur: any) => {
    try {
      await api.post(`/approvals/doc/quote/${cur.id}/submit`, {});
      toast(`報價單 ${cur.quotation_no || ''} 已發起簽核`, 'ok');
      load();
    } catch (e: any) { toast(e.message, 'err'); }
  };

  const selectAll = (root: any, checked: any) => {
    root.querySelectorAll('.sel-one').forEach((c: any) => { c.checked = checked; });
  };
  const selectedIds = () => [...(listRef.current?.querySelectorAll('.sel-one:checked') || [])].map((c: any) => Number(c.dataset.id));
  const onListChange = (e: any) => {
    if (e.target && e.target.id === 'sel-all') selectAll(listRef.current, e.target.checked);
  };
  const doBatchPdf = async () => {
    const ids = selectedIds();
    if (!ids.length) return toast('請先勾選報價單', 'warn');
    try {
      const d = new Date();
      const p = (n: any) => String(n).padStart(2, '0');
      await api.downloadBatchPdf({ type: 'quotes', ids }, `批次報價單_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.pdf`);
      toast(`已合併 ${ids.length} 張報價單為 1 個 PDF`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  const doBatchEmail = () => {
    const ids = selectedIds();
    if (!ids.length) return toast('請先勾選報價單', 'warn');
    emailIds.value = ids;
    showEmailModal.value = true;
  };
  const doSendEmails = async (p: any) => {
    const ids = emailIds.value;
    try {
      const r = await api.sendEmail('/email/send-batch', {
        items: ids.map((id: any) => ({ type: 'quote', id })),
        to: p.to,
        subject: p.subject || `報價單通知（${ids.length} 份）`,
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
    { key: 'quotation_no', label: '報價單號', render: (r: any) => `<b>${esc(r.quotation_no)}</b>` },
    { key: 'quotation_date', label: '報價日期', render: (r: any) => date(r.quotation_date) },
    { key: 'valid_until', label: '有效日期', render: (r: any) => date(r.valid_until) },
    { key: 'customer_no', label: '客戶編號', render: (r: any) => esc(r.customer_no || '') },
    { key: 'customer_name', label: '客戶名稱', render: (r: any) => esc(r.customer_name || '') },
    { key: 'content', label: '報價內容', render: (r: any) => `<span class="cell-ellipsis" title="${esc(r.content || '')}">${esc(r.content || '')}</span>` },
    { key: 'note', label: '備註', render: (r: any) => `<span class="cell-ellipsis" title="${esc(r.note || '')}">${esc(r.note || '')}</span>` },
    { key: 'status', label: '狀態', render: (r: any) => tag(STATUS[r.status] || r.status, STATUS_TAG[r.status] || 'gray') },
    { key: 'approval_status', label: '簽核狀態', html: true, render: (r: any) => approvalBadge(r.approval_status) },
  ];

  return (
    <>
      <div class="toolbar">
        <div class="fld"><label>關鍵字</label><input value={kw.value} onInput={(e: any) => { kw.value = e.currentTarget.value; resetPage(); }} placeholder="報價單號／客戶／料號" /></div>
        <div class="fld"><label>客戶</label><select value={cust.value} onChange={(e: any) => { cust.value = e.currentTarget.value; resetPage(); }}>
          <option value="">全部</option>{customersRef.value.map((c: any) => <option value={c.id}>{esc(c.name)}</option>)}</select></div>
        <div class="fld"><label>狀態</label><select value={st.value} onChange={(e: any) => { st.value = e.currentTarget.value; resetPage(); }}>
          <option value="">全部</option>{Object.entries(STATUS).map(([v, t]: any) => <option value={v}>{t}</option>)}</select></div>
        <div class="spacer" />
        <button class="btn" onClick={doBatchPdf}>批次合併列印</button>
        <button class="btn btn-mail" onClick={doBatchEmail}>批次寄 E-mail</button>
        <button class="btn btn-primary" onClick={() => openForm(null)}>＋ 新增報價單</button>
      </div>
      {loading.value
        ? <div class="empty">載入中…</div>
        : <>
            <div ref={listRef} onClick={onListClick} onChange={onListChange}>
              <Table columns={columns} rows={pagedRows}
                actions={(r: any) => {
                  /* 已送簽／已核准的報價單後端一律 409 拒絕修改與刪除，
                     前端同步鎖定按鈕，避免使用者點了才跳錯誤 */
                  const locked = r.approval_status === 'pending' || r.approval_status === 'approved';
                  const why = r.approval_status === 'pending' ? '簽核中，不可修改或刪除' : '已簽核通過，不可修改或刪除';
                  const lk = locked ? ` disabled title="${why}" style="opacity:.5;cursor:not-allowed"` : '';
                  return `<button class="btn btn-sm" data-edit="${r.id}"${lk}>修改</button><button class="btn btn-sm" data-preview="${r.id}">預覽</button><button class="btn btn-sm" data-print="${r.id}">列印</button>${(r.approval_status === 'none' || r.approval_status === 'returned') ? `<button class="btn btn-sm btn-primary" data-submit="${r.id}">送簽</button>` : ''}<button class="btn btn-sm btn-danger" data-del="${r.id}"${lk}>刪除</button>`;
                }} />
            </div>
            <Pagination page={page.value} pageSize={pageSize.value} total={filtered.length}
              onPageChange={(p: any) => (page.value = p)}
              onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
          </>}
      {showModal.value && (
        <QuotationFormModal d={editing.value} customers={customersRef.value}
          onClose={() => (showModal.value = false)}
          onSaved={() => { showModal.value = false; load(); }} />
      )}
      {showEmailModal.value && (
        <EmailModal count={emailIds.value.length} type="報價單"
          defaultEmails={emailIds.value.map((id: any) => rows.value.find((r: any) => String(r.id) === String(id))?.customer_email || '').filter(Boolean).filter((v: any, i: any, a: any) => a.indexOf(v) === i).join(', ')}
          defaultSubject="感謝貴公司的詢價本公司報價單如附件請參閱如有任何問題請與我司聯繫"
          attachments={emailIds.value.map((id: any) => rows.value.find((r: any) => String(r.id) === String(id))?.quotation_no || '').filter(Boolean).map((no: any) => `quotation-${no}.pdf`)}
          onConfirm={doSendEmails}
          onClose={() => (showEmailModal.value = false)} />
      )}
      {showPreview.value && (
        <PdfPreviewModal title="客戶報價單預覽" pdfUrl={previewUrl.value}
          onClose={() => (showPreview.value = false)} />
      )}
    </>
  );
}
Quotations.title = '客戶報價單';

/* ====================== 報價單表單（宣告式 Modal） ====================== */
function QuotationFormModal({ d, customers, onClose, onSaved }: any) {
  const isNew = !d || !d.id;
  const form = useSignal({
    quotation_no: d?.quotation_no || '',
    quotation_date: d?.quotation_date || todayStr(),
    valid_until: d?.valid_until || '',
    customer_id: d?.customer_id || 0,
    customer_no: d?.customer_no || '',
    sales_id: d?.sales_id || 0,
    currency: d?.currency || 'TWD',
    exchange_rate: d?.exchange_rate || 1,
    tax_rate: d?.tax_rate ?? 0.05,
    status: d?.status || 'draft',
    note: d?.note || '',
  });
  const items = useSignal(d?.items?.length ? d.items.map((i: any) => ({ ...i })) : [defaultItem()]);
  const products = useSignal(null);
  const busy = useSignal(false);

  useEffect(() => {
    if (productsCache) { products.value = productsCache; return; }
    api.get('/products').then((p: any) => { productsCache = p; products.value = p; }).catch(() => {});
  }, []);

  const set = (k: any, v: any) => (form.value = { ...form.value, [k]: v });

  const subtotal = items.value.reduce((s: number, it: any) => s + num(it.amount), 0);
  const taxTotal = items.value.reduce((s: number, it: any) => s + num(it.tax_amount), 0);
  const grand = items.value.reduce((s: number, it: any) => s + num(it.total), 0);

  const save = async () => {
    const f = form.value;
    if (!Number(f.customer_id)) return toast('請選擇客戶', 'warn');
    if (!f.valid_until) return toast('請填寫有效日期', 'warn');
    const clean = items.value.filter((i: any) => String(i.part_no || '').trim());
    if (!clean.length) return toast('至少需要一筆報價明細', 'warn');
    busy.value = true;
    try {
      const p = {
        quotation_no: f.quotation_no, quotation_date: f.quotation_date, valid_until: f.valid_until,
        customer_id: Number(f.customer_id), sales_id: Number(f.sales_id) || null,
        currency: f.currency, exchange_rate: Number(f.exchange_rate || 0),
        tax_rate: Number(f.tax_rate || 0), status: f.status, note: f.note, items: clean,
      };
      if (isNew) await api.post('/quotes', p);
      else await api.put('/quotes/' + d.id, p);
      toast(isNew ? '報價單已建立' : '報價單已更新', 'ok');
      onSaved?.();
    } catch (e) { toast(e.message, 'err'); }
    finally { busy.value = false; }
  };

  const custOpts = [[0, '（請選擇）']].concat((customers || []).map((c: any) => [c.id, c.name]));
  const curOpts = ['TWD', 'USD', 'RMB'].map((c: any) => [c, c]);

  return (
    <Modal title={isNew ? '新增報價單' : `報價單 ${d.quotation_no || ''}`} wide onSave={save}
      saveText={isNew ? '建立報價單' : '儲存'} onClose={onClose}>
      <div class="form-grid">
        <div>
          <label class="f">報價單號（留空自動產生）</label>
          <input value={form.value.quotation_no} onInput={(e: any) => set('quotation_no', e.currentTarget.value)} style="width:100%" />
        </div>
        <div>
          <label class="f">報價日期 *</label>
          <input type="date" value={form.value.quotation_date} onInput={(e: any) => set('quotation_date', e.currentTarget.value)} style="width:100%" />
        </div>
        <div>
          <label class="f">有效日期 *</label>
          <input type="date" value={form.value.valid_until} onInput={(e: any) => set('valid_until', e.currentTarget.value)} style="width:100%" />
        </div>
        <div>
          <label class="f">客戶編號</label>
          <input value={form.value.customer_no || ''} placeholder="輸入編號自動帶入客戶"
            onInput={(e: any) => {
              const v = e.currentTarget.value;
              set('customer_no', v);
              const c = (customers || []).find((x: any) => String(x.customer_no || '') === String(v).trim());
              if (c) set('customer_id', c.id);
            }} style="width:100%" />
        </div>
        <div>
          <label class="f">客戶 *</label>
          <select value={form.value.customer_id} onChange={(e: any) => {
            const id = e.currentTarget.value;
            set('customer_id', id);
            const c = (customers || []).find((x: any) => String(x.id) === String(id));
            if (c) set('customer_no', c.customer_no || '');
          }} style="width:100%">
            {custOpts.map((o: any) => <option value={o[0]}>{esc(o[1])}</option>)}
          </select>
        </div>
        <div>
          <label class="f">業務</label>
          <select value={form.value.sales_id} onChange={(e: any) => set('sales_id', e.currentTarget.value)} style="width:100%">
            <option value={0}>（未指定）</option>
            <option value={1}>admin 系統管理員</option>
          </select>
        </div>
        <div>
          <label class="f">幣別</label>
          <select value={form.value.currency} onChange={(e: any) => set('currency', e.currentTarget.value)} style="width:100%">
            {curOpts.map((c: any) => <option value={c[0]}>{c[0]}</option>)}
          </select>
        </div>
        <div>
          <label class="f">匯率（1 外幣 = ? 本位幣）</label>
          <input type="number" step={0.000001} value={form.value.exchange_rate}
            onInput={(e: any) => set('exchange_rate', e.currentTarget.value)} style="width:100%" />
        </div>
        <div>
          <label class="f">稅率 %</label>
          <input type="number" step={0.01} value={Number(form.value.tax_rate) * 100}
            onInput={(e: any) => set('tax_rate', Number(e.currentTarget.value || 0) / 100)} style="width:100%" />
        </div>
        <div>
          <label class="f">狀態</label>
          <select value={form.value.status} onChange={(e: any) => set('status', e.currentTarget.value)} style="width:100%">
            {Object.entries(STATUS).map(([v, t]: any) => <option value={v}>{t}</option>)}
          </select>
        </div>
        <div style="grid-column:1/-1">
          <label class="f">備註</label>
          <textarea value={form.value.note} onInput={(e: any) => set('note', e.currentTarget.value)} rows={2} style="width:100%" />
        </div>
      </div>
      <QuotationItemsEditor items={items.value} products={products.value}
        taxRate={Number(form.value.tax_rate ?? 0.05)} currency={form.value.currency}
        onChange={(v: any) => (items.value = v)} />
      <div class="calc-note">
        小計 {num(subtotal)} ｜ 稅額 {num(taxTotal)} ｜ <b>總計（原幣）{num(grand)}</b> ｜ 幣別 {form.value.currency}
      </div>
      {busy.value && <div style="font-size:12px;color:#6b7280;margin-top:6px">儲存中…</div>}
    </Modal>
  );
}

/* ====================== 報價明細編輯器（宣告式） ====================== */
function QuotationItemsEditor({ items, products, taxRate, onChange, currency = 'TWD' }: any) {
  const up = (i: number, patch: any) => {
    // 台幣（本位幣）取整數元、外幣到分——與後端 routes/quotes.js saveItems 對齊
    const dec = String(currency || 'TWD').toUpperCase() === 'TWD' ? 0 : 2;
    const r2 = (v: number) => Math.round((Number(v) + Number.EPSILON) * Math.pow(10, dec)) / Math.pow(10, dec);
    const arr = items.map((it: any, idx: number) => {
      if (idx !== i) return it;
      const next = { ...it, ...patch };
      const qty = Number(num(next.qty, 0));
      const price = Number(num(next.unit_price, 0));
      const tr = next.tax_rate === undefined || next.tax_rate === null ? taxRate : num(next.tax_rate, 0);
      next.amount = r2(qty * price);
      next.tax_amount = r2(next.amount * tr);
      next.total = r2(next.amount + next.tax_amount);
      return next;
    });
    onChange(arr);
  };
  const pick = (i: number, pid: any) => {
    const p = (products || []).find((x: any) => String(x.id) === String(pid));
    up(i, { product_id: Number(pid) || 0, part_no: p?.part_no || '', description: p?.name || '' });
  };
  const addRow = () => onChange([...items, defaultItem()]);
  const delRow = (i: number) => onChange(items.filter((_: any, idx: number) => idx !== i));

  return (
    <div style="margin-top:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <label class="f">報價明細</label>
        <button class="btn btn-sm" type="button" onClick={addRow}>＋ 加一行</button>
      </div>
      <div style="overflow-x:auto">
        <table class="table" style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th>料號</th><th>品名／規格</th><th>數量</th><th>單位</th><th>單價</th>
              <th>稅率%</th><th>金額</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it: any, i: number) => (
              <tr key={i}>
                <td>
                  <select value={it.product_id} onChange={(e: any) => pick(i, e.currentTarget.value)}>
                    <option value={0}>（手輸）</option>
                    {(products || []).map((p: any) => <option value={p.id}>{esc(p.part_no)}</option>)}
                  </select>
                </td>
                <td>
                  <input style="width:130px" value={it.part_no} onInput={(e: any) => up(i, { part_no: e.currentTarget.value })} placeholder="料號" />
                  <input style="width:150px" value={it.description} onInput={(e: any) => up(i, { description: e.currentTarget.value })} placeholder="品名／規格" />
                </td>
                <td><input type="number" style="width:70px" value={it.qty} onInput={(e: any) => up(i, { qty: e.currentTarget.value })} /></td>
                <td><input style="width:60px" value={it.unit} onInput={(e: any) => up(i, { unit: e.currentTarget.value })} /></td>
                <td><input type="number" style="width:90px" value={it.unit_price} onInput={(e: any) => up(i, { unit_price: e.currentTarget.value })} /></td>
                <td><input type="number" style="width:60px" value={Number(it.tax_rate ?? taxRate) * 100} onInput={(e: any) => up(i, { tax_rate: Number(e.currentTarget.value || 0) / 100 })} /></td>
                <td style="text-align:right">{num(it.total)}</td>
                <td><button class="btn btn-sm btn-danger" type="button" onClick={() => delRow(i)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
