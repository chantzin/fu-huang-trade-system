// 訂單明細宣告式編輯器（C6 重構：從 innerHTML 命令式改為 Preact 宣告式）
// 取代 Orders.jsx 中的 itemRowHtml / renderItems / bindItems / recalc
import { useSignal, useComputed } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { money, pct, esc, date } from '../ui/format.ts';
import { calcRow } from './Orders.tsx';
import Modal from '../ui/Modal.tsx';
import { toast } from '../store.ts';
import api from '../api.ts';

const QSTATUS: any = { draft: '草稿', confirmed: '已報價', expired: '已失效', cancelled: '作廢' };

const defaultItem = () => ({
  part_no: '', product_id: null as any, qty: 1, unit: 'PCS',
  unit_price: 0, tax_rate: 0.05, cost_unit: 0, other_fee: 0,
  freight_cn: 0, freight_tw: 0, note: '',
});

export default function OrderItemsEditor({ items, products, rate, onChange, customerId = 0, currency = 'TWD' }: any) {
  const rows = useSignal((items || []).map((i: any) => ({ ...i })));
  const quoteList = useSignal([]);
  const showQuoteModal = useSignal(false);
  const quoteBusy = useSignal(false);

  // 外部 items 變化時同步（如開啟已存訂單）
  useEffect(() => {
    if (items) {
      rows.value = items.map((i: any) => ({ ...i }));
    }
  }, [items]);

  // 自動計算合計（宣告式：依賴 rows 和 rate 變化自動更新）
  const totals = useComputed(() => {
    const r = Number(rate || 1);
    let sTotalBase = 0, sCost = 0, sProfit = 0;
    rows.value.forEach((it: any) => {
      const c = calcRow(it, r, currency);
      sTotalBase += c.totalBase;
      sCost += c.costTotal;
      sProfit += c.profit;
    });
    return {
      sTotalBase, sCost, sProfit,
      sMargin: sTotalBase > 0 ? sProfit / sTotalBase : 0,
    };
  });

  const notify = (newRows: any) => {
    onChange?.(newRows);
  };

  const updateField = (i: any, field: any, value: any) => {
    const newRows = [...rows.value];
    newRows[i] = { ...newRows[i], [field]: value };
    // 產品選擇自動填充料號/成本/單價
    if (field === 'product_id') {
      const p = (products || []).find((x: any) => String(x.id) === String(value));
      if (p) {
        newRows[i].part_no = p.part_no;
        newRows[i].cost_unit = p.cost_unit || 0;
        newRows[i].unit_price = p.price || 0;
      }
    }
    rows.value = newRows;
    notify(newRows);
  };

  const addRow = () => {
    const newRows = [...rows.value, defaultItem()];
    rows.value = newRows;
    notify(newRows);
  };

  const removeRow = (i: any) => {
    let newRows = rows.value.filter((_: any, idx: any) => idx !== i);
    if (!newRows.length) newRows = [defaultItem()];
    rows.value = newRows;
    notify(newRows);
  };

  const openQuotePicker = async () => {
    if (!Number(customerId)) return toast('請先選擇客戶', 'warn');
    quoteBusy.value = true;
    try {
      const list = await api.get('/quotes', { customer_id: customerId });
      quoteList.value = list.filter((q: any) => ['draft', 'confirmed'].includes(q.status));
      showQuoteModal.value = true;
    } catch (e: any) { toast(e.message || '讀取報價單失敗', 'err'); }
    quoteBusy.value = false;
  };

  const pickQuote = async (qid: any) => {
    try {
      const q = await api.get('/quotes/' + qid);
      const mapped = (q.items || []).map((it: any) => ({
        product_id: it.product_id || null,
        part_no: it.part_no || '',
        qty: Number(it.qty || 0),
        unit: it.unit || 'PCS',
        unit_price: Number(it.unit_price || 0),
        tax_rate: Number(it.tax_rate ?? 0.05),
        cost_unit: 0, other_fee: 0, freight_cn: 0, freight_tw: 0,
        note: it.description || '',
      }));
      if (!mapped.length) return toast('該報價單無明細可帶入', 'warn');
      rows.value = mapped;
      notify(mapped);
      showQuoteModal.value = false;
      toast(`已帶入報價單 ${q.quotation_no || ''} 共 ${mapped.length} 筆明細`, 'ok');
    } catch (e: any) { toast(e.message || '帶入失敗', 'err'); }
  };

  const prodOptions = [[0, '（自訂料號）']].concat(
    (products || []).map((p: any) => [p.id, `${p.part_no} ${p.name}`])
  );

  const r = Number(rate || 1);

  return (
    <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin:10px 0 6px">
        <b>訂單明細（料號）</b>
        <span>
          <button class="btn btn-sm" type="button" style="margin-right:6px" onClick={openQuotePicker}>帶入報價單</button>
          <button class="btn btn-sm" type="button" onClick={addRow}>＋ 新增料號</button>
        </span>
      </div>
      <div class="table-wrap"><table id="items-tbl">
        <thead><tr>
          <th style="min-width:160px">料號</th><th>數量</th><th>單價(原幣)</th><th>稅率</th>
          <th>應收貨款</th><th>應收總額(原幣)</th><th>應收總額(本位幣)</th>
          <th>台幣單價成本</th><th>其他費用</th><th>運費(大陸)</th><th>運費(台灣)</th>
          <th>成本總額</th><th>利潤</th><th>毛利%</th><th>備註</th>
        </tr></thead>
        <tbody>
          {rows.value.map((it: any, i: any) => {
            const c = calcRow(it, r, currency);
            return (
              <tr data-i={i}>
                <td>
                  <select value={it.product_id || 0} onChange={(e: any) => updateField(i, 'product_id', e.currentTarget.value)}>
                    {prodOptions.map((o: any) => (
                      <option value={o[0]} selected={Number(o[0]) === Number(it.product_id || 0)}>{esc(o[1])}</option>
                    ))}
                  </select>
                  <input value={it.part_no || ''} placeholder="料號" style="margin-top:4px"
                    onInput={(e: any) => updateField(i, 'part_no', e.currentTarget.value)} />
                </td>
                <td><input type="number" step="any" value={Number(it.qty || 0)}
                  onInput={(e: any) => updateField(i, 'qty', Number(e.currentTarget.value || 0))} /></td>
                <td><input type="number" step="any" value={Number(it.unit_price || 0)}
                  onInput={(e: any) => updateField(i, 'unit_price', Number(e.currentTarget.value || 0))} /></td>
                <td><input type="number" step={0.001} value={Number(it.tax_rate || 0)}
                  onInput={(e: any) => updateField(i, 'tax_rate', Number(e.currentTarget.value || 0))} /></td>
                <td>{money(c.amount)}</td>
                <td>{money(c.total)}</td>
                <td>{money(c.totalBase)}</td>
                <td><input type="number" step="any" value={Number(it.cost_unit || 0)}
                  onInput={(e: any) => updateField(i, 'cost_unit', Number(e.currentTarget.value || 0))} /></td>
                <td><input type="number" step="any" value={Number(it.other_fee || 0)}
                  onInput={(e: any) => updateField(i, 'other_fee', Number(e.currentTarget.value || 0))} /></td>
                <td><input type="number" step="any" value={Number(it.freight_cn || 0)}
                  onInput={(e: any) => updateField(i, 'freight_cn', Number(e.currentTarget.value || 0))} /></td>
                <td><input type="number" step="any" value={Number(it.freight_tw || 0)}
                  onInput={(e: any) => updateField(i, 'freight_tw', Number(e.currentTarget.value || 0))} /></td>
                <td>{money(c.costTotal)}</td>
                <td><b style={`color:${c.profit >= 0 ? '#1E9E52' : '#C0392B'}`}>{money(c.profit)}</b></td>
                <td>{pct(c.margin)}</td>
                <td>
                  <input value={it.note || ''} placeholder="備註"
                    onInput={(e: any) => updateField(i, 'note', e.currentTarget.value)} />
                  <button class="btn btn-sm btn-danger" type="button" style="margin-top:4px"
                    onClick={() => removeRow(i)}>移除</button>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot><tr>
          <td colspan={6} style="text-align:right"><b>合計</b></td>
          <td class="num"><b>{money(totals.value.sTotalBase)}</b></td>
          <td colspan={4}></td>
          <td class="num">{money(totals.value.sCost)}</td>
          <td class="num"><b style={`color:${totals.value.sProfit >= 0 ? '#1E9E52' : '#C0392B'}`}>{money(totals.value.sProfit)}</b></td>
          <td class="num">{pct(totals.value.sMargin)}</td>
          <td></td>
        </tr></tfoot>
      </table></div>
      {showQuoteModal.value && (
        <Modal
          title="帶入報價單（請選擇）"
          body={`
            <div style="max-height:60vh;overflow:auto">
              <table class="tbl" style="width:100%">
                <thead><tr><th>報價單號</th><th>客戶編號</th><th>報價日期</th><th>有效日期</th><th>狀態</th><th></th></tr></thead>
                <tbody>
                  ${quoteList.value.length
                    ? quoteList.value.map((q: any) => `<tr><td><b>${esc(q.quotation_no || '')}</b></td><td>${esc(q.customer_no || '')}</td><td>${date(q.quotation_date)}</td><td>${date(q.valid_until)}</td><td>${esc(QSTATUS[q.status] || q.status || '')}</td><td><button class="btn btn-sm" data-qid="${q.id}">帶入</button></td></tr>`).join('')
                    : '<tr><td colspan="6" style="text-align:center;color:#8A93A2">該客戶尚無有效報價單</td></tr>'}
                </tbody>
              </table>
            </div>
          `}
          saveText="關閉"
          onOpen={(bodyEl: any) => {
            bodyEl.querySelectorAll('[data-qid]').forEach((b: any) => {
              b.onclick = () => pickQuote(Number(b.dataset.qid));
            });
          }}
          onSave={async () => { showQuoteModal.value = false; return true; }}
          onClose={() => (showQuoteModal.value = false)}
        />
      )}
    </div>
  );
}
