// 應收帳款：月結推導 / 收款沖帳 / 帳齡 / 對帳單（Level B / Preact）
import { useSignal, useComputed } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import api from '../api.ts';
import { user } from '../store.ts';
import { toast } from '../store.ts';
import Table from '../ui/Table.tsx';
import Pagination from '../ui/Pagination.tsx';
import Modal from '../ui/Modal.tsx';
import { esc, tag, money, date } from '../ui/format.ts';

const STATUS: any = { pending: '未收', partial: '部分收款', received: '已收' };
const STATUS_TAG: any = { pending: 'red', partial: 'yellow', received: 'green' };
const canWrite = () => ['admin', 'manager', 'accounting'].includes(user.value?.role);

export default function Receivables() {
  const rows = useSignal([]);
  const kw = useSignal(''); const cust = useSignal(''); const st = useSignal(''); const mo = useSignal('');
  const loading = useSignal(true);
  const aging = useSignal(null);
  const customersRef = useRef([]);
  const listRef = useRef(null);
  const pendingRef = useRef(null);
  const page = useSignal(1);
  const pageSize = useSignal(20);

  const showGen = useSignal(false);
  const showBatch = useSignal(false);
  const showEdit = useSignal(false); const editing = useSignal(null);
  const showRec = useSignal(false); const recTarget = useSignal(null);
  const showStmt = useSignal(false); const stmtData = useSignal(null); const stmtCust = useSignal(null);

  const load = async () => {
    loading.value = true;
    try {
      const [list, customers, ag] = await Promise.all([api.get('/receivables'), api.get('/customers'), api.get('/receivables/aging')]);
      rows.value = list; customersRef.current = customers; aging.value = ag;
    } catch (e) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };
  useEffect(() => {
    try { pendingRef.current = JSON.parse(localStorage.getItem('mj.pendingBatch') || 'null'); } catch { pendingRef.current = null; }
    try { localStorage.removeItem('mj.pendingBatch'); } catch { /* ignore */ }
    load();
  }, []);

  const filtered = useComputed(() => {
    const k = kw.value.trim().toLowerCase(), c = cust.value, s = st.value, m = mo.value;
    if (!k && !c && !s && !m) return rows.value;
    return rows.value.filter((r: any) =>
      (!k || [r.receivable_no, r.order_no, r.customer_name].filter(Boolean).some((v: any) => String(v).toLowerCase().includes(k))) &&
      (!c || String(r.customer_id) === c) && (!s || r.status === s) && (!m || r.billing_month === m));
  });

  const pagedRows = useComputed(() => {
    const start = (page.value - 1) * pageSize.value;
    return filtered.value.slice(start, start + pageSize.value);
  });

  const resetPage = () => { page.value = 1; };

  // 上方彙總卡片：總未收／本月應收／已逾期未收／本月已收
  const cards = useComputed(() => {
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let totalUnpaid = 0, monthDue = 0, overdue = 0, monthReceived = 0;
    for (const r of rows.value) {
      const bal = Number(r.outstanding ?? (Number(r.amount_base) - Number(r.received_amount || 0)));
      if (r.status !== 'received' && bal > 0) {
        totalUnpaid += bal;
        if (String(r.due_date || '').startsWith(thisMonth)) monthDue += bal;
        if (String(r.due_date || '') < today) overdue += bal;
      }
      if (String(r.payment_date || '').startsWith(thisMonth)) monthReceived += Number(r.received_amount || 0);
    }
    return { totalUnpaid, monthDue, overdue, monthReceived };
  });

  useEffect(() => {
    if (!pendingRef.current || !canWrite()) { pendingRef.current = null; return; }
    const pend = pendingRef.current; pendingRef.current = null;
    if (pend.act === 'batch-generate') setTimeout(() => (showBatch.value = true), 200);
  }, [rows.value]);

  const summaryPdf = () => {
    const month = mo.value || new Date().toISOString().slice(0, 7);
    api.downloadPdf(`/pdf/receivables/summary?month=${month}`, `應收彙總表_${month}.pdf`);
  };

  const openEdit = (r: any) => { editing.value = r; showEdit.value = true; };
  const openRec = (r: any) => { recTarget.value = r; showRec.value = true; };
  const _openStmt = async (r: any) => {
    try {
      const s = await api.get('/receivables/statement?customer_id=' + r.customer_id);
      stmtData.value = s; stmtCust.value = (customersRef.current || []).find((c: any) => c.id === r.customer_id) || null;
      showStmt.value = true;
    } catch (err) { toast(err.message, 'err'); }
  };

  // 列表動作（宣告式：直接綁 onClick，取代舊 dataset 事件委派）
  const actions = (r: any) => (canWrite()
    ? (
      <div style="display:flex;gap:6px;white-space:nowrap">
        <button class="btn btn-sm" onClick={() => openEdit(r)}>編輯</button>
        {r.status !== 'received' && <button class="btn btn-sm btn-primary" onClick={() => openRec(r)}>收款</button>}
      </div>
    )
    : <span></span>);

  const ag = aging.value;
  const buckets = (ag && ag.buckets) || {};

  return (
    <>
      {/* 上方彙總卡片 */}
      <div class="ar-cards">
        <div class="ar-card ar-card-amber">
          <div class="ar-card-label">總未收貨款</div>
          <div class="ar-card-value">{money(cards.value.totalUnpaid)}</div>
          <div class="ar-card-sub">所有未收款應收帳款</div>
        </div>
        <div class="ar-card ar-card-blue">
          <div class="ar-card-label">本月應收貨款</div>
          <div class="ar-card-value">{money(cards.value.monthDue)}</div>
          <div class="ar-card-sub">本月到期未收款</div>
        </div>
        <div class={'ar-card ar-card-red ' + (cards.value.overdue > 0 ? 'ar-pulse' : '')}>
          <div class="ar-card-label">已逾期未收</div>
          <div class="ar-card-value">{money(cards.value.overdue)}</div>
          <div class="ar-card-sub">{cards.value.overdue > 0 ? '⚠ 需儘速催收' : '無逾期'}</div>
        </div>
        <div class="ar-card ar-card-green">
          <div class="ar-card-label">本月已收</div>
          <div class="ar-card-value">{money(cards.value.monthReceived)}</div>
          <div class="ar-card-sub">本月已收款金額</div>
        </div>
      </div>

      {ag && (
        <div class="card"><h3>帳齡分析（未收金額）</h3>
          <div class="grid grid-3">
            {Object.entries(buckets).map(([k, v]: any[]) =>
              <div class={`kpi ${k === '未到期' || k === '已結清' ? '' : (v > 0 ? 'bad' : '')}`}>
                <div class="k-label">{esc(k)}</div><div class="k-value">{money(v)}</div></div>)}
          </div>
          <div style="margin-top:10px;font-size:13px;color:#5A6270">未收總額：<b>{money(ag.total_outstanding)}</b> ｜ 基準日：{date(ag.as_of)}</div>
        </div>
      )}

      <div class="toolbar">
        <div class="fld"><label>關鍵字</label><input value={kw.value} onInput={(e: any) => { kw.value = e.currentTarget.value; resetPage(); }} placeholder="應收單號／訂單／客戶" /></div>
        <div class="fld"><label>客戶</label><select value={cust.value} onChange={(e: any) => { cust.value = e.currentTarget.value; resetPage(); }}>
          <option value="">全部</option>{customersRef.current.map((c: any) => <option value={c.id}>{esc(c.name)}</option>)}</select></div>
        <div class="fld"><label>狀態</label><select value={st.value} onChange={(e: any) => { st.value = e.currentTarget.value; resetPage(); }}>
          <option value="">全部</option>{Object.entries(STATUS).map(([v, t]: any) => <option value={v}>{t}</option>)}</select></div>
        <div class="fld"><label>結帳月份</label><input type="month" value={mo.value} onInput={(e: any) => { mo.value = e.currentTarget.value; resetPage(); }} /></div>
        <div class="spacer" />
        <button class="btn btn-pdf" onClick={summaryPdf} title="下載當月彙總表 PDF">📄 應收彙總表</button>
        {canWrite() && <button class="btn btn-primary" onClick={() => (showGen.value = true)}>產生應收（依訂單）</button>}
      </div>

      {loading.value
        ? <div class="empty">載入中…</div>
        : <>
            <div ref={listRef}>
              <Table columns={columns} rows={pagedRows.value} actions={actions} />
            </div>
            <Pagination page={page.value} pageSize={pageSize.value} total={filtered.value.length}
              onPageChange={(p: any) => (page.value = p)}
              onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
          </>}

      {/* 產生應收 */}
      {showGen.value && <GenerateModal onClose={() => (showGen.value = false)} api={api} toast={toast} load={load} />}

      {/* 批次結帳 */}
      {showBatch.value && <BatchModal onClose={() => (showBatch.value = false)} api={api} toast={toast} load={load} money={money} />}

      {/* 編輯應收 */}
      {showEdit.value && editing.value && (
        <EditModal r={editing.value} api={api} toast={toast} load={load} onClose={() => (showEdit.value = false)} />
      )}

      {/* 收款登錄 */}
      {showRec.value && recTarget.value && (
        <ReceiveModal r={recTarget.value} api={api} toast={toast} load={load} onClose={() => (showRec.value = false)} money={money} />
      )}

      {/* 對帳單 */}
      {showStmt.value && stmtData.value && (
        <StatementModal data={stmtData.value} cust={stmtCust.value} api={api} onClose={() => (showStmt.value = false)} money={money} date={date} />
      )}
    </>
  );
}
Receivables.title = '應收帳款';

const columns = [
  { key: 'receivable_no', label: '應收單號', render: (r: any) => `<b>${esc(r.receivable_no)}</b>` },
  { key: 'order_no', label: '訂單編號' },
  // A2：顯示所屬出貨批號（分批請款時每筆 AR 對應一筆 shipment；整單 AR 顯示「整單」）
  { key: 'shipment_no', label: '出貨批號', render: (r: any) => r.shipment_no ? `<code>${esc(r.shipment_no)}</code>` : '<span style="color:#aaa">整單</span>' },
  { key: 'customer_name', label: '客戶' },
  { key: 'billing_month', label: '結帳月份' },
  { key: 'receivable_month', label: '應收月份' },
  { key: 'due_date', label: '兌現日', render: (r: any) => date(r.due_date) },
  { key: 'amount_base', label: '應收(本位幣)', num: true, render: (r: any) => money(r.amount_base) },
  { key: 'received_amount', label: '已收', num: true, render: (r: any) => money(r.received_amount) },
  { key: 'outstanding', label: '未收', num: true, render: (r: any) => `<b>${money(r.outstanding)}</b>` },
  { key: 'aging', label: '帳齡', render: (r: any) => tag(r.aging, r.aging === '已結清' ? 'green' : (r.aging === '未到期' ? 'blue' : 'red')) },
  { key: 'status', label: '狀態', render: (r: any) => tag(STATUS[r.status] || r.status, STATUS_TAG[r.status] || 'gray') },
  { key: 'confirmed', label: '確認付款', render: (r: any) => (r.confirmed ? '✔' : '') },
];
function EditModal({ r, api, toast, load, onClose }: any) {
  const form = useSignal({
    billing_month: r.billing_month || '',
    receivable_month: r.receivable_month || '',
    due_date: r.due_date || '',
    payment_date: r.payment_date || '',
    amount_base: r.amount_base || 0,
    received_amount: r.received_amount || 0,
    received_date: r.received_date || '',
    confirmed: r.confirmed ? 1 : 0,
    bank_note: r.bank_note || '',
    note: r.note || '',
  });
  const busy = useSignal(false);
  const set = (k: any, v: any) => (form.value = { ...form.value, [k]: v });

  const save = async () => {
    busy.value = true;
    try {
      await api.put('/receivables/' + r.id, form.value);
      toast('應收紀錄已更新', 'ok');
      load();
    } catch (e) { toast(e.message, 'err'); }
    finally { busy.value = false; }
  };

  return (
    <Modal title={`編輯應收 — ${r.receivable_no}`} onSave={save} onClose={onClose}>
      <div class="form-grid">
        <div><label class="f">結帳月份</label><input value={form.value.billing_month} placeholder="YYYY-MM" onInput={(e: any) => set('billing_month', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">應收月份</label><input value={form.value.receivable_month} placeholder="YYYY-MM" onInput={(e: any) => set('receivable_month', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">兌現日</label><input type="date" value={form.value.due_date} onInput={(e: any) => set('due_date', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">付款日</label><input type="date" value={form.value.payment_date} onInput={(e: any) => set('payment_date', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">應收金額(本位幣)</label><input type="number" step={0.01} value={form.value.amount_base} onInput={(e: any) => set('amount_base', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">已收金額</label><input type="number" step={0.01} value={form.value.received_amount} onInput={(e: any) => set('received_amount', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">實收日</label><input type="date" value={form.value.received_date} onInput={(e: any) => set('received_date', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">確認付款</label>
          <select value={form.value.confirmed} onChange={(e: any) => set('confirmed', e.currentTarget.value)} style="width:100%">
            <option value={1}>是</option><option value={0}>否</option>
          </select>
        </div>
        <div><label class="f">銀行入帳備註</label><input value={form.value.bank_note} onInput={(e: any) => set('bank_note', e.currentTarget.value)} style="width:100%" /></div>
        <div style="grid-column:1/-1"><label class="f">備註</label><textarea value={form.value.note} onInput={(e: any) => set('note', e.currentTarget.value)} rows={2} style="width:100%" /></div>
      </div>
      {busy.value && <div style="font-size:12px;color:#6b7280;margin-top:6px">儲存中…</div>}
    </Modal>
  );
}

function ReceiveModal({ r, api, toast, load, onClose, money }: any) {
  const left = Number(r.outstanding || 0);
  const form = useSignal({
    amount: left,
    received_date: new Date().toISOString().slice(0, 10),
    bank_note: r.bank_note || '',
  });
  const busy = useSignal(false);
  const set = (k: any, v: any) => (form.value = { ...form.value, [k]: v });

  const save = async () => {
    if (Number(form.value.amount) <= 0) return toast('收款金額必須大於 0', 'warn');
    busy.value = true;
    try {
      const res = await api.post('/receivables/' + r.id + '/receive', form.value);
      toast(res.status === 'received' ? '已全額收款，訂單狀態更新為「已收款」' : '部分收款已登錄', 'ok');
      load();
    } catch (e) { toast(e.message, 'err'); }
    finally { busy.value = false; }
  };

  return (
    <Modal title={`收款登錄 — ${r.receivable_no}`} onSave={save} onClose={onClose}>
      <div class="form-grid">
        <div><label class="f">本次收款金額 *</label><input type="number" step={0.01} value={form.value.amount} onInput={(e: any) => set('amount', e.currentTarget.value)} style="width:100%" /></div>
        <div><label class="f">收款日期</label><input type="date" value={form.value.received_date} onInput={(e: any) => set('received_date', e.currentTarget.value)} style="width:100%" /></div>
        <div style="grid-column:1/-1"><label class="f">銀行入帳備註</label><input value={form.value.bank_note} onInput={(e: any) => set('bank_note', e.currentTarget.value)} style="width:100%" /></div>
      </div>
      <div class="calc-note">應收 {money(r.amount_base)} ｜ 已收 {money(r.received_amount)} ｜ 尚未收 <b>{money(left)}</b></div>
      {busy.value && <div style="font-size:12px;color:#6b7280;margin-top:6px">登錄中…</div>}
    </Modal>
  );
}

function GenerateModal({ onClose, api, toast, load }: any) {
  const ordersSig = useSignal([]);
  const orderId = useSignal<any>(0);
  useEffect(() => {
    api.get('/orders').then((o: any) => {
      const list = o.filter((x: any) => x.status !== 'cancelled').map((x: any) => [x.id, `${x.order_no} — ${x.customer_name || ''}（${x.payment_terms || ''}）`]);
      ordersSig.value = list;
      if (list.length) orderId.value = list[0][0];
    }).catch(() => {});
  }, []);

  const save = async () => {
    if (!Number(orderId.value)) return toast('請選擇訂單', 'warn');
    try {
      const r = await api.post('/receivables/generate', { order_id: Number(orderId.value) });
      toast(`應收 ${r.receivable_no} 已產生，兌現日 ${r.due_date}`, 'ok');
      load();
    } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <Modal title="產生應收帳款" saveText="產生應收" onSave={save} onClose={onClose}>
      <div class="form-grid">
        <div>
          <label class="f">選擇訂單 *</label>
          <select value={orderId.value} onChange={(e: any) => (orderId.value = e.currentTarget.value)} style="width:100%">
            {ordersSig.value.length === 0 && <option value={0}>載入中…</option>}
            {ordersSig.value.map((o: any) => <option value={o[0]} selected={Number(o[0]) === Number(orderId.value)}>{esc(o[1])}</option>)}
          </select>
        </div>
      </div>
      <div class="calc-note">系統會依訂單的「交易條件／月結天數」與「出貨日（無則用訂單日）」自動推導結帳月份、應收月份、兌現日與付款日。若該訂單已有應收紀錄，會以最新金額重算。</div>
    </Modal>
  );
}

/* ---------- 批次結帳結果（宣告式元件，參考 OrderItemsEditor 模式） ---------- */
function BatchResult({ result, dryRun, money }: any) {
  if (!result) return null;
  const items = result.items || [];
  const byMonth = result.by_month || {};
  return (
    <div style="margin-top:12px">
      <div class="grid grid-4" style="margin-bottom:8px">
        <div class="kpi"><div class="k-label">掃描</div><div class="k-value">{result.scanned}</div></div>
        <div class="kpi good"><div class="k-label">{dryRun ? '預計新增' : '已產生'}</div><div class="k-value">{result.generated}</div></div>
        <div class="kpi"><div class="k-label">略過（已存在）</div><div class="k-value">{result.skipped}</div></div>
        <div class="kpi bad"><div class="k-label">錯誤</div><div class="k-value">{result.errors}</div></div>
      </div>
      <div style="margin-bottom:8px;font-size:13px;color:#5A6270">總應收金額：<b>{money(result.total_amount_base)}</b></div>
      <div style="margin-bottom:8px">
        {Object.entries(byMonth).map(([k, v]: any) => (
          <span key={k} class="tag tag-blue" style="margin-right:6px">{k}：{v} 筆</span>
        ))}
      </div>
      <div style="max-height:280px;overflow:auto;border:1px solid #e3e6ee;border-radius:6px">
        <table class="tbl">
          <thead><tr><th>訂單</th><th>動作</th><th>說明</th></tr></thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colspan={3} style="text-align:center;color:#888">無資料</td></tr>
            ) : items.slice(0, 50).map((it: any, idx: any) => {
              const tg = it.action === 'create' ? 'green' : it.action === 'rebuild' ? 'yellow' : it.action === 'skip' ? 'gray' : 'red';
              return (
                <tr key={idx}>
                  <td>{it.order_no || ('#' + it.order_id)}</td>
                  <td><span class={`tag tag-${tg}`}>{it.action}</span></td>
                  <td>
                    {it.action === 'skip' && `（已有 ${it.receivable_no}）`}
                    {it.action === 'error' && `❌ ${it.error || ''}`}
                    {(it.action === 'create' || it.action === 'rebuild') && (
                      <>
                        {it.action === 'create' ? '新增' : '重建'} {it.receivable_no || ''}（{it.billing_month || ''}）
                        <b>{money(it.amount_base || 0)}</b>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {dryRun && (
        <div class="calc-note" style="margin-top:8px">⚠️ 此為預覽，尚未寫入資料庫。確認無誤後請按「執行批次結帳」。</div>
      )}
    </div>
  );
}

/* ---------- 批次結帳（宣告式，useSignal 管理狀態） ---------- */
function BatchModal({ onClose, api, toast, load, money }: any) {
  const now = new Date();
  const defFrom = `${now.getFullYear() - 1}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const defTo = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // 表單狀態（受控元件）
  const fromMonth = useSignal(defFrom);
  const toMonth = useSignal(defTo);
  const stShipped = useSignal(true);
  const stBilled = useSignal(true);
  const stPaid = useSignal(false);
  const force = useSignal(false);
  const mode = useSignal('per_order'); // A2：分批請款模式（per_order 預設相容／per_shipment 依出貨批）

  // 結果狀態
  const batchLoading = useSignal(false);
  const batchResult = useSignal(null);
  const batchError = useSignal(null);
  const isDryRun = useSignal(false);

  const runBatch = async (dryRun: any) => {
    const statuses = [];
    if (stShipped.value) statuses.push('shipped');
    if (stBilled.value) statuses.push('billed');
    if (stPaid.value) statuses.push('paid');
    if (!statuses.length) { toast('請至少勾選一個訂單狀態', 'warn'); return; }

    batchLoading.value = true;
    batchResult.value = null;
    batchError.value = null;
    isDryRun.value = dryRun;

    try {
      const r = await api.post('/receivables/batch-generate', {
        fromMonth: fromMonth.value,
        toMonth: toMonth.value,
        statuses,
        force: force.value,
        mode: mode.value, // A2：per_order（預設相容）或 per_shipment（依出貨批各自開立）
        dryRun,
      });
      batchResult.value = r;
      if (!dryRun) { toast(`批次結帳完成：${r.generated} 筆`, 'ok'); load(); }
    } catch (e) {
      batchError.value = e.message || String(e);
    } finally {
      batchLoading.value = false;
    }
  };

  return (
    <div class="modal-mask" onMouseDown={(e: any) => { if ((e.target as HTMLElement).classList.contains('modal-mask')) onClose(); }}>
      <div class="modal wide">
        <header>
          <span>⚡ 批次結帳（會計月結）</span>
          <button class="x" type="button" onClick={onClose}>&times;</button>
        </header>
        <div class="body">
          <div class="calc-note" style="margin-bottom:12px">
            掃描指定月份範圍內所有「已出貨」訂單，自動產生／重建應收帳款。<br />
            <b>預設掃描</b>：訂單狀態 = <code>shipped</code> / <code>billed</code>（依出貨日排序）。
          </div>
          <div class="form-grid">
            <div>
              <label class="f">起月（YYYY-MM）</label>
              <input type="month" value={fromMonth.value} onInput={(e: any) => (fromMonth.value = e.currentTarget.value)} style="width:100%" />
            </div>
            <div>
              <label class="f">迄月（YYYY-MM）</label>
              <input type="month" value={toMonth.value} onInput={(e: any) => (toMonth.value = e.currentTarget.value)} style="width:100%" />
            </div>
            <div>
              <label class="chk">
                <input type="checkbox" checked={stShipped.value} onChange={(e: any) => (stShipped.value = e.currentTarget.checked)} />
                含已出貨 (shipped)
              </label>
            </div>
            <div>
              <label class="chk">
                <input type="checkbox" checked={stBilled.value} onChange={(e: any) => (stBilled.value = e.currentTarget.checked)} />
                含已結帳 (billed)
              </label>
            </div>
            <div>
              <label class="chk">
                <input type="checkbox" checked={stPaid.value} onChange={(e: any) => (stPaid.value = e.currentTarget.checked)} />
                含已收款 (paid)
              </label>
            </div>
            <div>
              <label class="chk">
                <input type="checkbox" checked={force.value} onChange={(e: any) => (force.value = e.currentTarget.checked)} />
                強制重建已有應收（會計覆核場景：會覆蓋既有應收金額與日期）
              </label>
            </div>
            <div>
              <label class="f">產生模式（A2 分批請款）</label>
              <select value={mode.value} onChange={(e: any) => (mode.value = e.currentTarget.value)} style="width:100%">
                <option value="per_order">依訂單（每單一筆，預設相容）</option>
                <option value="per_shipment">依出貨批（每批一筆／分批請款）</option>
              </select>
            </div>
          </div>
          <div class="toolbar" style="margin-top:12px">
            <button class="btn" type="button" onClick={() => runBatch(true)} disabled={batchLoading.value}>
              🔍 預覽（dryRun）
            </button>
            <button class="btn btn-primary" type="button" onClick={() => runBatch(false)} disabled={batchLoading.value}>
              ⚡ 執行批次結帳
            </button>
          </div>
          {batchLoading.value && (
            <div class="calc-note" style="margin-top:12px">{isDryRun.value ? '預覽中…' : '執行中…'}</div>
          )}
          {batchError.value && (
            <div class="calc-note" style="margin-top:12px;color:#c0392b">❌ 執行失敗：{batchError.value}</div>
          )}
          {batchResult.value && !batchLoading.value && (
            <BatchResult result={batchResult.value} dryRun={isDryRun.value} money={money} />
          )}
        </div>
        <footer>
          <button class="btn" type="button" onClick={onClose}>關閉</button>
        </footer>
      </div>
    </div>
  );
}

function StatementModal({ data, cust, api, onClose, money, date }: any) {
  const s = data;
  const month = (s.items && s.items[0] && s.items[0].billing_month) || new Date().toISOString().slice(0, 7);
  const stmtCols = [
    { key: 'receivable_no', label: '應收單號' },
    { key: 'order_no', label: '訂單編號' },
    { key: 'billing_month', label: '結帳月份' },
    { key: 'due_date', label: '兌現日', render: (r: any) => date(r.due_date) },
    { key: 'amount_base', label: '應收', num: true, render: (r: any) => money(r.amount_base) },
    { key: 'received_amount', label: '已收', num: true, render: (r: any) => money(r.received_amount) },
    { key: 'outstanding', label: '未收', num: true, render: (r: any) => money(r.outstanding) },
    { key: 'aging', label: '帳齡' },
  ];
  const downloadPdf = () => api.downloadPdf(`/pdf/customers/${cust ? cust.id : ''}/statement?month=${month}`, `對帳單_${cust ? cust.customer_no : ''}_${month}.pdf`);
  return (
    <Modal title={`客戶對帳單 — ${cust ? cust.name : ''}`} wide
      extraButtons={<button class="btn btn-pdf" type="button" onClick={downloadPdf}>📄 下載 PDF</button>}
      onClose={onClose}>
      <div class="grid grid-4">
        <div class="kpi"><div class="k-label">筆數</div><div class="k-value">{s.summary.count}</div></div>
        <div class="kpi"><div class="k-label">應收總額</div><div class="k-value">{money(s.summary.amount)}</div></div>
        <div class="kpi good"><div class="k-label">已收</div><div class="k-value">{money(s.summary.received)}</div></div>
        <div class={`kpi ${s.summary.outstanding > 0 ? 'bad' : ''}`}><div class="k-label">未收</div><div class="k-value">{money(s.summary.outstanding)}</div></div>
      </div>
      <div style="margin-top:12px">
        <table class="tbl">
          <thead>
            <tr>{stmtCols.map((c: any) => <th key={c.key} class={c.num ? 'num' : ''}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {(s.items || []).length === 0 ? (
              <tr><td colspan={8} style="text-align:center;color:#888">無資料</td></tr>
            ) : (s.items || []).map((r: any, idx: any) => (
              <tr key={idx}>{stmtCols.map((c: any) => (
                <td key={c.key} class={c.num ? 'num' : ''}>
                  {c.render ? c.render(r) : (r[c.key] === null || r[c.key] === undefined ? '' : r[c.key])}
                </td>
              ))}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
