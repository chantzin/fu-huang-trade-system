// 供應商報價單（供應鏈 / Preact）
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
const todayStr = () => new Date().toISOString().slice(0, 10);
const STATUS: any = { draft: '草稿', quoted: '已報價', expired: '已逾期', void: '已作廢' };

export default function SupplierQuotes() {
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
      const [list, sups] = await Promise.all([api.get('/supplier-quotes'), api.get('/suppliers')]);
      rows.value = list; suppliersRef.value = sups;
    } catch (e) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };
  useEffect(() => { load(); }, []);

  const filtered = useComputed(() => {
    const k = kw.value.trim().toLowerCase(), s = supplier.value;
    if (!k && !s) return rows.value;
    return rows.value.filter((r: any) =>
      (!k || [r.quote_no, r.supplier_name, r.content, r.note].filter(Boolean).some((v: any) => String(v).toLowerCase().includes(k))) &&
      (!s || String(r.supplier_id) === s));
  });

  const pagedRows = useComputed(() => {
    const start = (page.value - 1) * pageSize.value;
    return filtered.value.slice(start, start + pageSize.value);
  });
  const resetPage = () => { page.value = 1; };

  const del = async (cur: any) => {
    if (await confirmDialog(`確定刪除供應商報價單「${cur.quote_no}」？`)) {
      try { await api.del('/supplier-quotes/' + cur.id); toast('報價單已刪除', 'ok'); load(); }
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
  const doBatchPdf = async () => {
    const ids = selectedIds();
    if (!ids.length) return toast('請先勾選報價單', 'warn');
    try {
      const d = new Date();
      const p = (n: any) => String(n).padStart(2, '0');
      await api.downloadBatchPdf({ type: 'supplier-quotes', ids }, `供應商報價單_批次_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.pdf`);
      toast(`已合併 ${ids.length} 張供應商報價單為 1 個 PDF`, 'ok');
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
        items: ids.map((id: any) => ({ type: 'supplier-quote', id })),
        to: p.to,
        subject: p.subject || `供應商報價單通知（${ids.length} 份）`,
        html: p.html,
        bcc: p.bcc,
        extraAttachments: p.extraAttachments,
      });
      toast(`已寄出 ${r.sent} 封郵件` + (r.skipped && r.skipped.length ? `，${r.skipped.length} 組略過` : ''), 'ok');
      if (r.details && r.details[0] && r.details[0].previewUrl) { toast('測試模式：預覽郵件 ' + r.details[0].previewUrl, 'ok'); }
    } catch (e) { toast(e.message, 'err'); }
  };
  const convertToOrder = async (r: any) => {
    if (r.status !== 'quoted' || (r.valid_until && r.valid_until < todayStr())) return toast('僅有效且已報價的報價單可轉採購', 'warn');
    if (!await confirmDialog(`由報價「${r.quote_no}」建立採購單？系統會帶入供應商與報價明細，採購單仍須送簽核准後才能收貨。`)) return;
    try { const order = await api.post(`/supplier-orders/from-quote/${r.id}`, {}); toast(`已建立採購單 ${order.order_no}`, 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };

  const columns = [
    { key: '_sel', label: '<input type="checkbox" id="sel-all" />', html: true, render: (r: any) => `<input type="checkbox" class="sel-one" data-id="${r.id}" />` },
    { key: 'quote_no', label: '報價單號', render: (r: any) => `<b>${esc(r.quote_no)}</b>` },
    { key: 'quote_date', label: '報價日期', render: (r: any) => date(r.quote_date) },
    { key: 'valid_until', label: '有效日期', render: (r: any) => date(r.valid_until) },
    { key: 'supplier_name', label: '供應商' },
    { key: 'content', label: '報價內容' },
    { key: 'status', label: '狀態', render: (r: any) => STATUS[r.status] || r.status },
    { key: 'note', label: '備註' },
  ];

  return (
    <>
      <div class="toolbar">
        <div class="fld"><label>關鍵字</label><input value={kw.value} onInput={(e: any) => { kw.value = e.currentTarget.value; resetPage(); }} placeholder="報價單號／供應商／料號" /></div>
        <div class="fld"><label>供應商</label><select value={supplier.value} onChange={(e: any) => { supplier.value = e.currentTarget.value; resetPage(); }}>
          <option value="">全部</option>{suppliersRef.value.map((s: any) => <option value={s.id}>{esc(s.name)}</option>)}</select></div>
        <div class="spacer" />
        <button class="btn" onClick={doBatchPdf}>批次合併列印</button>
        <button class="btn btn-mail" onClick={doBatchEmail}>批次寄 E-mail</button>
        <button class="btn btn-primary" onClick={() => { editing.value = null; showModal.value = true; }}>＋ 新增報價單</button>
      </div>
      {loading.value
        ? <div class="empty">載入中…</div>
        : <>
            <div ref={listRef} onChange={onListChange}>
              <Table columns={columns} rows={pagedRows.value} actions={(r: any) => (
                <div style="display:flex;gap:6px;white-space:nowrap">
                  <button class="btn btn-sm" onClick={() => { editing.value = r; showModal.value = true; }}>編輯</button>
                  <button class="btn btn-sm" onClick={() => convertToOrder(r)}>轉採購</button>
                  <button class="btn btn-sm" onClick={() => { previewUrl.value = `/api/pdf/supplier-quotes/${r.id}?token=${encodeURIComponent(localStorage.getItem('app_token') || '')}`; showPreview.value = true; }}>預覽</button>
                  <button class="btn btn-sm" onClick={() => window.open(`/api/pdf/supplier-quotes/${r.id}?token=${encodeURIComponent(localStorage.getItem('app_token') || '')}`, '_blank')}>列印</button>
                  {canManage() && <button class="btn btn-sm btn-danger" onClick={() => del(r)}>刪除</button>}
                </div>
              )} />
            </div>
            <Pagination page={page.value} pageSize={pageSize.value} total={filtered.value.length}
              onPageChange={(p: any) => (page.value = p)}
              onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
          </>}
      {showModal.value && (
        <SupplierQuoteFormModal d={editing.value} suppliers={suppliersRef.value}
          onClose={() => (showModal.value = false)}
          onSaved={() => { showModal.value = false; load(); }} />
      )}
      {showEmailModal.value && (
        <EmailModal count={emailIds.value.length} type="供應商報價單"
          defaultEmails={emailIds.value.map((id: any) => rows.value.find((r: any) => String(r.id) === String(id))?.supplier_email || '').filter(Boolean).filter((v: any, i: any, a: any) => a.indexOf(v) === i).join(', ')}
          defaultSubject="供應商報價單通知，詳如附件，請參閱，如有任何問題請與我司聯繫"
          attachments={emailIds.value.map((id: any) => rows.value.find((r: any) => String(r.id) === String(id))?.quote_no || '').filter(Boolean).map((no: any) => `supplier-quote-${no}.pdf`)}
          onConfirm={doSendEmails}
          onClose={() => (showEmailModal.value = false)} />
      )}
      {showPreview.value && (
        <PdfPreviewModal title="供應商報價單預覽" pdfUrl={previewUrl.value}
          onClose={() => (showPreview.value = false)} />
      )}
    </>
  );
}
SupplierQuotes.title = '供應商報價單';

/* ====================== 表單（宣告式 Modal） ====================== */
function SupplierQuoteFormModal({ d, suppliers, onClose, onSaved }: any) {
  const isNew = !d || !d.id;
  const form = useSignal({
    quote_no: d?.quote_no || '',
    quote_date: d?.quote_date || todayStr(),
    valid_until: d?.valid_until || '',
    supplier_id: d?.supplier_id || 0,
    tax_rate: d?.tax_rate ?? 0.05,
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
    if (!clean.length) return toast('至少需要一筆報價明細', 'warn');
    busy.value = true;
    try {
      const p = {
        quote_no: f.quote_no, quote_date: f.quote_date, valid_until: f.valid_until,
        supplier_id: Number(f.supplier_id), tax_rate: Number(f.tax_rate || 0),
        status: f.status, note: f.note, items: clean,
      };
      if (isNew) await api.post('/supplier-quotes', p);
      else await api.put('/supplier-quotes/' + d.id, p);
      toast(isNew ? '供應商報價單已建立' : '供應商報價單已更新', 'ok');
      onSaved?.();
    } catch (e) { toast(e.message, 'err'); }
    finally { busy.value = false; }
  };

  const supOpts = [[0, '（請選擇）']].concat((suppliers || []).map((s: any) => [s.id, s.name]));

  return (
    <Modal title={isNew ? '新增供應商報價單' : `報價單 ${d.quote_no || ''}`} wide onSave={save}
      saveText={isNew ? '建立報價單' : '儲存'} onClose={onClose}>
      <div class="form-grid">
        <div><label class="f">報價單號（留空自動產生）</label><input value={form.value.quote_no} onInput={(e: any) => set('quote_no', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">報價日期 *</label><input type="date" value={form.value.quote_date} onInput={(e: any) => set('quote_date', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">有效日期 *</label><input type="date" value={form.value.valid_until} onInput={(e: any) => set('valid_until', e.currentTarget.value)} style="width:100%" /></div>
        <div>
          <label class="f">供應商 *</label>
          <select value={form.value.supplier_id} onChange={(e: any) => set('supplier_id', e.currentTarget.value)} style="width:100%">
            {supOpts.map((o: any) => <option value={o[0]}>{esc(o[1])}</option>)}
          </select>
        </div>
        <div><label class="f">稅率 %</label><input type="number" step={0.01} value={Number(form.value.tax_rate) * 100} onInput={(e: any) => set('tax_rate', Number(e.currentTarget.value || 0) / 100)} style="width:100%" /></div>
        <div>
          <label class="f">狀態</label>
          <select value={form.value.status} onChange={(e: any) => set('status', e.currentTarget.value)} style="width:100%">
            {Object.entries(STATUS).map(([v, t]: any) => <option value={v}>{t}</option>)}
          </select>
        </div>
        <div style="grid-column:1/-1"><label class="f">備註</label><textarea value={form.value.note} onInput={(e: any) => set('note', e.currentTarget.value)} rows={2} style="width:100%" /></div>
      </div>
      <ScItemsEditor items={items.value} products={products.value}
        taxRate={Number(form.value.tax_rate ?? 0.05)} onChange={(v: any) => (items.value = v)} title="報價明細" />
      <div class="calc-note">小計 {num(subtotal)} ｜ 稅額 {num(taxTotal)} ｜ <b>總計 {num(grand)}</b></div>
      {busy.value && <div style="font-size:12px;color:#6b7280;margin-top:6px">儲存中…</div>}
    </Modal>
  );
}

function defaultItem() {
  return { product_id: 0, part_no: '', description: '', qty: 1, unit: 'PCS', unit_price: 0, tax_rate: 0.05, amount: 0, tax_amount: 0, total: 0 };
}

/* ====================== 明細編輯器（共用：供應商報價/訂單） ====================== */
export function ScItemsEditor({ items, products, taxRate, onChange, title }: any) {
  const up = (i: number, patch: any) => {
    const r2 = (v: number) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
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
        <label class="f">{title || '明細'}</label>
        <button class="btn btn-sm" type="button" onClick={addRow}>＋ 加一行</button>
      </div>
      <div style="overflow-x:auto">
        <table class="table" style="width:100%;border-collapse:collapse">
          <thead>
            <tr><th>料號</th><th>品名／規格</th><th>數量</th><th>單位</th><th>單價</th><th>稅率%</th><th>金額</th><th></th></tr>
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
