// 匯率歷程 Tab（系統管理）
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../../api.ts';
import { toast } from '../../store.ts';
import Table from '../../ui/Table.tsx';
import Modal, { confirmDialog } from '../../ui/Modal.tsx';
import { esc, num, date } from '../../ui/format.ts';

export default function RatesTab({ meta }: any) {
  const fx = useSignal<any>([]); const fxStatus = useSignal<any>({}); const rates = useSignal<any>([]);
  const showNew = useSignal(false);
  const fxBusy = useSignal(false);
  const newForm = useSignal<any>({
    currency: (meta?.currencies || []).filter((c: any) => c !== (meta?.base || 'TWD'))[0] || '',
    rate: 1,
    effective_date: new Date().toISOString().slice(0, 10),
    note: '',
  });
  const reload = async () => {
    try {
      const [f, fs, r] = await Promise.all([api.get('/params/fx'), api.get('/params/fx/status'), api.get('/params/rates')]);
      fx.value = f; fxStatus.value = fs; rates.value = r;
    } catch (e) { toast(e.message, 'err'); }
  };
  useEffect(() => { reload(); }, []);

  const base = meta?.base || 'TWD';
  const curOpts = (meta?.currencies || []).filter((c: any) => c !== base);
  const conf: any = fxStatus.value.config || {};
  const retention = conf.retentionDays || 60;
  const fxCurrencies = conf.currencies || ['USD', 'CNY'];
  const bots: any = {};
  (fx.value || []).forEach((r: any) => { (bots[r.currency] = bots[r.currency] || []).push(r); });

  const botCards = fxCurrencies.map((code: any) => {
    const rows = bots[code] || [];
    const name = code === 'USD' ? '美金' : code === 'CNY' ? '人民幣' : code;
    return (
      <div style="flex:1;min-width:420px">
        <h4 style="margin:0 0 8px">{name}（{code} / 台幣 {esc(base)}）<span class="text-muted" style="font-weight:normal;font-size:12px">1 {code} = ? {esc(base)}</span></h4>
        <Table columns={[
          { key: 'fx_date', label: '日期', render: (r: any) => date(r.fx_date) },
          { key: 'cash_buy', label: '現金買入', num: true, render: (r: any) => num(r.cash_buy, 4) },
          { key: 'cash_sell', label: '現金賣出', num: true, render: (r: any) => num(r.cash_sell, 4) },
          { key: 'spot_buy', label: '即期買入', num: true, render: (r: any) => num(r.spot_buy, 4) },
          { key: 'spot_sell', label: '即期賣出', num: true, render: (r: any) => num(r.spot_sell, 4) },
          { key: 'mid_rate', label: '中間價', num: true, render: (r: any) => num(r.mid_rate, 4) },
        ]} rows={rows} empty="尚無資料，點右上方「抓取台灣銀行匯率」" />
      </div>
    );
  });

  const refreshFx = async () => {
    fxBusy.value = true;
    try {
      const r = await api.post('/params/fx/refresh', { force: true });
      if (!r.ok) throw new Error(r.error);
      toast(`已抓取 ${r.count} 筆（${r.date}，清理 ${r.purged || 0}）`, 'ok'); reload();
    } catch (e) { toast('抓取失敗：' + e.message, 'err'); }
    finally { fxBusy.value = false; }
  };

  const delRate = async (r: any) => {
    if (await confirmDialog('確定刪除這筆匯率紀錄？')) {
      await api.del('/params/rates/' + r.id); toast('已刪除', 'ok'); reload();
    }
  };

  const saveRate = async () => {
    if (!newForm.value.currency) return toast('請選擇幣別', 'warn');
    try {
      await api.post('/params/rates', newForm.value);
      toast('匯率已新增', 'ok'); showNew.value = false; reload();
    } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <>
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3 style="margin:0">台灣銀行牌告匯率（每日擷取）</h3>
          <div style="display:flex;gap:8px;align-items:center">
            <span class="text-muted" style="font-size:12px">{fxStatus.value.lastDate ? `上次抓取：${date(fxStatus.value.lastDate)}（累計 ${fxStatus.value.totalDays} 天 / ${fxStatus.value.totalRecords} 筆）` : '尚未抓取'}</span>
            <button class="btn btn-primary" onClick={refreshFx} disabled={fxBusy.value}>{fxBusy.value ? '抓取中…' : '↻ 抓取台灣銀行匯率'}</button>
          </div>
        </div>
        <div class="calc-note">資料來源：台銀官網牌告匯率。每日自動擷取「{fxCurrencies.join('、')}」買入/賣出匯率，保留 {retention} 天（過期自動清理）。</div>
        <div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:12px">{botCards}</div>
      </div>
      <div class="card" style="margin-top:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3 style="margin:0">手動匯率（訂單用，本位幣 {esc(base)}）</h3>
          <button class="btn" onClick={() => (showNew.value = true)}>＋ 新增匯率</button>
        </div>
        <div class="calc-note">訂單建立時若未手填匯率，系統會取「生效日 ≤ 訂單日」的最新一筆；都沒有則用 config 預設匯率。台銀每日匯率僅供參考追蹤，不直接覆寫這裡。</div>
        <div style="margin-top:10px"><Table columns={[
          { key: 'currency', label: '幣別' },
          { key: 'rate', label: `1 外幣 = ? ${esc(base)}`, num: true, render: (r: any) => num(r.rate, 4) },
          { key: 'effective_date', label: '生效日', render: (r: any) => date(r.effective_date) },
          { key: 'note', label: '備註' },
        ]} rows={rates.value} actions={(r: any) => <button class="btn btn-sm btn-danger" onClick={() => delRate(r)}>刪除</button>} empty="尚無匯率紀錄" /></div>
      </div>
      {showNew.value && (
        <Modal title="新增匯率" saveText="新增匯率" onSave={saveRate} onClose={() => (showNew.value = false)}>
          <div class="form-grid">
            <div>
              <label class="f">幣別 *</label>
              <select value={newForm.value.currency} onChange={(e: any) => (newForm.value = { ...newForm.value, currency: e.currentTarget.value })} style="width:100%">
                {curOpts.map((c: any) => <option value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label class="f">匯率（1 外幣 = ? {esc(base)}）</label>
              <input type="number" step={0.000001} value={newForm.value.rate as any} onInput={(e: any) => (newForm.value = { ...newForm.value, rate: e.currentTarget.value })} style="width:100%" />
            </div>
            <div>
              <label class="f">生效日</label>
              <input type="date" value={newForm.value.effective_date} onInput={(e: any) => (newForm.value = { ...newForm.value, effective_date: e.currentTarget.value })} style="width:100%" />
            </div>
            <div style="grid-column:1/-1">
              <label class="f">備註</label>
              <input value={newForm.value.note} onInput={(e: any) => (newForm.value = { ...newForm.value, note: e.currentTarget.value })} style="width:100%" />
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
