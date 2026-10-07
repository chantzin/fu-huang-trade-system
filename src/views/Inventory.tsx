// 庫存管理（P1/P2/P4/P5，2026-09-23）
// 總覽 KPI / 異動日記帳 / 批號序號 / 補貨建議 / 手動調整 / 盤點
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';
import { confirmDialog } from '../ui/Modal.tsx';

const DOC_LABEL: any = { opening_balance: '期初建帳', receipt: '入庫', shipment: '出貨', adjust: '調整', stocktake: '盤點', transfer: '移轉', reversal: '沖銷' };

export default function Inventory() {
  const tab = useSignal('summary');
  const loading = useSignal(false);

  // 總覽
  const summary = useSignal<any>(null);
  const reorder = useSignal<any[]>([]);
  // 異動
  const txns = useSignal<any[]>([]);
  const fProduct = useSignal('');
  const fType = useSignal('');
  const fFrom = useSignal('');
  const fTo = useSignal('');
  // 批號 / 序號
  const lots = useSignal<any[]>([]);
  const serials = useSignal<any[]>([]);
  const sStatus = useSignal('');
  // 調整
  const products = useSignal<any[]>([]);
  const openingCandidates = useSignal<any[]>([]);
  const adjProduct = useSignal('');
  const adjDelta = useSignal('');
  const adjReason = useSignal('');
  const adjNote = useSignal('');
  // 期初建帳
  const openingProduct = useSignal('');
  const openingQty = useSignal('');
  const openingCost = useSignal('');
  const openingBatch = useSignal('');
  const openingMfgDate = useSignal('');
  const openingExpDate = useSignal('');
  const openingSerials = useSignal('');
  const openingNote = useSignal('');
  // 盤點
  const stocktakes = useSignal<any[]>([]);
  const stDetail = useSignal<any>(null);      // { head, items }
  const stItems = useSignal<any[]>([]);        // 可編輯副本

  const loadProducts = async () => {
    try { products.value = await api.get('/products'); } catch { /* ignore */ }
  };

  const loadOpeningCandidates = async () => {
    try { openingCandidates.value = await api.get('/inventory/opening-candidates'); } catch { /* ignore */ }
  };

  const loadSummary = async () => {
    loading.value = true;
    try {
      const [s, r] = await Promise.all([
        api.get('/inventory/summary'),
        api.get('/inventory/reorder'),
      ]);
      summary.value = s;
      reorder.value = r || [];
    } catch (e: any) { toast(e.message || '載入失敗', 'err'); }
    finally { loading.value = false; }
  };

  const loadTxns = async () => {
    loading.value = true;
    try {
      const q: any = {};
      if (fProduct.value) q.product_id = fProduct.value;
      if (fType.value) q.doc_type = fType.value;
      if (fFrom.value) q.date_from = fFrom.value;
      if (fTo.value) q.date_to = fTo.value;
      txns.value = await api.get('/inventory/transactions', q);
    } catch (e: any) { toast(e.message || '載入失敗', 'err'); }
    finally { loading.value = false; }
  };

  const loadLots = async () => {
    loading.value = true;
    try { lots.value = await api.get('/inventory/lots'); } catch (e: any) { toast(e.message || 'err', 'err'); }
    finally { loading.value = false; }
  };

  const loadSerials = async () => {
    loading.value = true;
    try { serials.value = await api.get('/inventory/serials', sStatus.value ? { status: sStatus.value } : {}); }
    catch (e: any) { toast(e.message || 'err', 'err'); }
    finally { loading.value = false; }
  };

  const loadStocktakes = async () => {
    loading.value = true;
    try { stocktakes.value = await api.get('/inventory/stocktake'); } catch (e: any) { toast(e.message || 'err', 'err'); }
    finally { loading.value = false; }
  };

  useEffect(() => {
    loadProducts();
    if (tab.value === 'opening') loadOpeningCandidates();
    if (tab.value === 'summary') loadSummary();
    if (tab.value === 'transactions') loadTxns();
    if (tab.value === 'lots') loadLots();
    if (tab.value === 'serials') loadSerials();
    if (tab.value === 'stocktake') loadStocktakes();
  }, [tab.value]);

  const doAdjust = async () => {
    const pid = Number(adjProduct.value);
    const d = Number(adjDelta.value);
    if (!pid) return toast('請選擇產品', 'err');
    if (!d) return toast('調整量不可為 0', 'err');
    try {
      const r: any = await api.post('/inventory/adjust', { product_id: pid, delta: d, reason: adjReason.value, note: adjNote.value });
      toast(`已調整，現有庫存 ${r.newQty}`, 'ok');
      adjDelta.value = ''; adjReason.value = ''; adjNote.value = '';
      loadSummary();
    } catch (e: any) { toast(e.message || '調整失敗', 'err'); }
  };

  const doOpening = async () => {
    const pid = Number(openingProduct.value);
    const qty = Number(openingQty.value);
    const unitCost = Number(openingCost.value);
    if (!pid) return toast('請選擇產品', 'err');
    if (!Number.isFinite(qty) || qty <= 0) return toast('期初數量必須大於 0', 'err');
    if (!Number.isFinite(unitCost) || unitCost < 0) return toast('期初單位成本必須為有效的非負數', 'err');
    const ok = await confirmDialog('期初建帳會建立正式庫存異動，只能對尚無庫存異動且現有庫存為 0 的產品執行。確定過帳？');
    if (!ok) return;
    try {
      const r: any = await api.post('/inventory/opening', {
        product_id: pid, qty, unit_cost: unitCost, batch_no: openingBatch.value,
        mfg_date: openingMfgDate.value, exp_date: openingExpDate.value,
        serials: openingSerials.value, note: openingNote.value,
      });
      toast(`期初建帳完成，庫存 ${fmtNum(r.newQty)}，平均成本 ${fmtMoney(r.newCost)}`, 'ok');
      openingProduct.value = ''; openingQty.value = ''; openingCost.value = ''; openingBatch.value = '';
      openingMfgDate.value = ''; openingExpDate.value = ''; openingSerials.value = ''; openingNote.value = '';
      await Promise.all([loadProducts(), loadOpeningCandidates()]); loadSummary();
    } catch (e: any) { toast(e.message || '期初建帳失敗', 'err'); }
  };

  const createStocktake = async () => {
    const ok = await confirmDialog('將建立一張盤點單草稿，並帶入所有啟用產品的系統庫存量。確定？');
    if (!ok) return;
    try {
      await api.post('/inventory/stocktake', { note: '' });
      toast('盤點單已建立', 'ok');
      loadStocktakes();
    } catch (e: any) { toast(e.message || '建立失敗', 'err'); }
  };

  const openStocktake = async (id: number) => {
    try {
      const d: any = await api.get('/inventory/stocktake/' + id);
      stDetail.value = d;
      stItems.value = (d.items || []).map((it: any) => ({ ...it }));
      tab.value = 'stocktake-detail';
    } catch (e: any) { toast(e.message || '載入失敗', 'err'); }
  };

  const setCounted = (idx: number, v: string) => {
    const arr = stItems.value.slice();
    arr[idx] = { ...arr[idx], counted_qty: Number(v) };
    stItems.value = arr;
  };

  const confirmStocktake = async () => {
    const id = stDetail.value?.head?.id;
    if (!id) return;
    const ok = await confirmDialog('確認盤點？系統將依「實盤量 − 系統量」自動產生調整異動。');
    if (!ok) return;
    try {
      await api.post('/inventory/stocktake/' + id + '/confirm', {
        items: stItems.value.map((it: any) => ({ id: it.id, counted_qty: it.counted_qty, note: it.note })),
      });
      toast('盤點已確認並過帳', 'ok');
      stDetail.value = null; tab.value = 'stocktake'; loadStocktakes(); loadSummary();
    } catch (e: any) { toast(e.message || '確認失敗', 'err'); }
  };

  const s = summary.value;

  return (
    <div class="inventory">
      <div class="su-head">
        <div>
          <p class="muted" style="margin:0">供應鏈管理 · 庫存管理（P1/P2/P4/P5）</p>
          <h2 style="margin:4px 0">庫存管理</h2>
        </div>
      </div>

      <div class="tabs">
        {[
          ['summary', '總覽 / 補貨'], ['transactions', '異動明細'], ['lots', '批號'],
          ['serials', '序號'], ['opening', '期初建帳'], ['adjust', '手動調整'], ['stocktake', '盤點'],
        ].map(([k, l]) => (
          <button class={'tab' + (tab.value === k ? ' active' : '')} onClick={() => (tab.value = k)}>{l}</button>
        ))}
      </div>

      {loading.value ? <p class="muted">載入中…</p> : null}

      {/* ---------- 總覽 / 補貨 ---------- */}
      {tab.value === 'summary' && s ? (
        <div>
          <div class="su-cards">
            <div class="su-card"><div class="su-card-label">在庫 SKU</div><div class="su-card-value">{s.totalSku}</div></div>
            <div class="su-card"><div class="su-card-label">庫存總價值</div><div class="su-card-value">{fmtMoney(s.stockValue)}</div><div class="muted" style="font-size:12px">加權平均成本 × 數量</div></div>
            <div class="su-card"><div class="su-card-label">低於安全庫存</div><div class="su-card-value" style="color:#c0392b">{s.belowSafety}</div></div>
            <div class="su-card"><div class="su-card-label">有效批號 / 在庫序號</div><div class="su-card-value">{s.activeLots} / {s.serialsIn}</div></div>
            <div class="su-card"><div class="su-card-label">90 天內效期將至</div><div class="su-card-value" style="color:#b9770e">{s.expiringSoon}</div></div>
          </div>

          <h3>建議補貨（庫存 ≤ 安全庫存）</h3>
          {reorder.value.length === 0 ? <p class="muted">目前無低於安全庫存的料號 🎉</p> : (
            <table class="tbl">
              <thead><tr><th>料號</th><th>品名</th><th>現有</th><th>安全庫存</th><th>缺口</th><th>供應商</th></tr></thead>
              <tbody>
                {reorder.value.map((r: any) => (
                  <tr key={r.id}>
                    <td>{r.part_no}</td><td>{r.name}</td>
                    <td>{fmtNum(r.stock_qty)}</td><td>{fmtNum(r.safety_stock)}</td>
                    <td style="color:#c0392b">{fmtNum(r.safety_stock - r.stock_qty)}</td>
                    <td class="muted">{r.supplier_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {/* ---------- 異動明細 ---------- */}
      {tab.value === 'transactions' ? (
        <div>
          <div class="filters">
            <input placeholder="產品 ID" value={fProduct.value} onInput={(e: any) => (fProduct.value = e.currentTarget.value)} style={{ width: 90 }} />
            <select value={fType.value} onChange={(e: any) => (fType.value = e.currentTarget.value)}>
              <option value="">全部類型</option>
              <option value="receipt">入庫</option><option value="shipment">出貨</option>
              <option value="adjust">調整</option><option value="stocktake">盤點</option>
            </select>
            <input type="date" value={fFrom.value} onInput={(e: any) => (fFrom.value = e.currentTarget.value)} />
            <input type="date" value={fTo.value} onInput={(e: any) => (fTo.value = e.currentTarget.value)} />
            <button class="btn" onClick={loadTxns}>查詢</button>
          </div>
          <table class="tbl">
            <thead><tr><th>時間</th><th>類型</th><th>料號</th><th>產品</th><th>方向</th><th>數量</th><th>單位成本</th><th>結餘量</th><th>結餘成本</th><th>單據</th><th>操作人</th></tr></thead>
            <tbody>
              {txns.value.map((t: any) => (
                <tr key={t.id}>
                  <td class="muted" style="font-size:12px">{t.created_at}</td>
                  <td>{DOC_LABEL[t.doc_type] || t.doc_type}</td>
                  <td>{t.part_no}</td><td>{t.product_name}</td>
                  <td style={{ color: t.direction > 0 ? '#1e8449' : t.direction < 0 ? '#c0392b' : '#777' }}>{t.direction > 0 ? '＋入' : t.direction < 0 ? '－出' : '調'}</td>
                  <td>{fmtNum(t.qty)}</td><td>{fmtMoney(t.unit_cost)}</td><td>{fmtNum(t.balance_qty)}</td><td>{fmtMoney(t.balance_cost)}</td>
                  <td class="muted">{t.doc_no || '—'}</td><td class="muted">{t.operator || '—'}</td>
                </tr>
              ))}
              {txns.value.length === 0 ? <tr><td colSpan={11} class="muted">尚無異動</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* ---------- 批號 ---------- */}
      {tab.value === 'lots' ? (
        <table class="tbl">
          <thead><tr><th>料號</th><th>產品</th><th>批號</th><th>數量</th><th>單位成本</th><th>製造日</th><th>效期</th><th>入庫單</th></tr></thead>
          <tbody>
            {lots.value.map((l: any) => (
              <tr key={l.id} style={isExpiring(l.exp_date) ? 'background:#fdf2e9' : ''}>
                <td>{l.part_no}</td><td>{l.product_name}</td><td>{l.batch_no || '—'}</td>
                <td>{fmtNum(l.qty)}</td><td>{fmtMoney(l.unit_cost)}</td><td class="muted">{l.mfg_date || '—'}</td>
                <td style={isExpiring(l.exp_date) ? 'color:#c0392b' : ''}>{l.exp_date || '—'}</td><td class="muted">{l.received_doc_no || '—'}</td>
              </tr>
            ))}
            {lots.value.length === 0 ? <tr><td colSpan={8} class="muted">尚無批號庫存</td></tr> : null}
          </tbody>
        </table>
      ) : null}

      {/* ---------- 序號 ---------- */}
      {tab.value === 'serials' ? (
        <div>
          <div class="filters">
            <select value={sStatus.value} onChange={(e: any) => (sStatus.value = e.currentTarget.value)}>
              <option value="">全部狀態</option><option value="in">在庫</option><option value="out">已出庫</option>
            </select>
            <button class="btn" onClick={loadSerials}>查詢</button>
          </div>
          <table class="tbl">
            <thead><tr><th>料號</th><th>產品</th><th>序號</th><th>狀態</th><th>批號</th><th>出庫單</th></tr></thead>
            <tbody>
              {serials.value.map((x: any) => (
                <tr key={x.id}>
                  <td>{x.part_no}</td><td>{x.product_name}</td><td>{x.serial_no}</td>
                  <td style={{ color: x.status === 'in' ? '#1e8449' : '#777' }}>{x.status === 'in' ? '在庫' : '已出庫'}</td>
                  <td class="muted">{x.lot_id || '—'}</td><td class="muted">{x.outbound_doc_no || '—'}</td>
                </tr>
              ))}
              {serials.value.length === 0 ? <tr><td colSpan={6} class="muted">尚無序號紀錄</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* ---------- 手動調整 ---------- */}
      {tab.value === 'adjust' ? (
        <div class="card-form">
          <div class="field"><label>產品</label>
            <select value={adjProduct.value} onChange={(e: any) => (adjProduct.value = e.currentTarget.value)}>
              <option value="">— 選擇 —</option>
              {products.value.map((p: any) => <option value={p.id}>{p.part_no} {p.name}（現有 {fmtNum(p.stock_qty)}）</option>)}
            </select>
          </div>
          <div class="field"><label>調整量（正＝盤盈/補入，負＝盤虧/報廢）</label>
            <input type="number" step="any" value={adjDelta.value} onInput={(e: any) => (adjDelta.value = e.currentTarget.value)} placeholder="例：+5 或 -3" />
          </div>
          <div class="field"><label>原因</label><input value={adjReason.value} onInput={(e: any) => (adjReason.value = e.currentTarget.value)} placeholder="如：盤點調整 / 報廢" /></div>
          <div class="field"><label>備註</label><input value={adjNote.value} onInput={(e: any) => (adjNote.value = e.currentTarget.value)} /></div>
          <button class="btn btn-primary" onClick={doAdjust}>送出調整</button>
        </div>
      ) : null}

      {/* ---------- 期初建帳：新產品首次帶入既有庫存 ---------- */}
      {tab.value === 'opening' ? (
        <div class="card-form">
          <p class="muted" style="grid-column:1/-1;margin:0">只適用於尚無庫存異動且現有庫存為 0 的產品。過帳後會寫入庫存日記帳；後續增減請使用收貨、出貨或手動調整。</p>
          <div class="field"><label>產品</label>
            <select value={openingProduct.value} onChange={(e: any) => (openingProduct.value = e.currentTarget.value)}>
              <option value="">— 選擇零庫存產品 —</option>
              {openingCandidates.value.map((p: any) => (
                <option value={p.id}>{p.part_no} {p.name}</option>
              ))}
            </select>
          </div>
          <div class="field"><label>期初數量</label><input type="number" min="0.0001" step="any" value={openingQty.value} onInput={(e: any) => (openingQty.value = e.currentTarget.value)} /></div>
          <div class="field"><label>單位成本</label><input type="number" min="0" step="0.0001" value={openingCost.value} onInput={(e: any) => (openingCost.value = e.currentTarget.value)} /></div>
          <div class="field"><label>批號（選填）</label><input value={openingBatch.value} onInput={(e: any) => (openingBatch.value = e.currentTarget.value)} /></div>
          <div class="field"><label>製造日（選填）</label><input type="date" value={openingMfgDate.value} onInput={(e: any) => (openingMfgDate.value = e.currentTarget.value)} /></div>
          <div class="field"><label>效期（選填）</label><input type="date" value={openingExpDate.value} onInput={(e: any) => (openingExpDate.value = e.currentTarget.value)} /></div>
          <div class="field" style="grid-column:1/-1"><label>序號（選填；每行一筆，筆數需等於數量）</label><textarea value={openingSerials.value} onInput={(e: any) => (openingSerials.value = e.currentTarget.value)} rows={3} /></div>
          <div class="field" style="grid-column:1/-1"><label>建帳說明</label><input value={openingNote.value} onInput={(e: any) => (openingNote.value = e.currentTarget.value)} /></div>
          <button class="btn btn-primary" onClick={doOpening}>確認期初建帳</button>
        </div>
      ) : null}

      {/* ---------- 盤點列表 ---------- */}
      {tab.value === 'stocktake' ? (
        <div>
          <button class="btn btn-primary" onClick={createStocktake}>＋ 新建盤點單</button>
          <table class="tbl" style="margin-top:12px">
            <thead><tr><th>盤點單號</th><th>狀態</th><th>備註</th><th>建立時間</th><th>確認時間</th><th></th></tr></thead>
            <tbody>
              {stocktakes.value.map((st: any) => (
                <tr key={st.id}>
                  <td>{st.stocktake_no}</td>
                  <td>{st.status === 'confirmed' ? '已確認' : '草稿'}</td>
                  <td class="muted">{st.note || '—'}</td>
                  <td class="muted">{st.created_at}</td>
                  <td class="muted">{st.counted_at || '—'}</td>
                  <td><button class="btn" onClick={() => openStocktake(st.id)}>開啟</button></td>
                </tr>
              ))}
              {stocktakes.value.length === 0 ? <tr><td colSpan={6} class="muted">尚無盤點單</td></tr> : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* ---------- 盤點明細（編輯實盤量） ---------- */}
      {tab.value === 'stocktake-detail' && stDetail.value ? (
        <div>
          <div class="su-head">
            <h3 style="margin:0">盤點單 {stDetail.value.head.stocktake_no}（{stDetail.value.head.status === 'confirmed' ? '已確認' : '草稿'}）</h3>
            <button class="btn btn-primary" onClick={confirmStocktake} disabled={stDetail.value.head.status === 'confirmed'}>確認盤點並過帳</button>
          </div>
          <table class="tbl">
            <thead><tr><th>料號</th><th>品名</th><th>系統量</th><th>實盤量</th><th>差額</th><th>備註</th></tr></thead>
            <tbody>
              {stItems.value.map((it: any, idx: number) => {
                const diff = (Number(it.counted_qty) || 0) - (Number(it.system_qty) || 0);
                return (
                  <tr key={it.id}>
                    <td>{it.part_no}</td><td>{it.product_name}</td>
                    <td>{fmtNum(it.system_qty)}</td>
                    <td><input type="number" step="any" value={it.counted_qty} onInput={(e: any) => setCounted(idx, e.currentTarget.value)} style={{ width: 90 }} /></td>
                    <td style={{ color: diff === 0 ? '#777' : '#c0392b' }}>{fmtNum(diff)}</td>
                    <td><input value={it.note || ''} onInput={(e: any) => { const a = stItems.value.slice(); a[idx] = { ...a[idx], note: e.currentTarget.value }; stItems.value = a; }} style={{ width: 140 }} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function fmtNum(v: any) { return v === null || v === undefined ? '—' : (Number(v) % 1 === 0 ? String(v) : Number(v).toLocaleString('zh-TW', { maximumFractionDigits: 3 })); }
function fmtMoney(v: any) { const n = Number(v) || 0; return '¥' + n.toLocaleString('zh-TW', { maximumFractionDigits: 2 }); }
function isExpiring(d: any) {
  if (!d) return false;
  const exp = new Date(d).getTime(); const now = Date.now(); const in90 = now + 90 * 86400000;
  return exp >= now && exp <= in90;
}

Inventory.title = '庫存管理';
