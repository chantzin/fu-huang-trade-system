// 報表與經營分析（客戶／業務／產品／月份別 + 交期追蹤 + 客戶貢獻度圖表 + Excel 匯出）（Level B / Preact）
import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';
import Table from '../ui/Table.tsx';
import Pagination from '../ui/Pagination.tsx';
import { money, pct, num, esc, date, tag } from '../ui/format.ts';

const DELIVERY_STATUS: any = { draft: '草稿', confirmed: '已確認', shipped: '已出貨', billed: '已結帳', paid: '已收款', closed: '結案', cancelled: '作廢' };

const TABS = [
  { key: 'customer', label: '客戶別', api: '/reports/by-customer', cols: [
    { key: 'customer_no', label: '客戶編號' }, { key: 'customer_name', label: '客戶名稱', render: (r: any) => `<b>${esc(r.customer_name || '（未指定）')}</b>` },
    { key: 'order_count', label: '訂單數', num: true }, { key: 'qty', label: '數量', num: true, render: (r: any) => num(r.qty) },
    { key: 'revenue', label: '營收(本位幣)', num: true, render: (r: any) => money(r.revenue) },
    { key: 'profit', label: '利潤', num: true, render: (r: any) => money(r.profit) },
    { key: 'margin', label: '毛利率', num: true, render: (r: any) => pct(r.margin) },
  ] },
  { key: 'sales', label: '業務別', api: '/reports/by-sales', cols: [
    { key: 'emp_id', label: '工號' }, { key: 'sales_name', label: '業務', render: (r: any) => `<b>${esc(r.sales_name || '（未指定）')}</b>` },
    { key: 'order_count', label: '訂單數', num: true }, { key: 'qty', label: '數量', num: true, render: (r: any) => num(r.qty) },
    { key: 'revenue', label: '營收(本位幣)', num: true, render: (r: any) => money(r.revenue) },
    { key: 'profit', label: '利潤', num: true, render: (r: any) => money(r.profit) },
    { key: 'margin', label: '毛利率', num: true, render: (r: any) => pct(r.margin) },
  ] },
  { key: 'product', label: '產品別', api: '/reports/by-product', cols: [
    { key: 'part_no', label: '料號', render: (r: any) => `<b>${esc(r.part_no)}</b>` },
    { key: 'unit', label: '單位' }, { key: 'qty', label: '銷量', num: true, render: (r: any) => num(r.qty) },
    { key: 'revenue', label: '營收(本位幣)', num: true, render: (r: any) => money(r.revenue) },
    { key: 'profit', label: '利潤', num: true, render: (r: any) => money(r.profit) },
    { key: 'margin', label: '毛利率', num: true, render: (r: any) => pct(r.margin) },
  ] },
  { key: 'month', label: '月份別', api: '/reports/by-month', cols: [
    { key: 'month', label: '月份' }, { key: 'order_count', label: '訂單數', num: true },
    { key: 'revenue', label: '營收', num: true, render: (r: any) => money(r.revenue) },
    { key: 'cost', label: '成本', num: true, render: (r: any) => money(r.cost) },
    { key: 'freight', label: '運費', num: true, render: (r: any) => money(r.freight) },
    { key: 'profit', label: '利潤', num: true, render: (r: any) => money(r.profit) },
    { key: 'margin', label: '毛利率', num: true, render: (r: any) => pct(r.margin) },
  ] },
  { key: 'delivery', label: '交期追蹤', api: '/reports/delivery', cols: [
    { key: 'order_no', label: '訂單編號', render: (r: any) => `<b>${esc(r.order_no)}</b>` },
    { key: 'customer_name', label: '客戶' }, { key: 'sales_name', label: '業務' },
    { key: 'order_date', label: '訂單日', render: (r: any) => date(r.order_date) },
    { key: 'factory_eta', label: '工廠交期', render: (r: any) => date(r.factory_eta) },
    { key: 'customer_eta', label: '客戶交期', render: (r: any) => date(r.customer_eta) },
    { key: 'ship_date', label: '實際出貨', render: (r: any) => date(r.ship_date) },
    { key: 'delay_days', label: '差異天數', num: true, render: (r: any) => (r.delay_days === null ? '' :
      `<span style="color:${r.delay_days > 0 ? '#C0392B' : '#1E9E52'}">${r.delay_days > 0 ? '+' : ''}${r.delay_days}</span>`) },
    { key: 'status', label: '狀態', render: (r: any) => tag(DELIVERY_STATUS[r.status] || r.status, r.risk === 'delay' ? 'red' : (r.risk === 'warning' ? 'yellow' : 'blue')) },
  ] },
  { key: 'customer-chart', label: '客戶貢獻度', type: 'chart', api: '/reports/by-customer', chartType: 'customer' },
  { key: 'month-chart', label: '月份營收趨勢', type: 'chart', api: '/reports/by-month', chartType: 'month' },
  { key: 'product-chart', label: '產品銷售排行', type: 'chart', api: '/reports/by-product', chartType: 'product' },
  { key: 'aging-chart', label: '應收帳齡分布', type: 'chart', api: '/receivables', chartType: 'aging' },
];

export default function Reports() {
  const cust = useSignal(''); const from = useSignal(''); const to = useSignal(''); const mo = useSignal('');
  // P2-3：測試／平行驗證客戶預設自報表排除；勾選後才納入
  const incTest = useSignal(false);
  const currentKey = useSignal('customer');
  const rows = useSignal([]);
  const bodyLoading = useSignal(false);
  const bodyErr = useSignal('');
  const customersRef = useRef([]);
  const page = useSignal(1);
  const pageSize = useSignal(20);
  const chartCanvasRef = useRef(null);
  const chartInstance = useRef(null);

  useEffect(() => { api.get('/customers').then((c: any) => { customersRef.current = c; }).catch(() => {}); }, []);

  const qs = () => {
    const p = new URLSearchParams();
    if (cust.value) p.set('customer_id', cust.value);
    if (from.value) p.set('date_from', from.value);
    if (to.value) p.set('date_to', to.value);
    if (mo.value) p.set('month', mo.value);
    if (incTest.value) p.set('include_test', '1');
    return p.toString() ? '?' + p.toString() : '';
  };

  const currentTab = () => TABS.find((t: any) => t.key === currentKey.value) || TABS[0];

  const reload = async () => {
    const tab = currentTab();
    bodyLoading.value = true; bodyErr.value = '';
    page.value = 1;
    try { rows.value = await api.get(tab.api + qs()); }
    catch (e) { bodyErr.value = e.message; rows.value = []; }
    finally { bodyLoading.value = false; }
  };

  const pagedRows = () => {
    const start = (page.value - 1) * pageSize.value;
    return rows.value.slice(start, start + pageSize.value);
  };
  useEffect(() => {
    const t = setTimeout(() => { reload(); }, 300);
    return () => clearTimeout(t);
  }, [currentKey.value, cust.value, from.value, to.value, mo.value, incTest.value]);

  // 渲染各種圖表（客戶貢獻度 / 月份營收趨勢 / 產品銷售排行 / 應收帳齡分布）
  useEffect(() => {
    const tab = currentTab();
    if (tab.type !== 'chart') return;
    if (bodyLoading.value || !rows.value.length) return;
    if (chartInstance.current) { chartInstance.current.destroy(); chartInstance.current = null; }
    const canvas = chartCanvasRef.current;
    if (!canvas || !window.Chart) return;

    let config: any = null;
    const ct = tab.chartType;

    if (ct === 'customer') {
      const sorted = [...rows.value].sort((a: any, b: any) => (b.revenue || 0) - (a.revenue || 0)).slice(0, 10);
      const labels = sorted.map((r: any) => r.customer_name || '（未指定）');
      const data = sorted.map((r: any) => Number(r.revenue) || 0);
      const total = data.reduce((s: number, v: number) => s + v, 0);
      config = {
        type: 'bar',
        data: { labels, datasets: [{ label: '營收（本位幣）', data, backgroundColor: 'rgba(52,152,219,0.7)', borderColor: 'rgba(52,152,219,1)', borderWidth: 1, borderRadius: 4 }] },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: any) => { const p = total > 0 ? ((ctx.parsed.x / total) * 100).toFixed(1) : '0'; return `營收：${ctx.parsed.x.toLocaleString()}（占比 ${p}%）`; } } } },
          scales: { x: { beginAtZero: true, ticks: { callback: (v: any) => Number(v).toLocaleString() } } },
        },
      };
    } else if (ct === 'month') {
      const sorted = [...rows.value].sort((a: any, b: any) => String(a.month).localeCompare(String(b.month)));
      const labels = sorted.map((r: any) => r.month);
      const revenue = sorted.map((r: any) => Number(r.revenue) || 0);
      const cost = sorted.map((r: any) => Number(r.cost) || 0);
      const profit = sorted.map((r: any) => Number(r.profit) || 0);
      config = {
        type: 'line',
        data: { labels, datasets: [
          { label: '營收', data: revenue, borderColor: 'rgba(52,152,219,1)', backgroundColor: 'rgba(52,152,219,0.1)', fill: true, tension: 0.3, pointRadius: 4 },
          { label: '成本', data: cost, borderColor: 'rgba(230,126,34,1)', backgroundColor: 'rgba(230,126,34,0.1)', fill: false, tension: 0.3, pointRadius: 4 },
          { label: '利潤', data: profit, borderColor: 'rgba(46,204,113,1)', backgroundColor: 'rgba(46,204,113,0.1)', fill: false, tension: 0.3, pointRadius: 4 },
        ] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: (ctx: any) => `${ctx.dataset.label}：${Number(ctx.parsed.y).toLocaleString()}` } } },
          scales: { y: { beginAtZero: true, ticks: { callback: (v: any) => Number(v).toLocaleString() } } },
        },
      };
    } else if (ct === 'product') {
      const sorted = [...rows.value].sort((a: any, b: any) => (b.revenue || 0) - (a.revenue || 0)).slice(0, 10);
      const labels = sorted.map((r: any) => r.part_no || '（未指定）');
      const data = sorted.map((r: any) => Number(r.revenue) || 0);
      const qty = sorted.map((r: any) => Number(r.qty) || 0);
      config = {
        type: 'bar',
        data: { labels, datasets: [
          { label: '營收（本位幣）', data, backgroundColor: 'rgba(155,89,182,0.7)', borderColor: 'rgba(155,89,182,1)', borderWidth: 1, borderRadius: 4 },
        ] },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: any) => { const idx = ctx.dataIndex; return `營收：${Number(ctx.parsed.x).toLocaleString()}｜銷量：${qty[idx]}`; } } } },
          scales: { x: { beginAtZero: true, ticks: { callback: (v: any) => Number(v).toLocaleString() } } },
        },
      };
    } else if (ct === 'aging') {
      // 應收帳齡：依 due_date 計算各區間筆數與金額
      const today = new Date();
      const buckets: any = { '未到期': { count: 0, amount: 0 }, '逾期1-30天': { count: 0, amount: 0 }, '逾期31-60天': { count: 0, amount: 0 }, '逾期61-90天': { count: 0, amount: 0 }, '逾期90天以上': { count: 0, amount: 0 } };
      for (const r of rows.value) {
        if (!r.due_date) continue;
        const due = new Date(r.due_date);
        const diff = Math.floor((today.getTime() - due.getTime()) / 86400000);
        const amt = Number(r.total_base || r.total || 0);
        let key = '逾期90天以上';
        if (diff < 0) key = '未到期';
        else if (diff <= 30) key = '逾期1-30天';
        else if (diff <= 60) key = '逾期31-60天';
        else if (diff <= 90) key = '逾期61-90天';
        buckets[key].count++;
        buckets[key].amount += amt;
      }
      const labels = Object.keys(buckets);
      const data = labels.map((k) => buckets[k].amount);
      const counts = labels.map((k) => buckets[k].count);
      const colors = ['rgba(46,204,113,0.7)', 'rgba(52,152,219,0.7)', 'rgba(241,196,15,0.7)', 'rgba(230,126,34,0.7)', 'rgba(231,76,60,0.7)'];
      config = {
        type: 'doughnut',
        data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: 'right' },
            tooltip: { callbacks: { label: (ctx: any) => { const idx = ctx.dataIndex; return `${labels[idx]}：${Number(ctx.parsed).toLocaleString()}（${counts[idx]} 筆）`; } } },
          },
        },
      };
    }

    if (config) {
      chartInstance.current = new window.Chart(canvas, config);
    }
    return () => { if (chartInstance.current) { chartInstance.current.destroy(); chartInstance.current = null; } };
  }, [currentKey.value, bodyLoading.value, rows.value]);

  const dl = (type: any) => {
    const p = new URLSearchParams({ type });
    if (cust.value) p.set('customer_id', cust.value);
    if (from.value) p.set('date_from', from.value);
    if (to.value) p.set('date_to', to.value);
    if (mo.value) p.set('month', mo.value);
    if (incTest.value) p.set('include_test', '1');
    return api.download('/reports/export?' + p.toString(), `${type}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const onBatch = (e: any) => {
    const btn = e.target.closest('.batch-btn');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'export-orders') return dl('orders');
    if (act === 'export-ar') return dl('receivable');
    if (act === 'export-deli') return dl('delivery');
    const map: any = {
      'orders-pdf': { hash: '#/orders', batch: 'pdf' },
      'shipments-pdf': { hash: '#/shipments', batch: 'pdf' },
      'orders-email': { hash: '#/orders', batch: 'email' },
      'shipments-email': { hash: '#/shipments', batch: 'email' },
      'receivables-batch': { hash: '#/receivables', batch: 'batch-generate' },
    };
    const m = map[act]; if (!m) return;
    try {
      localStorage.setItem('mj.pendingBatch', JSON.stringify({
        act: m.batch, at: new Date().toISOString(),
        filter: { customer: cust.value, from: from.value, to: to.value, month: mo.value },
      }));
    } catch { /* ignore */ }
    toast('正在跳到目標頁自動執行…', 'ok');
    location.hash = m.hash;
  };

  const tab = currentTab();
  const isChart = tab.type === 'chart';
  return (
    <>
      <div class="card batch-panel" id="batch-panel">
        <div class="batch-panel-title">常用批次動作（點下去會跳到目標頁並自動執行）</div>
        <div class="batch-grid" onClick={onBatch}>
          <button class="batch-btn" data-act="orders-pdf"><span class="b-icon">📄</span><span class="b-label">批次合併列印訂單</span><span class="b-hint">所有「已確認」訂單 → 1 個 PDF</span></button>
          <button class="batch-btn" data-act="shipments-pdf"><span class="b-icon">📄</span><span class="b-label">批次合併列印出貨</span><span class="b-hint">所有已建立出貨單 → 1 個 PDF</span></button>
          <button class="batch-btn" data-act="orders-email"><span class="b-icon">✉️</span><span class="b-label">批次寄送訂單</span><span class="b-hint">「已確認」訂單 → 多附件 Email</span></button>
          <button class="batch-btn" data-act="shipments-email"><span class="b-icon">✉️</span><span class="b-label">批次寄送出貨單</span><span class="b-hint">所有出貨單 → 多附件 Email</span></button>
          <button class="batch-btn" data-act="export-orders"><span class="b-icon">📊</span><span class="b-label">匯出訂單明細</span><span class="b-hint">依目前篩選條件匯出 xlsx</span></button>
          <button class="batch-btn" data-act="export-ar"><span class="b-icon">📊</span><span class="b-label">匯出應收帳款</span><span class="b-hint">依目前篩選條件匯出 xlsx</span></button>
          <button class="batch-btn" data-act="export-deli"><span class="b-icon">📊</span><span class="b-label">匯出交期追蹤</span><span class="b-hint">依目前篩選條件匯出 xlsx</span></button>
          <button class="batch-btn" data-act="receivables-batch"><span class="b-icon">💰</span><span class="b-label">批次結帳當月應收</span><span class="b-hint">依月份 / 狀態批次補開（會計月結）</span></button>
        </div>
      </div>
      <div class="toolbar">
        <div class="fld"><label>客戶</label><select value={cust.value} onChange={(e: any) => (cust.value = e.currentTarget.value)}>
          <option value="">全部</option>{customersRef.current.map((c: any) => <option value={c.id}>{esc(c.name)}</option>)}</select></div>
        <div class="fld"><label>訂單日起</label><input type="date" value={from.value} onInput={(e: any) => (from.value = e.currentTarget.value)} /></div>
        <div class="fld"><label>訂單日迄</label><input type="date" value={to.value} onInput={(e: any) => (to.value = e.currentTarget.value)} /></div>
        <div class="fld"><label>月份</label><input type="month" value={mo.value} onInput={(e: any) => (mo.value = e.currentTarget.value)} /></div>
        <div class="fld" style="justify-content:flex-end"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap">
          <input type="checkbox" checked={incTest.value} onChange={(e: any) => (incTest.value = e.currentTarget.checked)} />
          <span title="預設排除 ETL 平行驗證等測試客戶，避免污染經營分析">含測試客戶</span></label></div>
        <div class="spacer" />
        <button class="btn" onClick={() => dl('orders')}>匯出訂單明細</button>
        <button class="btn" onClick={() => dl('receivable')}>匯出應收帳款</button>
        <button class="btn" onClick={() => dl('delivery')}>匯出交期追蹤</button>
      </div>
      <div class="card">
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
          {TABS.map((t: any) =>
            <button class={`btn ${t.key === currentKey.value ? 'btn-primary' : ''}`} onClick={() => (currentKey.value = t.key)}>{t.label}</button>)}
        </div>
        {bodyLoading.value
          ? <div class="empty">載入中…</div>
          : bodyErr.value
            ? <div class="empty" style="color:#C0392B">載入失敗：{bodyErr.value}</div>
            : isChart
              ? (rows.value.length
                  ? <div style="height:420px;position:relative"><canvas ref={chartCanvasRef}></canvas></div>
                  : <div class="empty">此條件下沒有資料</div>)
              : <>
                  <Table columns={tab.cols} rows={pagedRows()} empty="此條件下沒有資料" />
                  <Pagination page={page.value} pageSize={pageSize.value} total={rows.value.length}
                    onPageChange={(p: any) => (page.value = p)}
                    onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
                </>}
      </div>
    </>
  );
}
Reports.title = '報表分析';
