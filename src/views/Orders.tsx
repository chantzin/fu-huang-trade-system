// 訂單管理（核心）：主檔 + 多筆料號明細 + 即時計算（Level B / Preact）
import { useSignal, useComputed } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';
import Table from '../ui/Table.tsx';
import Pagination from '../ui/Pagination.tsx';
import Modal from '../ui/Modal.tsx';
import EmailModal from '../ui/EmailModal.tsx';
import OrderItemsEditor from './OrderItemsEditor.tsx';
import PdfPreviewModal from '../ui/PdfPreviewModal.tsx';
import { esc, date, tag, getMoneyDecimals } from '../ui/format.ts';

const STATUS: any = { draft: '草稿', confirmed: '已確認', shipped: '已出貨', billed: '已結帳', paid: '已收款', closed: '結案', cancelled: '作廢' };
const STATUS_TAG: any = { draft: 'gray', confirmed: 'blue', shipped: 'blue', billed: 'yellow', paid: 'green', closed: 'green', cancelled: 'red' };

// 與後端 lib/util.js `round` / lib/calc.ts `calcItem` 完全一致的金額四捨五入，
// 消除 IEEE-754 浮點尾數（如 39*0.05 → 1.9500000000000002）。
// 訂單預覽（calcRow）在 v1.0.17 稅額修復時被「僅預覽」而延後，本處補齊，
// 使預覽值與後端落庫值完全一致（含 moneyDecimals 非零的情境）。
const roundMoney = (v: any, d = 2) => {
  const p = Math.pow(10, d);
  return Math.round((Number(v) + Number.EPSILON) * p) / p;
};
const moneyRoundLocal = (v: any) => roundMoney(v, getMoneyDecimals());

let productsCache: any = null; // 跨開啟快取（對應舊 this.products）

export function calcRow(r: any, rate: any, currency: any = 'TWD') {
  const qty = Number(r.qty || 0);
  const price = Number(r.unit_price || 0);
  const taxRate = Number(r.tax_rate || 0);
  // 台幣（本位幣）取整數元、外幣到分——與後端 lib/calc.ts decimalsFor 對齊
  const dec = String(currency || 'TWD').toUpperCase() === 'TWD' ? 0 : 2;
  const amount = roundMoney(qty * price, dec);
  const tax = roundMoney(amount * taxRate, dec);
  const total = roundMoney(amount + tax, dec);
  const totalBase = moneyRoundLocal(total * Number(rate || 1));
  const costTotal = moneyRoundLocal(Number(r.cost_unit || 0) * qty + Number(r.other_fee || 0));
  const freight = moneyRoundLocal(Number(r.freight_cn || 0) + Number(r.freight_tw || 0));
  const profit = moneyRoundLocal(totalBase - costTotal - freight);
  return { amount, tax, total, totalBase, costTotal, freight, profit, margin: totalBase > 0 ? roundMoney(profit / totalBase, 6) : 0 };
}
const defaultItem = () => ({ part_no: '', product_id: null as any, qty: 1, unit: 'PCS', unit_price: 0, tax_rate: 0.05, cost_unit: 0, other_fee: 0, freight_cn: 0, freight_tw: 0, note: '' });
const todayStr = () => new Date().toISOString().slice(0, 10);

export default function Orders() {
  const rows = useSignal([]);
  const kw = useSignal('');
  const cust = useSignal('');
  const st = useSignal('');
  const mo = useSignal('');
  const loading = useSignal(true);
  const showModal = useSignal(false);
  const showEmailModal = useSignal(false);
  const emailIds = useSignal([]);
  const previewUrl = useSignal('');
  const showPreview = useSignal(false);
  const editing = useSignal(null);
  const formCtxRef = useRef(null);
  const listRef = useRef(null);
  const pendingRef = useRef(null);
  const customersRef = useRef([]);
  const page = useSignal(1);
  const pageSize = useSignal(20);

  const load = async () => {
    loading.value = true;
    try {
      const [list, customers, users, suppliers, meta] = await Promise.all([
        api.get('/orders'), api.get('/customers'), api.get('/users'), api.get('/suppliers'), api.get('/params/meta'),
      ]);
      rows.value = list; customersRef.current = customers;
      formCtxRef.current = { customers, users, suppliers, meta };
    } catch (e) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };
  useEffect(() => {
    // 批次動作集中面板帶入的自動觸發旗標（執行完自動清除）
    try { pendingRef.current = JSON.parse(localStorage.getItem('mj.pendingBatch') || 'null'); } catch { pendingRef.current = null; }
    try { localStorage.removeItem('mj.pendingBatch'); } catch { /* ignore */ }
    load();
  }, []);

  const filtered = useComputed(() => {
    const k = kw.value.trim().toLowerCase();
    const c = cust.value, s = st.value, m = mo.value;
    if (!k && !c && !s && !m) return rows.value;
    return rows.value.filter((r: any) =>
      (!k || [r.order_no, r.customer_name, r.note].filter(Boolean).some((v: any) => String(v).toLowerCase().includes(k))) &&
      (!c || String(r.customer_id) === c) &&
      (!s || r.status === s) &&
      (!m || r.month === m));
  });

  const pagedRows = useComputed(() => {
    const start = (page.value - 1) * pageSize.value;
    return filtered.value.slice(start, start + pageSize.value);
  });

  const resetPage = () => { page.value = 1; };

  // 批次動作自動觸發
  useEffect(() => {
    if (!pendingRef.current || !listRef.current) return;
    const pend = pendingRef.current; pendingRef.current = null;
    const selAll = listRef.current.querySelector('#sel-all');
    if (selAll) { selAll.checked = true; selectAll(listRef.current, true); }
    if (pend.act === 'pdf') setTimeout(() => doBatchPdf(), 200);
    else if (pend.act === 'email') setTimeout(() => doBatchEmail(), 200);
  }, [rows.value]);

  const selectAll = (root: any, checked: any) => {
    root.querySelectorAll('.sel-one').forEach((c: any) => { c.checked = checked; });
  };
  const selectedIds = () => [...(listRef.current?.querySelectorAll('.sel-one:checked') || [])].map((c: any) => Number(c.dataset.id));

  const doBatchPdf = async () => {
    const ids = selectedIds();
    if (!ids.length) return toast('請先勾選訂單', 'warn');
    try {
      await api.downloadBatchPdf({ type: 'orders', ids }, `批次訂單_${todayStr()}.pdf`);
      toast(`已合併 ${ids.length} 張訂單為 1 個 PDF`, 'ok');
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
        items: ids.map((id: any) => ({ type: 'order', id })),
        to: p.to,
        subject: p.subject || `訂單通知（${ids.length} 份）`,
        html: p.html,
        bcc: p.bcc,
        extraAttachments: p.extraAttachments,
      });
      toast(`已寄出 ${r.sent} 封郵件` + (r.skipped && r.skipped.length ? `，${r.skipped.length} 組略過` : ''), 'ok');
      if (r.details && r.details[0] && r.details[0].previewUrl) { toast('測試模式：預覽郵件 ' + r.details[0].previewUrl, 'ok'); }
    } catch (e) { toast(e.message, 'err'); }
  };

  const openForm = (order: any) => {
    editing.value = order || null;
    showModal.value = true;
  };

  const onListClick = async (e: any) => {
    const t = e.target;
    const id = t.dataset.open || t.dataset.preview;
    if (!id) return;
    if (t.dataset.preview) { previewUrl.value = `/api/pdf/orders/?token=`; showPreview.value = true; return; }
    try {
      const o = await api.get('/orders/' + id);
      openForm(o);
    } catch (err) { toast(err.message, 'err'); }
  };
  const onListChange = (e: any) => {
    if (e.target && e.target.id === 'sel-all') selectAll(listRef.current, e.target.checked);
  };

  const columns = [
    { key: '_sel', label: '<input type="checkbox" id="sel-all" />', html: true, render: (r: any) => `<input type="checkbox" class="sel-one" data-id="${r.id}" />` },
    { key: 'order_no', label: '訂單編號', render: (r: any) => `<b>${esc(r.order_no)}</b>` },
    { key: 'order_date', label: '訂單日期', render: (r: any) => date(r.order_date) },
    { key: 'customer_name', label: '客戶' },
    { key: 'sales_name', label: '業務' },
    { key: 'currency', label: '幣別' },
    { key: 'factory_eta', label: '工廠交期', render: (r: any) => date(r.factory_eta) },
    { key: 'customer_eta', label: '客戶交期', render: (r: any) => date(r.customer_eta) },
    { key: 'ship_date', label: '出貨日', render: (r: any) => date(r.ship_date) },
    { key: 'status', label: '狀態', render: (r: any) => tag(STATUS[r.status] || r.status, STATUS_TAG[r.status] || 'gray') },
  ];

  return (
    <>
      <div class="toolbar">
        <div class="fld"><label>關鍵字</label><input value={kw.value} onInput={(e: any) => { kw.value = e.currentTarget.value; resetPage(); }} placeholder="訂單編號／客戶／料號" /></div>
        <div class="fld"><label>客戶</label><select value={cust.value} onChange={(e: any) => { cust.value = e.currentTarget.value; resetPage(); }}>
          <option value="">全部</option>{customersRef.current.map((c: any) => <option value={c.id}>{esc(c.name)}</option>)}</select></div>
        <div class="fld"><label>狀態</label><select value={st.value} onChange={(e: any) => { st.value = e.currentTarget.value; resetPage(); }}>
          <option value="">全部</option>{Object.entries(STATUS).map(([v, t]: any) => <option value={v}>{t}</option>)}</select></div>
        <div class="fld"><label>月份</label><input type="month" value={mo.value} onInput={(e: any) => { mo.value = e.currentTarget.value; resetPage(); }} /></div>
        <div class="spacer" />
        <button class="btn btn-primary" onClick={() => openForm(null)}>＋ 新增訂單</button>
        <button class="btn btn-pdf" onClick={doBatchPdf}>📄 批次合併列印</button>
        <button class="btn btn-mail" onClick={doBatchEmail}>✉️ 批次寄 Email</button>
      </div>
      {loading.value
        ? <div class="empty">載入中…</div>
        : <>
            <div ref={listRef} onClick={onListClick} onChange={onListChange}>
              <Table columns={columns} rows={pagedRows.value}
                actions={(r: any) => `<button class="btn btn-sm" data-open="${r.id}">開啟</button><button class="btn btn-sm" data-preview="${r.id}">預覽</button>`} />
            </div>
            <Pagination page={page.value} pageSize={pageSize.value} total={filtered.value.length}
              onPageChange={(p: any) => (page.value = p)}
              onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
          </>}
      {showModal.value && (
        <OrderFormModal
          d={editing.value}
          ctx={formCtxRef.current}
          onClose={() => (showModal.value = false)}
          onSaved={() => { showModal.value = false; load(); }}
        />
      )}
      {showEmailModal.value && (
        <EmailModal count={emailIds.value.length} type="訂單"
          attachments={emailIds.value.map((id: any) => rows.value.find((r: any) => String(r.id) === String(id))?.order_no || '').filter(Boolean).map((no: any) => `order-${no}.pdf`)}
          onConfirm={doSendEmails}
          onClose={() => (showEmailModal.value = false)} />
      )}
      {showPreview.value && (
        <PdfPreviewModal title="客戶訂單預覽" pdfUrl={previewUrl.value}
          onClose={() => (showPreview.value = false)} />
      )}
    </>
  );
}
Orders.title = '訂單管理';

/* ====================== 訂單表單（宣告式 Modal，取代舊 buildOrderBody/bindOrderForm/saveOrder） ====================== */
function OrderFormModal({ d, ctx, onClose, onSaved }: any) {
  const meta = ctx?.meta || {};
  const isNew = !d || !d.id;
  const form = useSignal({
    order_no: d?.order_no || '',
    order_date: d?.order_date || todayStr(),
    customer_id: d?.customer_id || 0,
    customer_no: d?.customer_no || '',
    sales_id: d?.sales_id || 0,
    supplier_id: d?.supplier_id || 0,
    currency: d?.currency || 'TWD',
    exchange_rate: d?.exchange_rate || 1,
    status: d?.status || 'draft',
    payment_terms: d?.payment_terms || '月結60天',
    terms_days: d?.terms_days || 60,
    factory_eta: d?.factory_eta || '',
    customer_eta: d?.customer_eta || '',
    customer_po_no: d?.customer_po_no || '',
    note: d?.note || '',
  });
  const items = useSignal(d?.items?.length ? d.items.map((i: any) => ({ ...i })) : [defaultItem()]);
  const products = useSignal(null);
  const busy = useSignal(false);

  // 載入產品清單（供明細編輯器選用；跨開啟快取）
  useEffect(() => {
    if (productsCache) { products.value = productsCache; return; }
    api.get('/products').then((p: any) => { productsCache = p; products.value = p; }).catch(() => {});
  }, []);

  const set = (k: any, v: any) => (form.value = { ...form.value, [k]: v });

  const applyRate = async (cur: any) => {
    if (!cur || cur === (meta.base || 'TWD')) { set('exchange_rate', 1); return; }
    try {
      const rates = await api.get('/params/rates?currency=' + cur);
      const today = new Date().toISOString().slice(0, 10);
      const hit = rates.find((r: any) => r.effective_date <= today);
      set('exchange_rate', hit ? hit.rate : ((meta.defaultRates || {})[cur] || 1));
    } catch { set('exchange_rate', (meta.defaultRates || {})[cur] || 1); }
  };

  // 客戶變更：帶入客戶的幣別/交易條件（僅新增時），並更新匯率
  const onCustomerChange = async (id: any) => {
    if (!id) return;
    set('customer_id', id);
    const c = (ctx?.customers || []).find((x: any) => String(x.id) === String(id));
    if (!c) return;
    set('customer_no', c.customer_no || '');
    if (isNew) {
      const cur = c.currency || 'TWD';
      set('currency', cur);
      set('payment_terms', c.payment_terms || '月結60天');
      set('terms_days', c.terms_days || 60);
      await applyRate(cur);
    }
  };
  const onCurrencyChange = async (cur: any) => {
    set('currency', cur);
    await applyRate(cur);
  };

  const save = async () => {
    const f = form.value;
    if (!Number(f.customer_id)) return toast('請選擇客戶', 'warn');
    const clean = items.value.filter((i: any) => String(i.part_no || '').trim());
    if (!clean.length) return toast('至少需要一筆料號明細', 'warn');
    busy.value = true;
    try {
      const p = {
        order_no: f.order_no, order_date: f.order_date,
        customer_id: Number(f.customer_id),
        sales_id: Number(f.sales_id) || null,
        supplier_id: Number(f.supplier_id) || null,
        currency: f.currency, exchange_rate: Number(f.exchange_rate || 0),
        status: f.status, payment_terms: f.payment_terms, terms_days: Number(f.terms_days || 0),
        factory_eta: f.factory_eta, customer_eta: f.customer_eta, customer_po_no: f.customer_po_no,
        note: f.note, items: clean,
      };
      if (isNew) await api.post('/orders', p);
      else await api.put('/orders/' + d.id, p);
      toast(isNew ? '訂單已建立' : '訂單已更新', 'ok');
      onSaved?.();
    } catch (e) { toast(e.message, 'err'); }
    finally { busy.value = false; }
  };

  const downloadPdf = () => {
    if (d?.id) api.downloadPdf(`/pdf/orders/${d.id}`, `訂單確認單_${d.order_no}.pdf`);
  };

  const curOpts = (meta.currencies || []).map((c: any) => [c, c]);
  const custOpts = [[0, '（請選擇）']].concat((ctx?.customers || []).map((c: any) => [c.id, c.name]));
  const salesOpts = [[0, '（未指定）']].concat((ctx?.users || []).map((u: any) => [u.id, `${u.emp_id} ${u.name}`]));
  const supOpts = [[0, '（未指定）']].concat((ctx?.suppliers || []).map((s: any) => [s.id, s.name]));

  return (
    <Modal
      title={isNew ? '新增訂單' : `訂單 ${d.order_no || ''}`}
      wide
      extraButtons={!isNew
        ? <button class="btn btn-pdf" type="button" onClick={downloadPdf}>📄 下載確認單</button>
        : null}
      onSave={save}
      saveText={isNew ? '建立訂單' : '儲存'}
      onClose={onClose}
    >
      <div class="form-grid">
        <div>
          <label class="f">訂單編號（留空自動產生）</label>
          <input value={form.value.order_no} onInput={(e: any) => set('order_no', e.currentTarget.value)} style="width:100%" />
        </div>
        <div>
          <label class="f">訂單日期 *</label>
          <input type="date" value={form.value.order_date} onInput={(e: any) => set('order_date', e.currentTarget.value)} style="width:100%" />
        </div>
        <div>
          <label class="f">客戶編號</label>
          <input value={form.value.customer_no || ''} placeholder="輸入編號自動帶入客戶"
            onInput={(e: any) => {
              const v = e.currentTarget.value;
              set('customer_no', v);
              const c = (ctx?.customers || []).find((x: any) => String(x.customer_no || '') === String(v).trim());
              if (c) onCustomerChange(c.id);
            }} style="width:100%" />
        </div>
        <div>
          <label class="f">客戶 *</label>
          <select value={form.value.customer_id} onChange={(e: any) => onCustomerChange(e.currentTarget.value)} style="width:100%">
            {custOpts.map((o: any) => <option value={o[0]}>{esc(o[1])}</option>)}
          </select>
        </div>
        <div>
          <label class="f">業務</label>
          <select value={form.value.sales_id} onChange={(e: any) => set('sales_id', e.currentTarget.value)} style="width:100%">
            {salesOpts.map((o: any) => <option value={o[0]}>{esc(o[1])}</option>)}
          </select>
        </div>
        <div>
          <label class="f">供應商／工廠</label>
          <select value={form.value.supplier_id} onChange={(e: any) => set('supplier_id', e.currentTarget.value)} style="width:100%">
            {supOpts.map((o: any) => <option value={o[0]}>{esc(o[1])}</option>)}
          </select>
        </div>
        <div>
          <label class="f">幣別</label>
          <select value={form.value.currency} onChange={(e: any) => onCurrencyChange(e.currentTarget.value)} style="width:100%">
            {curOpts.map((c: any) => <option value={c[0]}>{c[0]}</option>)}
          </select>
        </div>
        <div>
          <label class="f">匯率（1 外幣 = ? 本位幣）</label>
          <input type="number" step={0.000001} value={form.value.exchange_rate}
            onInput={(e: any) => set('exchange_rate', e.currentTarget.value)} style="width:100%" />
        </div>
        <div>
          <label class="f">狀態</label>
          <select value={form.value.status} onChange={(e: any) => set('status', e.currentTarget.value)} style="width:100%">
            {Object.entries(STATUS).map(([v, t]: any) => <option value={v}>{t}</option>)}
          </select>
        </div>
        <div>
          <label class="f">交易條件</label>
          <input value={form.value.payment_terms} onInput={(e: any) => set('payment_terms', e.currentTarget.value)} style="width:100%" />
        </div>
        <div>
          <label class="f">月結天數</label>
          <input type="number" value={form.value.terms_days} onInput={(e: any) => set('terms_days', e.currentTarget.value)} style="width:100%" />
        </div>
        <div>
          <label class="f">工廠交期</label>
          <input type="date" value={form.value.factory_eta} onInput={(e: any) => set('factory_eta', e.currentTarget.value)} style="width:100%" />
        </div>
        <div>
          <label class="f">客戶交期</label>
          <input type="date" value={form.value.customer_eta} onInput={(e: any) => set('customer_eta', e.currentTarget.value)} style="width:100%" />
        </div>
        <div>
          <label class="f">客戶 PO 單號</label>
          <input type="text" value={form.value.customer_po_no} onInput={(e: any) => set('customer_po_no', e.currentTarget.value)} style="width:100%" placeholder="客戶來單編號" />
        </div>
        <div style="grid-column:1/-1">
          <label class="f">備註</label>
          <textarea value={form.value.note} onInput={(e: any) => set('note', e.currentTarget.value)} rows={2} style="width:100%" />
        </div>
      </div>
      <div class="calc-note">
        💡 計算引擎：應收貨款＝數量×單價；稅額＝應收×稅率；應收總額＝應收＋稅（原幣）；
        本位幣＝應收總額×匯率；成本總額＝台幣單價成本×數量＋其他費用；
        運費＝大陸＋台灣；<b>利潤＝本位幣應收總額−成本總額−運費</b>；毛利%＝利潤÷本位幣應收總額。
      </div>
      <OrderItemsEditor
        items={items.value}
        products={products.value}
        rate={Number(form.value.exchange_rate || 1)}
        currency={form.value.currency || 'TWD'}
        customerId={Number(form.value.customer_id || 0)}
        onChange={(v: any) => (items.value = v)}
      />
      {busy.value && <div style="font-size:12px;color:#6b7280;margin-top:6px">儲存中…</div>}
    </Modal>
  );
}
