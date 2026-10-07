// 參數設定 Tab（系統管理）
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../../api.ts';
import { toast } from '../../store.ts';
import { setMoneyDecimals } from '../../ui/format.ts';
import { confirmDialog } from '../../ui/Modal.tsx';

export default function ParamsTab() {
  const params = useSignal([]);
  const newKey = useSignal('');
  const newValue = useSignal('');
  const loading = useSignal(false);

  const load = async () => {
    try { params.value = await api.get('/params'); }
    catch (e) { toast(e.message, 'err'); }
  };
  useEffect(() => { load(); }, []);

  /* 參數顯示標籤 */
  const LABEL: any = {
    tax_rate: '預設營業稅率',
    freight_pct_default: '預設運費佔應收比例（%）',
    order_no_prefix: '訂單編號前綴',
    shipment_no_prefix: '出貨單號前綴',
    receivable_no_prefix: '應收單號前綴',
    ar_basis: '帳期推導規則',
    money_decimals: '全系統金額小數點位數',
    doc_no_prefix: '文件號前綴（表單編輯）',
  };
  /* 參數類型：select 用下拉選單，其餘用 input */
  const TYPE: any = { ar_basis: 'select', money_decimals: 'number' };
  const SELECT_OPTIONS: any = {
    ar_basis: [
      { value: 'month_end', label: '結帳月底 + 月結天數' },
      { value: 'next_month_start', label: '次月 1 日 + (天數-1)' },
    ],
  };
  /* 參數設定說明（顯示於輸入框下方） */
  const HELP: any = {
    ar_basis: '帳期推導規則：month_end＝當月月底＋N 天；next_month_start＝次月 1 日＋(N-1) 天。修改後新產生的應收帳款適用新規則，既有應收帳款不受影響。',
    tax_rate: '預設營業稅率，新增訂單時自動帶入。0.05＝5%。',
    money_decimals: '全系統金額顯示的小數點位數：留空＝無小數點（整數）；設 1＝顯示小數點後 1 位；依此類推（0–6 位）。本欄為系統參數不可刪除；清除輸入框後儲存即回到「未設定」（整數顯示）。',
    order_no_prefix: '訂單編號前綴，如 SO。修改後新訂單適用，既有訂單不受影響。',
    shipment_no_prefix: '出貨單號前綴，如 SH。修改後新出貨單適用。',
    receivable_no_prefix: '應收單號前綴，如 AR。修改後新應收單適用。',
    freight_pct_default: '預設運費佔應收比例（%），新增訂單時自動帶入。',
  };
  /* 系統參數：不可刪除，但可修改值；僅「新增自訂參數」可刪除 */
  const PROTECTED = [
    'tax_rate', 'freight_pct_default', 'money_decimals',
    'order_no_prefix', 'shipment_no_prefix', 'receivable_no_prefix', 'doc_no_prefix',
  ];

  const updateValue = (key: any, value: any) => {
    params.value = params.value.map((p: any) => (p.key === key ? { ...p, value } : p));
  };
  const removeParam = async (key: any) => {
    const ok = await confirmDialog(`確定刪除參數「${key}」？`);
    if (!ok) return;
    try { await api.del('/params/' + key); toast('參數已刪除', 'ok'); load(); }
    catch (e) { toast(e.message, 'err'); }
  };
  const addParam = async () => {
    const key = newKey.value.trim();
    const value = newValue.value.trim();
    if (!key) return toast('請輸入參數名稱', 'warn');
    if (params.value.some((p: any) => p.key === key)) return toast('參數名稱已存在', 'warn');
    try {
      await api.put('/params', { values: { [key]: value } });
      toast('參數已新增', 'ok');
      newKey.value = ''; newValue.value = '';
      load();
    } catch (e) { toast(e.message, 'err'); }
  };
  const save = async () => {
    loading.value = true;
    try {
      const values: any = {};
      params.value.forEach((p: any) => { values[p.key] = String(p.value ?? ''); });
      await api.put('/params', { values });
      toast('參數已儲存', 'ok');
      if (values.money_decimals !== undefined) setMoneyDecimals(values.money_decimals);
      load();
    } catch (e) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };

  return (
    <div class="card">
      <h3>系統參數</h3>

      {/* 參數列表（宣告式渲染，支援下拉選單／刪除按鈕／設定說明） */}
      <div class="form-grid">
        {params.value.map((p: any) => {
          const label = LABEL[p.key] || p.key;
          const type = TYPE[p.key] || 'input';
          const isProtected = PROTECTED.includes(p.key);
          return (
            <div style="position:relative;padding-right:60px">
              <label class="f">
                {label}
                {isProtected && <span style="color:#c0392b;font-size:11px;margin-left:4px">（系統）</span>}
              </label>
              {type === 'select' ? (
                <select value={p.value} onChange={(e: any) => updateValue(p.key, e.currentTarget.value)} style="width:100%">
                  {SELECT_OPTIONS[p.key].map((o: any) => (
                    <option value={o.value} selected={o.value === p.value}>{o.label}</option>
                  ))}
                </select>
              ) : (
                <input type={type === 'number' ? 'number' : 'text'} value={p.value ?? ''} onInput={(e: any) => updateValue(p.key, e.currentTarget.value)} style="width:100%" />
              )}
              {HELP[p.key] && (
                <div style="font-size:11.5px;color:#6b7280;margin-top:4px;line-height:1.5">{HELP[p.key]}</div>
              )}
              {!isProtected && (
                <button class="btn btn-sm btn-danger" style="position:absolute;top:0;right:0"
                  onClick={() => removeParam(p.key)}>刪除</button>
              )}
            </div>
          );
        })}
      </div>

      {/* 新增自訂參數 */}
      <div style="margin-top:20px;padding-top:16px;border-top:1px dashed #d8dde4">
        <h4 style="margin-bottom:10px;color:#2d5a87">＋ 新增自訂參數</h4>
        <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
          <div style="flex:1;min-width:180px">
            <label class="f">參數名稱（key）</label>
            <input value={newKey.value} onInput={(e: any) => (newKey.value = e.currentTarget.value)}
              placeholder="例如：custom_param" style="width:100%" />
          </div>
          <div style="flex:1;min-width:180px">
            <label class="f">參數值（value）</label>
            <input value={newValue.value} onInput={(e: any) => (newValue.value = e.currentTarget.value)}
              placeholder="參數值" style="width:100%" />
          </div>
          <button class="btn btn-secondary" onClick={addParam}>新增參數</button>
        </div>
      </div>

      {/* 儲存按鈕 */}
      <div style="margin-top:16px">
        <button class="btn btn-primary" onClick={save} disabled={loading.value}>
          {loading.value ? '儲存中…' : '儲存參數'}
        </button>
      </div>

      {/* 注意事項 */}
      <div class="calc-note" style="margin-top:14px">
        ⚠️ 「單號前綴」修改後，後續新單才會套用；既有單號不受影響。<br />
        ⚠️ 「帳期推導規則」修改後，新產生的應收帳款適用新規則；既有應收帳款不受影響。<br />
        🔒 標示「（系統）」的參數為系統關鍵參數，不可刪除，但可修改值。
      </div>
    </div>
  );
}
