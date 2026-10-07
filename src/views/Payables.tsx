// 應付帳款（供應鏈 / Preact）
import { useSignal, useComputed } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { user } from '../store.ts';
import { toast } from '../store.ts';
import Table from '../ui/Table.tsx';
import Pagination from '../ui/Pagination.tsx';
import Modal, { confirmDialog } from '../ui/Modal.tsx';
import { esc, num, date, money } from '../ui/format.ts';

const canManage = () => ['admin', 'manager'].includes(user.value?.role);
const STATUS: any = { pending: '未付', partial: '部分付款', paid: '已付' };

export default function Payables() {
  const rows = useSignal([]);
  const kw = useSignal('');
  const supplier = useSignal('');
  const status = useSignal('');
  const loading = useSignal(true);
  const showModal = useSignal(false);
  const editing = useSignal(null);
  const suppliersRef = useSignal([]);
  const page = useSignal(1);
  const pageSize = useSignal(20);
  const paymentFor = useSignal(null as any);
  const paymentListFor = useSignal(null as any);
  const paymentsList = useSignal([] as any[]);
  const closeMonth = useSignal(new Date().toISOString().slice(0, 7));

  const load = async () => {
    loading.value = true;
    try {
      const [list, sups] = await Promise.all([api.get('/payables'), api.get('/suppliers')]);
      rows.value = list; suppliersRef.value = sups;
    } catch (e) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };
  useEffect(() => { load(); }, []);

  const filtered = useComputed(() => {
    const k = kw.value.trim().toLowerCase(), s = supplier.value, st = status.value;
    if (!k && !s && !st) return rows.value;
    return rows.value.filter((r: any) =>
      (!k || [r.payable_no, r.invoice_no, r.supplier_name, r.note].filter(Boolean).some((v: any) => String(v).toLowerCase().includes(k))) &&
      (!s || String(r.supplier_id) === s) &&
      (!st || r.status === st));
  });

  const pagedRows = useComputed(() => {
    const start = (page.value - 1) * pageSize.value;
    return filtered.value.slice(start, start + pageSize.value);
  });
  const resetPage = () => { page.value = 1; };

  // 上方卡片：總未付／本月應付／已逾期／本月已付
  const cards = useComputed(() => {
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let totalUnpaid = 0, monthDue = 0, overdue = 0, monthPaid = 0;
    for (const r of rows.value) {
      const bal = Number(r.amount) - Number(r.paid_amount || 0);
      if (r.status !== 'paid' && bal > 0) {
        totalUnpaid += bal;
        if (String(r.due_date || '').startsWith(thisMonth)) monthDue += bal;
        if (String(r.due_date || '') < today) overdue += bal;
      }
      if (String(r.paid_date || '').startsWith(thisMonth)) monthPaid += Number(r.paid_amount || 0);
    }
    return { totalUnpaid, monthDue, overdue, monthPaid };
  });

  const del = async (cur: any) => {
    if (await confirmDialog(`確定刪除應付帳款「${cur.payable_no}」？`)) {
      try { await api.del('/payables/' + cur.id); toast('應付帳款已刪除', 'ok'); load(); }
      catch (e) { toast(e.message, 'err'); }
    }
  };

  const closePeriod = async () => {
    try {
      const preview: any = await api.get(`/payables/periods/${closeMonth.value}/preview`);
      if (preview.status === 'closed') {
        const reason = window.prompt(`應付期間 ${closeMonth.value} 已關帳。輸入反關帳原因：`);
        if (!reason?.trim()) return;
        await api.post(`/payables/periods/${closeMonth.value}/reopen`, { reason: reason.trim() });
        toast('已反關帳；系統已記錄原因', 'ok'); return;
      }
      if (!await confirmDialog(`關閉應付期間 ${closeMonth.value}？共 ${preview.payable_count} 筆、應付 ${money(preview.amount)}、付款 ${money(preview.paid)}。關帳後該期間不可修改。`)) return;
      await api.post(`/payables/periods/${closeMonth.value}/close`, {}); toast('應付期間已關帳', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  const columns = [
    { key: 'payable_no', label: '應付單號', render: (r: any) => `<b>${esc(r.payable_no)}</b>` },
    { key: 'supplier_name', label: '供應商' },
    { key: 'invoice_no', label: '發票號碼' },
    { key: 'amount', label: '應付金額', num: true, render: (r: any) => num(r.amount) },
    { key: 'paid_amount', label: '已付金額', num: true, render: (r: any) => num(r.paid_amount) },
    { key: 'due_date', label: '到期日', render: (r: any) => date(r.due_date) },
    { key: 'paid_date', label: '付款日', render: (r: any) => date(r.paid_date) },
    { key: 'status', label: '狀態', render: (r: any) => STATUS[r.status] || r.status },
    { key: 'note', label: '備註' },
  ];

  return (
    <>
      {/* 上方彙總卡片 */}
      <div class="ap-cards">
        <div class="ap-card ap-card-purple">
          <div class="ap-card-label">總未付貨款</div>
          <div class="ap-card-value">{money(cards.value.totalUnpaid)}</div>
          <div class="ap-card-sub">所有未付款應付帳款</div>
        </div>
        <div class="ap-card ap-card-blue">
          <div class="ap-card-label">本月應付貨款</div>
          <div class="ap-card-value">{money(cards.value.monthDue)}</div>
          <div class="ap-card-sub">本月到期未付款</div>
        </div>
        <div class={`ap-card ap-card-red ${cards.value.overdue > 0 ? 'ap-pulse' : ''}`}>
          <div class="ap-card-label">已逾期未付</div>
          <div class="ap-card-value">{money(cards.value.overdue)}</div>
          <div class="ap-card-sub">{cards.value.overdue > 0 ? '⚠ 需儘速處理' : '無逾期'}</div>
        </div>
        <div class="ap-card ap-card-green">
          <div class="ap-card-label">本月已付</div>
          <div class="ap-card-value">{money(cards.value.monthPaid)}</div>
          <div class="ap-card-sub">本月已付款金額</div>
        </div>
      </div>

      <div class="toolbar">
        <div class="fld"><label>關鍵字</label><input value={kw.value} onInput={(e: any) => { kw.value = e.currentTarget.value; resetPage(); }} placeholder="應付單號／發票／供應商" /></div>
        <div class="fld"><label>供應商</label><select value={supplier.value} onChange={(e: any) => { supplier.value = e.currentTarget.value; resetPage(); }}>
          <option value="">全部</option>{suppliersRef.value.map((s: any) => <option value={s.id}>{esc(s.name)}</option>)}</select></div>
        <div class="fld"><label>狀態</label><select value={status.value} onChange={(e: any) => { status.value = e.currentTarget.value; resetPage(); }}>
          <option value="">全部</option>{Object.entries(STATUS).map(([v, t]: any) => <option value={v}>{t}</option>)}</select></div>
        <div class="spacer" />
        <div class="fld"><label>應付期間</label><input type="month" value={closeMonth.value} onInput={(e:any)=>(closeMonth.value=e.currentTarget.value)} /></div>
        {canManage() && <button class="btn" onClick={closePeriod}>預覽／關帳</button>}
        <button class="btn btn-primary" onClick={() => { editing.value = null; showModal.value = true; }}>＋ 新增應付帳款</button>
      </div>
      {loading.value
        ? <div class="empty">載入中…</div>
        : <>
            <Table columns={columns} rows={pagedRows.value} actions={(r: any) => (
              <div style="display:flex;gap:6px;white-space:nowrap">
                <button class="btn btn-sm" onClick={() => { editing.value = r; showModal.value = true; }}>編輯／付款</button>
                {r.status !== 'paid' && <button class="btn btn-sm" onClick={() => (paymentFor.value = r)}>新增付款</button>}
                <button class="btn btn-sm" onClick={async()=>{try{paymentsList.value=await api.get(`/payables/${r.id}/payments`);paymentListFor.value=r;}catch(e){toast(e.message,'err');}}}>付款紀錄</button>
                {canManage() && <button class="btn btn-sm btn-danger" onClick={() => del(r)}>刪除</button>}
              </div>
            )} />
            <Pagination page={page.value} pageSize={pageSize.value} total={filtered.value.length}
              onPageChange={(p: any) => (page.value = p)}
              onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
          </>}
      {showModal.value && (
        <PayableFormModal d={editing.value} suppliers={suppliersRef.value}
          onClose={() => (showModal.value = false)}
          onSaved={() => { showModal.value = false; load(); }} />
      )}
      {paymentFor.value && <PaymentModal payable={paymentFor.value} onClose={() => (paymentFor.value = null)} onSaved={() => { paymentFor.value = null; load(); }} />}
      {paymentListFor.value && <PaymentHistory payable={paymentListFor.value} rows={paymentsList.value} onClose={()=>{paymentListFor.value=null;}} />}
    </>
  );
}
Payables.title = '應付帳款';

function PayableFormModal({ d, suppliers, onClose, onSaved }: any) {
  const isNew = !d || !d.id;
  const form = useSignal({
    payable_no: d?.payable_no || '',
    supplier_id: d?.supplier_id || 0,
    invoice_no: d?.invoice_no || '',
    amount: d?.amount || 0,
    due_date: d?.due_date || '',
    invoice_date: d?.invoice_date || '',
    billing_month: d?.billing_month || '',
    payable_month: d?.payable_month || '',
    paid_amount: d?.paid_amount || 0,
    paid_date: d?.paid_date || '',
    status: d?.status || 'pending',
    note: d?.note || '',
    currency: d?.currency || 'TWD',
    exchange_rate: d?.exchange_rate || 1,
  });
  const busy = useSignal(false);
  const set = (k: any, v: any) => (form.value = { ...form.value, [k]: v });
  const supOpts = [[0, '（請選擇）']].concat((suppliers || []).map((s: any) => [s.id, s.name]));

  const save = async () => {
    const f = form.value;
    if (!Number(f.supplier_id)) return toast('請選擇供應商', 'warn');
    if (!Number(f.amount)) return toast('請填寫應付金額', 'warn');
    busy.value = true;
    try {
      const p = {
        payable_no: f.payable_no, supplier_id: Number(f.supplier_id), invoice_no: f.invoice_no,
        amount: Number(f.amount || 0), due_date: f.due_date,
        invoice_date: f.invoice_date, billing_month: f.billing_month, payable_month: f.payable_month,
        currency: f.currency, exchange_rate: Number(f.exchange_rate || 1), note: f.note,
      };
      if (isNew) await api.post('/payables', p);
      else await api.put('/payables/' + d.id, p);
      toast(isNew ? '應付帳款已建立' : '應付帳款已更新', 'ok');
      onSaved?.();
    } catch (e) { toast(e.message, 'err'); }
    finally { busy.value = false; }
  };

  return (
    <Modal title={isNew ? '新增應付帳款' : `編輯應付帳款 — ${d.payable_no}`} onSave={save} onClose={onClose}>
      <div class="form-grid">
        <div><label class="f">應付單號（留空自動產生）</label><input value={form.value.payable_no} onInput={(e: any) => set('payable_no', e.currentTarget.value)} style="width:100%" /></div>
        <div>
          <label class="f">供應商 *</label>
          <select value={form.value.supplier_id} onChange={(e: any) => set('supplier_id', e.currentTarget.value)} style="width:100%">
            {supOpts.map((o: any) => <option value={o[0]}>{esc(o[1])}</option>)}
          </select>
        </div>
        <div><label class="f">發票號碼</label><input value={form.value.invoice_no} onInput={(e: any) => set('invoice_no', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">應付金額 *</label><input type="number" value={form.value.amount} onInput={(e: any) => set('amount', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">幣別</label><input value={form.value.currency} onInput={(e:any)=>set('currency',e.currentTarget.value.toUpperCase())} style="width:100%" /></div>
        <div><label class="f">應付匯率</label><input type="number" min="0.000001" step="0.000001" value={form.value.exchange_rate} onInput={(e:any)=>set('exchange_rate',e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">供應商開票日</label><input type="date" value={form.value.invoice_date} onInput={(e: any) => set('invoice_date', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">結帳月份</label><input type="month" value={form.value.billing_month} onInput={(e: any) => set('billing_month', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">應付月份</label><input type="month" value={form.value.payable_month} onInput={(e: any) => set('payable_month', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">到期日</label><input type="date" value={form.value.due_date} onInput={(e: any) => set('due_date', e.currentTarget.value)} style="width:100%" /></div>
        {!isNew && <div><label class="f">已付金額（付款流水計算）</label><input value={num(d?.paid_amount)} disabled style="width:100%" /></div>}
        <div style="grid-column:1/-1"><label class="f">備註</label><textarea value={form.value.note} onInput={(e: any) => set('note', e.currentTarget.value)} rows={2} style="width:100%" /></div>
      </div>
      <div class="calc-note">已付金額 ≥ 應付金額時，狀態自動判定為「已付」；部分付款為「部分付款」。</div>
      {busy.value && <div style="font-size:12px;color:#6b7280;margin-top:6px">儲存中…</div>}
    </Modal>
  );
}

function PaymentModal({ payable, onClose, onSaved }: any) {
  const form = useSignal({ amount: '', payment_date: new Date().toISOString().slice(0,10), currency: payable.currency || 'TWD', exchange_rate: payable.exchange_rate || 1, method: '', reference_no: '', note: '', idempotency_key: globalThis.crypto?.randomUUID?.() || `pay-${Date.now()}-${Math.random().toString(36).slice(2)}` });
  const busy = useSignal(false);
  const set = (k:string,v:any) => (form.value={...form.value,[k]:v});
  const save = async () => {
    if (!(Number(form.value.amount)>0)) return toast('付款金額需大於 0','warn');
    busy.value=true;
    try { await api.post(`/payables/${payable.id}/payments`,form.value); toast('付款已登錄','ok'); onSaved?.(); }
    catch(e) { toast(e.message,'err'); } finally { busy.value=false; }
  };
  return <Modal title={`新增付款 — ${payable.payable_no}`} onSave={save} onClose={onClose}>
    <div class="calc-note">未付餘額：{money(Number(payable.amount)-Number(payable.paid_amount||0))}。付款資料逐筆留存，累計金額由系統計算。</div>
    <div class="form-grid">
      <div><label class="f">付款金額 *</label><input type="number" min="0.01" step="0.01" value={form.value.amount} onInput={(e:any)=>set('amount',e.currentTarget.value)} /></div>
      <div><label class="f">付款日期 *</label><input type="date" value={form.value.payment_date} onInput={(e:any)=>set('payment_date',e.currentTarget.value)} /></div>
      <div><label class="f">幣別</label><input value={form.value.currency} disabled /></div>
      <div><label class="f">付款匯率</label><input type="number" min="0.000001" step="0.000001" value={form.value.exchange_rate} onInput={(e:any)=>set('exchange_rate',e.currentTarget.value)} /></div>
      <div><label class="f">付款方式</label><input value={form.value.method} onInput={(e:any)=>set('method',e.currentTarget.value)} /></div>
      <div><label class="f">銀行參考號</label><input value={form.value.reference_no} onInput={(e:any)=>set('reference_no',e.currentTarget.value)} /></div>
      <div style="grid-column:1/-1"><label class="f">備註</label><textarea value={form.value.note} onInput={(e:any)=>set('note',e.currentTarget.value)} /></div>
    </div>{busy.value && <div>儲存中…</div>}
  </Modal>;
}

function PaymentHistory({ payable, rows, onClose }: any) {
  return <Modal title={`付款紀錄 — ${payable.payable_no}`} onClose={onClose} hideSave>
    {!rows.length ? <div class="empty">尚無付款紀錄</div> : <div style="overflow:auto"><table class="table"><thead><tr><th>付款日</th><th>金額</th><th>幣別</th><th>匯率</th><th>本位幣</th><th>方式／參考號</th><th>備註</th></tr></thead><tbody>{rows.map((r:any)=><tr><td>{date(r.payment_date)}</td><td>{num(r.amount)}</td><td>{esc(r.currency)}</td><td>{num(r.exchange_rate)}</td><td>{num(r.amount_base)}</td><td>{esc([r.method,r.reference_no].filter(Boolean).join(' / '))}</td><td>{esc(r.note)}</td></tr>)}</tbody></table></div>}
  </Modal>;
}
