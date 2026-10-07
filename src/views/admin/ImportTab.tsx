// Excel 匯入 Tab（系統管理）
import { useSignal } from '@preact/signals';
import api from '../../api.ts';
import { toast } from '../../store.ts';
import Modal from '../../ui/Modal.tsx';
import { field } from '../../ui/form.ts';
import { esc } from '../../ui/format.ts';

export default function ImportTab() {
  const result = useSignal('');
  const showModal = useSignal(false);
  const impType = useSignal('');
  const impDry = useSignal(false);
  const types = [
    { key: 'customers', label: '客戶主檔', note: '客戶編號、公司名稱、統一編號、幣別、交易條件、月結天數、稅率…' },
    { key: 'products', label: '產品料號', note: '料號、品名、規格、單位、預設單價、幣別、備註；庫存與成本請透過庫存功能過帳。' },
    { key: 'suppliers', label: '供應商工廠', note: '代號、供應商名稱、交期天數、付款條件…' },
    { key: 'orders', label: '訂單（含明細）', note: '一列 = 一筆明細；相同「訂單編號」自動歸戶成一張單多料號。需先匯入客戶與料號。' },
  ];

  const onCardClick = (e: any) => {
    const t = e.target;
    if (t.dataset.tpl) return api.download('/import/template/' + t.dataset.tpl, `${t.dataset.tpl}_import_template.xlsx`);
    if (!t.dataset.up) return;
    impType.value = t.dataset.up; impDry.value = t.dataset.dry === '1'; showModal.value = true;
  };

  return (
    <div class="card"><h3>Excel 匯入（舊資料批次倒入）</h3>
      <div class="calc-note">建議流程：① 下載範本 → ② 依欄位填寫 → ③ 先「乾跑驗證」看錯誤與警告 → ④ 確認無誤再正式匯入。
        匯入採用「編號比對」：客戶編號／料號已存在則更新，不存在則新增。</div>
      {types.map((t: any) => (
        <div class="card" style="box-shadow:none;margin:12px 0">
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
            <div><b>{t.label}</b><div class="muted" style="font-size:12.5px">{t.note}</div></div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-sm" data-tpl={t.key}>下載範本</button>
              <button class="btn btn-sm" data-up={t.key} data-dry="1">乾跑驗證</button>
              <button class="btn btn-sm btn-primary" data-up={t.key} data-dry="0">正式匯入</button>
            </div>
          </div>
        </div>
      ))}
      <div id="import-result" onClick={onCardClick} />
      {result.value && <div dangerouslySetInnerHTML={{ __html: result.value }} />}
      {showModal.value && (
        <Modal title={`${impDry.value ? '乾跑驗證' : '正式匯入'} — ${impType.value}`}
          body={`<div class="form-grid">
            ${field('選擇 Excel 檔（.xlsx）', `<input type="file" id="f-imp" accept=".xlsx,.xls" />`, true)}
          </div>
          ${impDry.value ? '' : '<div class="calc-note" style="color:#A56C00;background:#FDF3E0;border-color:#F0DFA0">正式匯入會寫入資料庫，建議先跑乾跑驗證。</div>'}`}
          onSave={async (bodyEl: any) => {
            const f = bodyEl.querySelector('#f-imp').files[0];
            if (!f) throw new Error('請選擇檔案');
            const fd = new FormData(); fd.append('file', f);
            const r = await api.post(`/import/${impType.value}?dry_run=${impDry.value ? 1 : 0}`, fd);
            const hasErrors = (r.errors || []).length > 0;
            const hasWarnings = (r.warnings || []).length > 0;
            result.value = `<div class="calc-note" style="background:${hasErrors ? '#FCECEA' : hasWarnings ? '#FDF3E0' : '#E5F6EC'};border-color:${hasErrors ? '#F0C8C2' : hasWarnings ? '#F0DFA0' : '#B7E4C7'};color:${hasErrors ? '#C0392B' : hasWarnings ? '#A56C00' : '#1E9E52'}">
              <b>${impDry.value ? '乾跑結果（未寫入）' : '匯入完成'}</b> 共 ${r.total} 列；訂單 ${r.orders || '-'} 張；明細 ${r.items || '-'} 筆；新增 ${r.created || '-'}；更新 ${r.updated || '-'}
              ${(r.errors || []).length ? `<div style="margin-top:8px"><b>錯誤 ${r.errors.length} 筆：</b><ul style="margin:4px 0 0 18px">${r.errors.slice(0, 20).map((x: any) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
              ${(r.warnings || []).length ? `<div style="margin-top:8px"><b>警告 ${r.warnings.length} 筆：</b><ul style="margin:4px 0 0 18px">${r.warnings.slice(0, 20).map((x: any) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
            </div>`;
            toast(impDry.value ? '乾跑完成，未寫入資料' : '匯入完成', 'ok');
            if (!impDry.value) showModal.value = false;
          }} onClose={() => (showModal.value = false)} />
      )}
    </div>
  );
}
