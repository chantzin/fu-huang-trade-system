// 供應商出貨與單據（進貨單，供應鏈 / Preact）
import { useSignal, useComputed } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { user } from '../store.ts';
import { toast } from '../store.ts';
import Table from '../ui/Table.tsx';
import Pagination from '../ui/Pagination.tsx';
import Modal, { confirmDialog } from '../ui/Modal.tsx';
import { esc, num, date } from '../ui/format.ts';

const canManage = () => ['admin', 'manager'].includes(user.value?.role);
const todayStr = () => new Date().toISOString().slice(0, 10);

export default function SupplierShipments() {
  const rows = useSignal([]);
  const kw = useSignal('');
  const supplier = useSignal('');
  const loading = useSignal(true);
  const showModal = useSignal(false);
  const editing = useSignal(null);
  const previewUrl = useSignal('');
  const showPreview = useSignal(false);
  const suppliersRef = useSignal([]);
  const ordersRef = useSignal([]);
  const page = useSignal(1);
  const pageSize = useSignal(20);
  const convertShipment = useSignal(null as any);

  const load = async () => {
    loading.value = true;
    try {
      const [list, sups, sos] = await Promise.all([api.get('/supplier-shipments'), api.get('/suppliers'), api.get('/supplier-orders')]);
      rows.value = list; suppliersRef.value = sups; ordersRef.value = sos;
    } catch (e) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };
  useEffect(() => { load(); }, []);

  const filtered = useComputed(() => {
    const k = kw.value.trim().toLowerCase(), s = supplier.value;
    if (!k && !s) return rows.value;
    return rows.value.filter((r: any) =>
      (!k || [r.shipment_no, r.invoice_no, r.supplier_name, r.order_no].filter(Boolean).some((v: any) => String(v).toLowerCase().includes(k))) &&
      (!s || String(r.supplier_id) === s));
  });

  const pagedRows = useComputed(() => {
    const start = (page.value - 1) * pageSize.value;
    return filtered.value.slice(start, start + pageSize.value);
  });
  const resetPage = () => { page.value = 1; };

  const del = async (cur: any) => {
    if (await confirmDialog(`確定刪除進貨單「${cur.shipment_no}」？`)) {
      try { await api.del('/supplier-shipments/' + cur.id); toast('進貨單已刪除', 'ok'); load(); }
      catch (e) { toast(e.message, 'err'); }
    }
  };

  const columns = [
    { key: 'shipment_no', label: '進貨單號', render: (r: any) => `<b>${esc(r.shipment_no)}</b>` },
    { key: 'supplier_name', label: '供應商' },
    { key: 'order_no', label: '採購單號' },
    { key: 'ship_date', label: '進貨日期', render: (r: any) => date(r.ship_date) },
    { key: 'qty', label: '數量', num: true, render: (r: any) => num(r.qty) },
    { key: 'invoice_no', label: '發票號碼' },
    { key: 'invoice_date', label: '發票日期', render: (r: any) => date(r.invoice_date) },
    { key: 'note', label: '備註' },
  ];

  return (
    <>
      <div class="toolbar">
        <div class="fld"><label>關鍵字</label><input value={kw.value} onInput={(e: any) => { kw.value = e.currentTarget.value; resetPage(); }} placeholder="進貨單號／發票／供應商" /></div>
        <div class="fld"><label>供應商</label><select value={supplier.value} onChange={(e: any) => { supplier.value = e.currentTarget.value; resetPage(); }}>
          <option value="">全部</option>{suppliersRef.value.map((s: any) => <option value={s.id}>{esc(s.name)}</option>)}</select></div>
        <div class="spacer" />
        <button class="btn btn-primary" onClick={() => { editing.value = null; showModal.value = true; }}>＋ 登錄進貨</button>
      </div>
      {loading.value
        ? <div class="empty">載入中…</div>
        : <>
            <Table columns={columns} rows={pagedRows.value} actions={(r: any) => (
              <div style="display:flex;gap:6px;white-space:nowrap">
                <button class="btn btn-sm" onClick={() => { editing.value = r; showModal.value = true; }}>編輯</button>
                {r.invoice_no && <button class="btn btn-sm" onClick={() => (convertShipment.value = r)}>轉應付</button>}
                <button class="btn btn-sm" onClick={() => { previewUrl.value = `/api/pdf/supplier-shipments/${r.id}?token=${encodeURIComponent(localStorage.getItem('app_token') || '')}`; showPreview.value = true; }}>預覽</button>
                {canManage() && <button class="btn btn-sm btn-danger" onClick={() => del(r)}>刪除</button>}
              </div>
            )} />
            <Pagination page={page.value} pageSize={pageSize.value} total={filtered.value.length}
              onPageChange={(p: any) => (page.value = p)}
              onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
          </>}
      {showModal.value && (
        <SupplierShipmentFormModal d={editing.value} suppliers={suppliersRef.value} orders={ordersRef.value}
          onClose={() => (showModal.value = false)}
          onSaved={() => { showModal.value = false; load(); }} />
      )}
      {convertShipment.value && <SupplierInvoiceModal shipment={convertShipment.value} onClose={() => (convertShipment.value = null)} onSaved={() => { convertShipment.value = null; toast('應付帳款已建立', 'ok'); }} />}
    </>
  );
}

function SupplierInvoiceModal({ shipment, onClose, onSaved }: any) {
  const form = useSignal({ amount: '', currency: 'TWD', exchange_rate: '1', invoice_date: shipment.invoice_date || '', due_date: '', note: '' });
  const busy = useSignal(false);
  const set = (k: string, v: string) => (form.value = { ...form.value, [k]: v });
  const save = async () => {
    if (!(Number(form.value.amount) > 0) || !(Number(form.value.exchange_rate) > 0)) return toast('請輸入正確的發票金額與匯率', 'warn');
    busy.value = true;
    try { await api.post(`/payables/from-supplier-shipment/${shipment.id}`, form.value); onSaved?.(); }
    catch (e) { toast(e.message, 'err'); }
    finally { busy.value = false; }
  };
  return <Modal title={`發票轉應付 — ${shipment.invoice_no}`} onSave={save} onClose={onClose}>
    <div class="calc-note">請依供應商發票確認實際金額與匯率；系統不會以採購金額代替發票金額。</div>
    <div class="form-grid">
      <div><label class="f">發票金額 *</label><input type="number" min="0.01" step="0.01" value={form.value.amount} onInput={(e:any)=>set('amount',e.currentTarget.value)} /></div>
      <div><label class="f">幣別</label><input value={form.value.currency} onInput={(e:any)=>set('currency',e.currentTarget.value.toUpperCase())} /></div>
      <div><label class="f">匯率（外幣兌本位幣）</label><input type="number" min="0.000001" step="0.000001" value={form.value.exchange_rate} onInput={(e:any)=>set('exchange_rate',e.currentTarget.value)} /></div>
      <div><label class="f">發票日期</label><input type="date" value={form.value.invoice_date} onInput={(e:any)=>set('invoice_date',e.currentTarget.value)} /></div>
      <div><label class="f">到期日</label><input type="date" value={form.value.due_date} onInput={(e:any)=>set('due_date',e.currentTarget.value)} /></div>
      <div style="grid-column:1/-1"><label class="f">備註</label><textarea value={form.value.note} onInput={(e:any)=>set('note',e.currentTarget.value)} /></div>
    </div>{busy.value && <div>儲存中…</div>}
  </Modal>;
}
SupplierShipments.title = '供應商出貨與單據';

function SupplierShipmentFormModal({ d, suppliers, orders, onClose, onSaved }: any) {
  const isNew = !d || !d.id;
  const form = useSignal({
    shipment_no: d?.shipment_no || '',
    supplier_id: d?.supplier_id || 0,
    order_id: d?.order_id || 0,
    order_item_id: d?.order_item_id || 0,
    product_id: d?.product_id || 0,
    unit_cost: d?.unit_cost || 0,
    ship_date: d?.ship_date || todayStr(),
    qty: d?.qty || 0,
    invoice_no: d?.invoice_no || '',
    invoice_date: d?.invoice_date || '',
    note: d?.note || '',
  });
  const orderItems = useSignal([] as any[]);
  const busy = useSignal(false);
  useEffect(() => { if (d?.order_id) api.get('/supplier-orders/' + d.order_id).then((o:any)=>orderItems.value=o.items||[]).catch(()=>{}); }, []);
  const set = (k: any, v: any) => {
    form.value = { ...form.value, [k]: v };
    if (k === 'order_id' && Number(v)) api.get('/supplier-orders/' + v).then((o:any)=>{ orderItems.value=o.items||[]; }).catch((e:any)=>toast(e.message,'err'));
    if (k === 'order_id' && !Number(v)) orderItems.value=[];
    if (k === 'order_item_id') { const item=orderItems.value.find((x:any)=>String(x.id)===String(v)); if(item) form.value={...form.value,order_item_id:v,product_id:item.product_id||0,unit_cost:item.unit_price||0,qty:Math.max(0,Number(item.qty||0))}; }
  };
  const supOpts = [[0, '（請選擇）']].concat((suppliers || []).map((s: any) => [s.id, s.name]));
  const orderOpts = [[0, '（不關聯）']].concat((orders || []).map((o: any) => [o.id, `${o.order_no} — ${o.supplier_name || ''}`]));

  const save = async () => {
    const f = form.value;
    if (!Number(f.supplier_id)) return toast('請選擇供應商', 'warn');
    busy.value = true;
    try {
      const p = {
        shipment_no: f.shipment_no, supplier_id: Number(f.supplier_id),
        order_id: Number(f.order_id) || null, ship_date: f.ship_date,
        order_item_id: Number(f.order_item_id)||null, product_id:Number(f.product_id)||null, unit_cost:Number(f.unit_cost||0),
        qty: Number(f.qty || 0), invoice_no: f.invoice_no, invoice_date: f.invoice_date, note: f.note,
      };
      if (isNew) await api.post('/supplier-shipments', p);
      else await api.put('/supplier-shipments/' + d.id, p);
      toast(isNew ? '進貨已登錄' : '進貨單已更新', 'ok');
      onSaved?.();
    } catch (e) { toast(e.message, 'err'); }
    finally { busy.value = false; }
  };

  return (
    <Modal title={isNew ? '登錄供應商進貨' : `編輯進貨單 — ${d.shipment_no}`} onSave={save} onClose={onClose}>
      <div class="form-grid">
        <div><label class="f">進貨單號（留空自動產生）</label><input value={form.value.shipment_no} onInput={(e: any) => set('shipment_no', e.currentTarget.value)} style="width:100%" /></div>
        <div>
          <label class="f">供應商 *</label>
          <select value={form.value.supplier_id} onChange={(e: any) => set('supplier_id', e.currentTarget.value)} style="width:100%">
            {supOpts.map((o: any) => <option value={o[0]}>{esc(o[1])}</option>)}
          </select>
        </div>
        <div>
          <label class="f">關聯採購單</label>
          <select value={form.value.order_id} onChange={(e: any) => set('order_id', e.currentTarget.value)} style="width:100%">
            {orderOpts.map((o: any) => <option value={o[0]}>{esc(o[1])}</option>)}
          </select>
        </div>
        {Number(form.value.order_id)>0 && <div>
          <label class="f">採購明細 *</label>
          <select value={form.value.order_item_id} onChange={(e:any)=>set('order_item_id',e.currentTarget.value)} style="width:100%">
            <option value="0">（請選擇採購明細）</option>{orderItems.value.map((it:any)=><option value={it.id}>{esc(it.part_no||it.description)} — 採購 {num(it.qty)} 件，單價 {num(it.unit_price)}</option>)}
          </select>
        </div>}
        <div><label class="f">進貨日期 *</label><input type="date" value={form.value.ship_date} onInput={(e: any) => set('ship_date', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">本次收貨數量 *</label><input type="number" min="0.01" step="0.01" value={form.value.qty} onInput={(e: any) => set('qty', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">進貨單位成本</label><input type="number" min="0" step="0.01" value={form.value.unit_cost} onInput={(e:any)=>set('unit_cost',e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">發票號碼</label><input value={form.value.invoice_no} onInput={(e: any) => set('invoice_no', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">發票日期</label><input type="date" value={form.value.invoice_date} onInput={(e: any) => set('invoice_date', e.currentTarget.value)} style="width:100%" /></div>
        <div style="grid-column:1/-1"><label class="f">備註</label><textarea value={form.value.note} onInput={(e: any) => set('note', e.currentTarget.value)} rows={2} style="width:100%" /></div>
      </div>
      <div class="calc-note">關聯採購單需已簽核核准；分批收貨依採購明細累計，未收完保持「部分進貨」。</div>
      {busy.value && <div style="font-size:12px;color:#6b7280;margin-top:6px">儲存中…</div>}
    </Modal>
  );
}
