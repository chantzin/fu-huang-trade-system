// 授權管理（匯入授權）：供應商專屬功能，僅超級管理員（ADMIN/admin123）可見可用
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';
import { confirmDialog } from '../ui/Modal.tsx';
import { esc } from '../ui/format.ts';

export default function LicenseAdmin() {
  const licState = useSignal<any>(null);
  const licLoading = useSignal(false);
  const licFile = useSignal<File | null>(null);
  const licImporting = useSignal(false);
  const licMsg = useSignal('');
  const licOk = useSignal(false);
  const installInfo = useSignal<any>(null);

  const loadLicense = async () => {
    licLoading.value = true;
    try {
      licState.value = await api.get('/license');
      installInfo.value = await api.getInstallInfo();
    }
    catch (e) { toast(e.message, 'err'); }
    finally { licLoading.value = false; }
  };
  useEffect(() => { loadLicense(); }, []);

  const doImportLicense = async () => {
    if (!licFile.value) return toast('請先選擇授權檔（.lic）', 'warn');
    const ok = await confirmDialog('匯入授權檔將立即覆寫目前系統授權並生效，確定繼續？');
    if (!ok) return;
    licImporting.value = true;
    licMsg.value = '';
    try {
      const fd = new FormData();
      fd.append('lic', licFile.value);
      const r = await api.post('/license/import', fd);
      licOk.value = true;
      licMsg.value = r.msg + (r.state && r.state.licensee ? `（${r.state.licensee}）` : '');
      licFile.value = null;
      await loadLicense();
      toast('授權檔已匯入並生效', 'ok');
    } catch (e) {
      licOk.value = false;
      licMsg.value = e.message;
      toast(e.message, 'err');
    } finally {
      licImporting.value = false;
    }
  };

  return (
    <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0">授權管理</h3>
      </div>

      <div class="calc-note" style="font-size:12px;margin-bottom:12px">
        本功能為<strong>供應商專屬</strong>操作（僅供應商交付帳號／超級管理員可見）。匯入由供應商簽發的 <code>.lic</code> 授權檔，
        系統會以公鑰驗章並立即生效（模組／席次／期限擋截隨之更新）。
      </div>

      {/* 安裝識別與環境標籤（INS / H3） */}
      <div class="card" style="padding:14px 16px;margin-bottom:12px">
        <h4 style="margin:0 0 8px">安裝識別與環境標籤</h4>
        {(() => {
          const i = installInfo.value;
          if (!i) return <div class="calc-note">載入安裝識別中…</div>;
          return (
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px 16px">
              <div><div style="font-size:11px;color:#6b7280">裝置序號（Install ID）</div><div style="font-weight:600;word-break:break-all">{esc(i.installId || '—')}</div></div>
              <div><div style="font-size:11px;color:#6b7280">安裝時間</div><div style="font-weight:600">{i.installAt ? new Date(i.installAt).toLocaleString('zh-TW', { hour12: false }) : '—'}</div></div>
              <div><div style="font-size:11px;color:#6b7280">環境標籤</div><div style="font-weight:600">{esc(i.environment || 'production')}</div></div>
              <div><div style="font-size:11px;color:#6b7280">系統名稱</div><div style="font-weight:600">{esc(i.appName || '—')}</div></div>
              <div><div style="font-size:11px;color:#6b7280">版本</div><div style="font-weight:600">{esc(i.version || '—')}{i.edition ? '（' + esc(i.edition) + '）' : ''}</div></div>
            </div>
          );
        })()}
        <div class="calc-note" style="margin-top:8px;font-size:12px">💡 多客戶部署時，裝置序號可區分「哪一套裝置／授權綁誰」；sidebar 左下角亦顯示其末 8 碼。</div>
      </div>

      {/* 目前授權狀態 */}
      <div class="card" style="padding:14px 16px;margin-bottom:12px">
        <h4 style="margin:0 0 8px">目前授權狀態</h4>
        {licLoading.value && <div class="calc-note">載入授權狀態中…</div>}
        {licState.value && (() => {
          const s = licState.value;
          const mods = (s.modules && s.modules.includes('*')) ? '全模組（*）' : (s.modules && s.modules.length ? s.modules.join('、') : '—');
          const seats = (s.seats === 0 || s.seats == null) ? '不限' : String(s.seats);
          const tagText = s.mode === 'licensed' ? '已授權' : s.mode === 'trial' ? '試用版' : s.mode === 'expired' ? '已到期' : '未知';
          const tagBg = s.mode === 'licensed' ? '#dcfce7;color:#157347' : s.mode === 'trial' ? '#e0f2fe;color:#0369a1' : s.mode === 'expired' ? '#fee2e2;color:#b42318' : '#fef3c7;color:#92600a';
          return (
            <>
              {s.mode === 'trial' && (
                <div style="font-size:12px;color:#0369a1;background:#e0f2fe;padding:8px 10px;border-radius:8px;margin-bottom:10px">
                  ⚠️ 目前為「試用受限模式」：全模組開放，但僅限 {esc(String(s.trialSeats || 2))} 席，且將於 {esc(s.expiresAt || '—')} 到期；
                  到期後系統停用（403）。請聯絡供應商取得正式授權檔匯入。
                </div>
              )}
              {s.tampered && (
                <div style="font-size:12px;color:#b42318;background:#fee2e2;padding:8px 10px;border-radius:8px;margin-bottom:10px">
                  ⚠️ 偵測到授權檔驗章失敗（可能被竄改），系統已降為試用受限模式。
                </div>
              )}
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px 16px;margin-top:8px">
                <div><div style="font-size:11px;color:#6b7280">狀態</div><span style={"padding:2px 10px;border-radius:10px;font-size:12px;font-weight:600;background:" + tagBg}>{tagText}</span></div>
                <div><div style="font-size:11px;color:#6b7280">授權方案</div><div style="font-weight:600">{esc(s.plan || '—')}</div></div>
                <div><div style="font-size:11px;color:#6b7280">授權對象</div><div style="font-weight:600">{esc(s.licensee || '—')}</div></div>
                <div><div style="font-size:11px;color:#6b7280">授權模組</div><div style="font-weight:600">{esc(mods)}</div></div>
                <div><div style="font-size:11px;color:#6b7280">席次上限</div><div style="font-weight:600">{esc(seats)}</div></div>
                <div><div style="font-size:11px;color:#6b7280">到期日</div><div style="font-weight:600">{esc(s.expiresAt || '—')}</div></div>
              </div>
            </>
          );
        })()}
      </div>

      {/* 匯入授權檔 */}
      <div class="card" style="padding:14px 16px">
        <h4 style="margin:0 0 8px">匯入授權檔</h4>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
          <label class="btn btn-sm" style="margin:0">
            選擇授權檔（.lic）
            <input type="file" accept=".lic,application/json" style="display:none"
              onChange={(e: any) => (licFile.value = e.currentTarget.files && e.currentTarget.files[0] ? e.currentTarget.files[0] : null)} />
          </label>
          {licFile.value && <span style="font-size:12px;color:#6b7280">已選：{esc(licFile.value.name)}</span>}
          <button class="btn btn-sm btn-primary" disabled={!licFile.value || licImporting.value} onClick={doImportLicense}>
            {licImporting.value ? '匯入中…' : '匯入並生效'}
          </button>
        </div>
        {licMsg.value && (
          <div style={"font-size:12px;margin-top:8px;color:" + (licOk.value ? '#157347' : '#b42318')}>
            {licOk.value ? '✅ ' : '⚠️ '}{esc(licMsg.value)}
          </div>
        )}
      </div>
    </div>
  );
}
LicenseAdmin.title = '授權管理';
