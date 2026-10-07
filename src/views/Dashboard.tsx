// 儀表板 — 戰情風格（日期區間可選 + 7 KPI + 12 圖表 + 逾期明細 + 警示）
import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import api from '../api.ts';
import { money, pct, num, esc } from '../ui/format.ts';

const STATUS: any = { draft: '草稿', confirmed: '已確認', shipped: '已出貨', billed: '已結帳', paid: '已收款', closed: '結案' };
const STATUS_COLOR: any = { draft: '#90a4ae', confirmed: '#42a5f5', shipped: '#ffa726', billed: '#ab47bc', paid: '#66bb6a', closed: '#7FB8B2' };

function defaultFrom() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`; }
function defaultTo() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(new Date(d.getFullYear(),d.getMonth()+1,0).getDate()).padStart(2,'0')}`; }

export default function Dashboard() {
  const loading = useSignal(true);
  const kpi = useSignal<any>({});
  const incTest = useSignal(false);
  const trend = useSignal<any[]>([]);
  const status = useSignal<any>({});
  const aging = useSignal<any>(null);
  const topCustomers = useSignal<any[]>([]);
  const topProducts = useSignal<any[]>([]);
  const apAging = useSignal<any>({});
  const overdueDetails = useSignal<any[]>([]);
  const shipRate = useSignal<any>({});
  const custConcentration = useSignal<any[]>([]);
  const prodProfit = useSignal<any[]>([]);
  const dateFrom = useSignal(defaultFrom());
  const dateTo = useSignal(defaultTo());
  const rootRef = useRef(null);
  const charts = useRef<any[]>([]);

  const load = async () => {
    loading.value = true;
    try {
      const qs = `?date_from=${dateFrom.value}&date_to=${dateTo.value}`;
      const [d, ag, cust, prod] = await Promise.all([
        api.get('/reports/dashboard' + qs),
        api.get('/receivables/aging'),
        api.get('/reports/by-customer' + qs).catch(() => []),
        api.get('/reports/by-product' + qs).catch(() => []),
      ]);
      kpi.value = d.kpi || {};
      // P2-3：報表預設排除測試／平行驗證客戶，讓使用者知道數字為何變小
      incTest.value = d.include_test !== false;
      trend.value = d.trend || [];
      status.value = d.status || {};
      aging.value = ag;
      topCustomers.value = (cust || []).slice(0, 5);
      topProducts.value = (prod || []).slice(0, 5);
      apAging.value = d.ap_aging || {};
      overdueDetails.value = d.overdue_details || [];
      shipRate.value = d.ship_rate || {};
      custConcentration.value = d.customer_concentration || [];
      prodProfit.value = d.product_profit || [];
    } catch { /* 靜默 */ }
    finally { loading.value = false; }
  };

  useEffect(() => { load(); }, [dateFrom.value, dateTo.value]);

  useEffect(() => {
    if (loading.value) return;
    const el = rootRef.current;
    if (!el) return;
    charts.current.forEach((c: any) => c.destroy());
    charts.current = [];
    if (!window.Chart) return;
    requestAnimationFrame(() => {
      // 1. 營收利潤趨勢 + 毛利率（折線，右軸毛利率）
      const tCanvas = el.querySelector('#wr-trend');
      if (tCanvas && trend.value.length) {
        charts.current.push(new window.Chart(tCanvas, {
          type: 'line',
          data: {
            labels: trend.value.map((t: any) => t.month),
            datasets: [
              { label: '營收', data: trend.value.map((t: any) => t.revenue), borderColor: '#5EEAD4', backgroundColor: 'rgba(94,234,212,0.1)', fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: '#5EEAD4', yAxisID: 'y' },
              { label: '利潤', data: trend.value.map((t: any) => t.profit), borderColor: '#69f0ae', backgroundColor: 'rgba(105,240,174,0.1)', fill: false, tension: 0.3, pointRadius: 3, pointBackgroundColor: '#69f0ae', yAxisID: 'y' },
              { label: '毛利率', data: trend.value.map((t: any) => Number((t.margin * 100).toFixed(1))), borderColor: '#ffc107', borderDash: [5, 3], backgroundColor: 'transparent', fill: false, tension: 0.3, pointRadius: 2, pointBackgroundColor: '#ffc107', yAxisID: 'y1' },
            ],
          },
          options: warChartOptsDual(),
        }));
      }
      // 2. 應收帳齡（圓餅）
      const aCanvas = el.querySelector('#wr-aging');
      if (aCanvas && aging.value) {
        const b = aging.value.buckets || {};
        charts.current.push(new window.Chart(aCanvas, {
          type: 'doughnut',
          data: { labels: Object.keys(b), datasets: [{ data: Object.values(b) as any, backgroundColor: ['#5EEAD4','#ffc107','#ff9800','#f44336','#b71c1c','#69f0ae'], borderColor: '#042F2E', borderWidth: 2 }] },
          options: warDoughnutOpts(),
        }));
      }
      // 3. 客戶營收排行（橫向長條）
      const cCanvas = el.querySelector('#wr-customer');
      if (cCanvas && topCustomers.value.length) {
        charts.current.push(new window.Chart(cCanvas, {
          type: 'bar',
          data: { labels: topCustomers.value.map((r: any) => r.customer_name || '（未指定）'), datasets: [{ label: '營收', data: topCustomers.value.map((r: any) => r.revenue), backgroundColor: 'rgba(94,234,212,0.7)', borderColor: '#5EEAD4', borderWidth: 1, borderRadius: 4 }] },
          options: { ...warChartOpts(), indexAxis: 'y' as any, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: any) => `營收：${Number(ctx.parsed.x).toLocaleString()}` } } } },
        }));
      }
      // 4. 產品銷售排行（橫向長條）
      const pCanvas = el.querySelector('#wr-product');
      if (pCanvas && topProducts.value.length) {
        charts.current.push(new window.Chart(pCanvas, {
          type: 'bar',
          data: { labels: topProducts.value.map((r: any) => r.part_no || '（未指定）'), datasets: [{ label: '營收', data: topProducts.value.map((r: any) => r.revenue), backgroundColor: 'rgba(255,193,7,0.7)', borderColor: '#ffc107', borderWidth: 1, borderRadius: 4 }] },
          options: { ...warChartOpts(), indexAxis: 'y' as any, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx: any) => `營收：${Number(ctx.parsed.x).toLocaleString()}｜銷量：${topProducts.value[ctx.dataIndex]?.qty || 0}` } } } },
        }));
      }
      // 5. 訂單狀態分布（圓餅）
      const sCanvas = el.querySelector('#wr-status');
      if (sCanvas && Object.keys(status.value).length) {
        const labels = Object.keys(status.value).map((s) => STATUS[s] || s);
        const data = Object.values(status.value);
        const colors = Object.keys(status.value).map((s) => STATUS_COLOR[s] || '#7FB8B2');
        charts.current.push(new window.Chart(sCanvas, {
          type: 'doughnut',
          data: { labels, datasets: [{ data: data as any, backgroundColor: colors, borderColor: '#042F2E', borderWidth: 2 }] },
          options: warDoughnutOpts(),
        }));
      }
      // 6. 應付帳齡分布（圓餅）
      const apCanvas = el.querySelector('#wr-ap-aging');
      if (apCanvas && Object.keys(apAging.value).length) {
        const apLabels = Object.keys(apAging.value);
        const apData = apLabels.map((k) => apAging.value[k]);
        const apColors = ['#5EEAD4', '#ffc107', '#ff9800', '#f44336', '#b71c1c'];
        charts.current.push(new window.Chart(apCanvas, {
          type: 'doughnut',
          data: { labels: apLabels, datasets: [{ data: apData as any, backgroundColor: apColors, borderColor: '#042F2E', borderWidth: 2 }] },
          options: warDoughnutOpts(),
        }));
      }
      // 7. 客戶集中度（圓餅：Top 5 + 其他）
      const ccCanvas = el.querySelector('#wr-cust-conc');
      if (ccCanvas && custConcentration.value.length) {
        const ccLabels = custConcentration.value.map((r: any) => r.customer_name);
        const ccData = custConcentration.value.map((r: any) => r.revenue);
        const ccColors = ['#5EEAD4', '#69f0ae', '#ffc107', '#ff9800', '#ab47bc'];
        charts.current.push(new window.Chart(ccCanvas, {
          type: 'doughnut',
          data: { labels: ccLabels, datasets: [{ data: ccData as any, backgroundColor: ccColors, borderColor: '#042F2E', borderWidth: 2 }] },
          options: { ...warDoughnutOpts(), plugins: { legend: { position: 'right', labels: { color: '#A7C9C4', font: { size: 10 }, boxWidth: 10 } }, tooltip: { callbacks: { label: function(ctx: any) { var r = custConcentration.value[ctx.dataIndex]; return r.customer_name + '：' + Number(r.revenue).toLocaleString() + '（' + (r.pct * 100).toFixed(1) + '%）'; } } } } },
        }));
      }
      // 8. 產品毛利排行 Top 5（橫向長條）
      const ppCanvas = el.querySelector('#wr-prod-profit');
      if (ppCanvas && prodProfit.value.length) {
        charts.current.push(new window.Chart(ppCanvas, {
          type: 'bar',
          data: { labels: prodProfit.value.map((r: any) => r.part_no), datasets: [{ label: '毛利', data: prodProfit.value.map((r: any) => r.profit), backgroundColor: 'rgba(105,240,174,0.7)', borderColor: '#69f0ae', borderWidth: 1, borderRadius: 4 }] },
          options: { ...warChartOpts(), indexAxis: 'y' as any, plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx: any) { var r = prodProfit.value[ctx.dataIndex]; return '毛利：' + Number(r.profit).toLocaleString() + '｜毛利率：' + (r.margin * 100).toFixed(1) + '%｜銷量：' + r.qty; } } } } },
        }));
      }
      // 9. 每月訂單數量趨勢（長條）
      const ocCanvas = el.querySelector('#wr-order-count');
      if (ocCanvas && trend.value.length) {
        charts.current.push(new window.Chart(ocCanvas, {
          type: 'bar',
          data: { labels: trend.value.map((t: any) => t.month), datasets: [{ label: '訂單數', data: trend.value.map((t: any) => t.order_count), backgroundColor: 'rgba(66,165,245,0.7)', borderColor: '#42a5f5', borderWidth: 1, borderRadius: 4 }] },
          options: { ...warChartOpts(), plugins: { legend: { display: false }, tooltip: { callbacks: { label: function(ctx: any) { return '訂單數：' + ctx.parsed.y + ' 張'; } } } } },
        }));
      }
    });
    return () => charts.current.forEach((c: any) => c.destroy());
  }, [loading.value, trend.value, aging.value, topCustomers.value, topProducts.value, status.value, apAging.value, overdueDetails.value, shipRate.value, custConcentration.value, prodProfit.value]);

  const k: any = kpi.value;
  const sr: any = shipRate.value;
  const hasOverdue = Number(k.overdue) > 0;
  const hasAp = Number(k.ap_outstanding) > 0;
  const hasOverdueDetails = overdueDetails.value.length > 0;

  if (loading.value) return <div class="wr-loading">戰情資料載入中…</div>;

  return (
    <div class="war-room" ref={rootRef}>
      {/* 日期區間選擇 */}
      <div class="wr-toolbar">
        <div class="wr-title">
          <span class="wr-dot"></span>
          <span>營運戰情中心</span>
          <span class="wr-period">{dateFrom.value} ~ {dateTo.value}</span>
          {!incTest.value && <span class="wr-period" style="margin-left:8px;opacity:.75" title="ETL 平行驗證等測試客戶（customers.is_test=1）已自報表排除，避免污染經營分析">· 已排除測試客戶</span>}
        </div>
        <div class="wr-date-range">
          <label>自</label>
          <input type="date" value={dateFrom.value} onInput={(e: any) => (dateFrom.value = e.currentTarget.value)} />
          <label>至</label>
          <input type="date" value={dateTo.value} onInput={(e: any) => (dateTo.value = e.currentTarget.value)} />
          <button class="wr-btn" onClick={() => { dateFrom.value = defaultFrom(); dateTo.value = defaultTo(); }}>本月</button>
        </div>
      </div>

      {/* KPI 卡片（7 個） */}
      <div class="wr-kpi-grid wr-kpi-7">
        <div class="wr-kpi wr-kpi-cyan">
          <div class="wr-kpi-label">營收（本位幣）</div>
          <div class="wr-kpi-value">{money(k.revenue)}</div>
          <div class="wr-kpi-sub">{k.orders} 張訂單</div>
        </div>
        <div class={`wr-kpi ${k.profit >= 0 ? 'wr-kpi-green' : 'wr-kpi-red'}`}>
          <div class="wr-kpi-label">利潤</div>
          <div class="wr-kpi-value">{money(k.profit)}</div>
          <div class="wr-kpi-sub">毛利率 {pct(k.margin)}</div>
        </div>
        <div class="wr-kpi wr-kpi-amber">
          <div class="wr-kpi-label">應收未收</div>
          <div class="wr-kpi-value">{money(k.outstanding)}</div>
          <div class="wr-kpi-sub">含未到期與逾期</div>
        </div>
        <div class={`wr-kpi ${hasOverdue ? 'wr-kpi-red wr-pulse' : 'wr-kpi-green'}`}>
          <div class="wr-kpi-label">已逾期未收</div>
          <div class="wr-kpi-value">{money(k.overdue)}</div>
          <div class="wr-kpi-sub">{hasOverdue ? '⚠ 需立即處理' : '無逾期'}</div>
        </div>
        <div class={`wr-kpi ${hasAp ? 'wr-kpi-purple' : 'wr-kpi-green'}`}>
          <div class="wr-kpi-label">應付未付</div>
          <div class="wr-kpi-value">{money(k.ap_outstanding)}</div>
          <div class="wr-kpi-sub">供應商帳款</div>
        </div>
        <div class="wr-kpi wr-kpi-blue">
          <div class="wr-kpi-label">出貨單數</div>
          <div class="wr-kpi-value">{num(k.shipments)}</div>
          <div class="wr-kpi-sub">期間內出貨</div>
        </div>
        <div class="wr-kpi wr-kpi-teal">
          <div class="wr-kpi-label">出貨達成率</div>
          <div class="wr-kpi-value">{pct(sr.rate)}</div>
          <div class="wr-kpi-sub">{sr.shipped}/{sr.total} 張已出貨</div>
        </div>
      </div>

      {/* 圖表區：3×3 版面（1920×1080 滿版最佳化） */}
      {/* 排 1 */}
      <div class="wr-chart-grid">
        <div class="wr-card">
          <div class="wr-card-title">營收・利潤・毛利率趨勢</div>
          <div class="wr-chart-box">{window.Chart ? <canvas id="wr-trend"></canvas> : <div class="wr-chart-fail">圖表庫載入失敗</div>}</div>
        </div>
        <div class="wr-card">
          <div class="wr-card-title">應收帳齡分布</div>
          <div class="wr-chart-box">{window.Chart ? <canvas id="wr-aging"></canvas> : <div class="wr-chart-fail">圖表庫載入失敗</div>}</div>
        </div>
        <div class="wr-card">
          <div class="wr-card-title">客戶營收排行 Top 5</div>
          <div class="wr-chart-box">{window.Chart ? <canvas id="wr-customer"></canvas> : <div class="wr-chart-fail">圖表庫載入失敗</div>}</div>
        </div>
      </div>

      {/* 排 2 */}
      <div class="wr-chart-grid">
        <div class="wr-card">
          <div class="wr-card-title">產品銷售排行 Top 5</div>
          <div class="wr-chart-box">{window.Chart ? <canvas id="wr-product"></canvas> : <div class="wr-chart-fail">圖表庫載入失敗</div>}</div>
        </div>
        <div class="wr-card">
          <div class="wr-card-title">訂單狀態分布</div>
          <div class="wr-chart-box">{window.Chart ? <canvas id="wr-status"></canvas> : <div class="wr-chart-fail">圖表庫載入失敗</div>}</div>
        </div>
        <div class="wr-card">
          <div class="wr-card-title">應付帳齡分布</div>
          <div class="wr-chart-box">{window.Chart ? <canvas id="wr-ap-aging"></canvas> : <div class="wr-chart-fail">圖表庫載入失敗</div>}</div>
        </div>
      </div>

      {/* 排 3 */}
      <div class="wr-chart-grid">
        <div class="wr-card">
          <div class="wr-card-title">客戶集中度 Top 5</div>
          <div class="wr-chart-box">{window.Chart ? <canvas id="wr-cust-conc"></canvas> : <div class="wr-chart-fail">圖表庫載入失敗</div>}</div>
        </div>
        <div class="wr-card">
          <div class="wr-card-title">產品毛利排行 Top 5</div>
          <div class="wr-chart-box">{window.Chart ? <canvas id="wr-prod-profit"></canvas> : <div class="wr-chart-fail">圖表庫載入失敗</div>}</div>
        </div>
        <div class="wr-card">
          <div class="wr-card-title">每月訂單數量趨勢</div>
          <div class="wr-chart-box">{window.Chart ? <canvas id="wr-order-count"></canvas> : <div class="wr-chart-fail">圖表庫載入失敗</div>}</div>
        </div>
      </div>

      {/* 逾期帳款明細清單（全寬表格） */}
      {hasOverdueDetails && (
        <div class="wr-card wr-overdue-table">
          <div class="wr-card-title wr-alert-title">
            <span class="wr-alert-dot"></span>逾期帳款明細（{overdueDetails.value.length} 筆）
          </div>
          <div class="wr-table-wrap">
            <table class="wr-table">
              <thead>
                <tr>
                  <th>應收單號</th>
                  <th>客戶編號</th>
                  <th>客戶名稱</th>
                  <th>應收金額</th>
                  <th>已收金額</th>
                  <th>餘額</th>
                  <th>到期日</th>
                  <th>逾期天數</th>
                  <th>狀態</th>
                </tr>
              </thead>
              <tbody>
                {overdueDetails.value.map((r: any) => (
                  <tr key={r.receivable_no}>
                    <td>{esc(r.receivable_no)}</td>
                    <td>{esc(r.customer_no || '-')}</td>
                    <td>{esc(r.customer_name)}</td>
                    <td class="wr-num">{money(r.amount)}</td>
                    <td class="wr-num">{money(r.received)}</td>
                    <td class="wr-num wr-red">{money(r.balance)}</td>
                    <td>{esc(r.due_date)}</td>
                    <td class="wr-num wr-red"><b>{r.overdue_days}</b> 天</td>
                    <td>{STATUS[r.status] || r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 警示區 */}
      {hasOverdue && (
        <div class="wr-alert">
          <div class="wr-alert-icon">⚠</div>
          <div class="wr-alert-text">
            <b>逾期警示：</b>目前有 {money(k.overdue)} 應收帳款已逾期，請儘速處理。
            <a href="#/receivables" class="wr-alert-link">前往應收帳款 →</a>
          </div>
        </div>
      )}
    </div>
  );
}

function warChartOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'top' as const, labels: { color: '#A7C9C4', font: { size: 11 }, boxWidth: 12 } },
      tooltip: { backgroundColor: 'rgba(4,47,46,0.95)', titleColor: '#fff', bodyColor: '#A7C9C4', borderColor: '#5EEAD4', borderWidth: 1 },
    },
    scales: {
      x: { ticks: { color: '#7FB8B2', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
      y: { ticks: { color: '#7FB8B2', font: { size: 10 }, callback: (v: any) => Number(v).toLocaleString() }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
    },
  };
}

function warChartOptsDual() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { position: 'top' as const, labels: { color: '#A7C9C4', font: { size: 11 }, boxWidth: 12 } },
      tooltip: { backgroundColor: 'rgba(4,47,46,0.95)', titleColor: '#fff', bodyColor: '#A7C9C4', borderColor: '#5EEAD4', borderWidth: 1 },
    },
    scales: {
      x: { ticks: { color: '#7FB8B2', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
      y: { type: 'linear' as const, position: 'left' as const, ticks: { color: '#7FB8B2', font: { size: 10 }, callback: (v: any) => Number(v).toLocaleString() }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
      y1: { type: 'linear' as const, position: 'right' as const, ticks: { color: '#ffc107', font: { size: 10 }, callback: (v: any) => v + '%' }, grid: { drawOnChartArea: false }, max: 100, min: 0 },
    },
  };
}

function warDoughnutOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'right' as const, labels: { color: '#A7C9C4', font: { size: 11 } } },
      tooltip: { backgroundColor: 'rgba(4,47,46,0.95)', titleColor: '#fff', bodyColor: '#A7C9C4', borderColor: '#5EEAD4', borderWidth: 1, callbacks: { label: (ctx: any) => `${ctx.label}：${Number(ctx.parsed).toLocaleString()}` } },
    },
  };
}

Dashboard.title = '儀表板';
