// 系統外觀（主題切換 / 公司資訊 / 系統背景圖）
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { toast, companyInfo } from '../store.ts';
import { confirmDialog } from '../ui/Modal.tsx';

export default function SystemAppearance() {
  const theme = useSignal('light');
  const companyName = useSignal('');
  const companyNameEn = useSignal('');
  const companyTaxId = useSignal('');
  const companyAddress = useSignal('');
  const companyPhone = useSignal('');
  const companyFax = useSignal('');
  const companyWebsite = useSignal('');
  const companyLogo = useSignal('');
  const systemBackground = useSignal('');
  const loading = useSignal(false);
  const logoUploading = useSignal(false);
  const bgUploading = useSignal(false);

  const load = async () => {
    try {
      const [s, p] = await Promise.all([
        api.get('/system-settings'),
        fetch('/api/company-profile', { cache: 'no-store' }).then((r: any) => r.json()),
      ]);
      theme.value = s.theme || 'light';
      companyName.value = p.companyName || '';
      companyNameEn.value = p.companyNameEn || '';
      companyTaxId.value = p.companyTaxId || '';
      companyAddress.value = p.companyAddress || '';
      companyPhone.value = p.companyPhone || '';
      companyFax.value = p.companyFax || '';
      companyWebsite.value = p.companyWebsite || '';
      companyLogo.value = p.companyLogo || '';
      systemBackground.value = p.systemBackground || '';
    } catch (e) { toast(e.message, 'err'); }
  };
  useEffect(() => { load(); }, []);

  /* 主題切換 */
  const selectTheme = (t: any) => {
    theme.value = t;
    document.documentElement.setAttribute('data-theme', t);
  };

  const saveTheme = async () => {
    loading.value = true;
    try {
      await api.put('/system-settings', { theme: theme.value });
      toast('主題已儲存', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };

  /* 公司資訊儲存（名稱 / 地址 / 電話） */
  const saveCompanyName = async () => {
    try {
      await api.put('/company-profile', {
        companyName: companyName.value,
        companyNameEn: companyNameEn.value,
        companyTaxId: companyTaxId.value,
        companyAddress: companyAddress.value,
        companyPhone: companyPhone.value,
        companyFax: companyFax.value,
        companyWebsite: companyWebsite.value,
      });
      // 同步更新全域 companyInfo，讓登入頁/側邊欄/系統地圖即時生效
      companyInfo.value = { ...companyInfo.value, name: companyName.value, nameEn: companyNameEn.value, taxId: companyTaxId.value, address: companyAddress.value, phone: companyPhone.value, fax: companyFax.value, website: companyWebsite.value };
      toast('公司資訊已儲存', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  /* Logo 上傳 */
  const onLogoUpload = async (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    logoUploading.value = true;
    try {
      const formData = new FormData();
      formData.append('logo', file);
      const r = await fetch('/api/company-profile/logo', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + api.getToken() },
        body: formData,
      }).then((r: any) => r.json());
      if (r.ok) {
        companyLogo.value = r.companyLogo;
        companyInfo.value = { ...companyInfo.value, logo: r.companyLogo };
        toast('Logo 已上傳', 'ok');
      }
      else toast(r.error || '上傳失敗', 'err');
    } catch (e) { toast(e.message, 'err'); }
    finally { logoUploading.value = false; e.target.value = ''; }
  };

  const deleteLogo = async () => {
    const ok = await confirmDialog('確定刪除公司 Logo？');
    if (!ok) return;
    try {
      await api.del('/company-profile/logo');
      companyLogo.value = '';
      companyInfo.value = { ...companyInfo.value, logo: '' };
      toast('Logo 已刪除', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  /* 背景圖上傳 */
  const onBgUpload = async (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    bgUploading.value = true;
    try {
      const formData = new FormData();
      formData.append('background', file);
      const r = await fetch('/api/company-profile/background', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + api.getToken() },
        body: formData,
      }).then((r: any) => r.json());
      if (r.ok) {
        systemBackground.value = r.systemBackground;
        companyInfo.value = { ...companyInfo.value, background: r.systemBackground };
        toast('背景圖已上傳', 'ok');
      }
      else toast(r.error || '上傳失敗', 'err');
    } catch (e) { toast(e.message, 'err'); }
    finally { bgUploading.value = false; e.target.value = ''; }
  };

  const clearBg = async () => {
    const ok = await confirmDialog('確定清除系統背景圖？');
    if (!ok) return;
    try {
      await api.del('/company-profile/background');
      systemBackground.value = '';
      companyInfo.value = { ...companyInfo.value, background: '' };
      toast('背景圖已清除', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <div>
      <h3 style="margin-bottom:16px">系統外觀</h3>

      {/* 主題切換 */}
      <div class="card" style="margin-bottom:16px">
        <h4 style="margin-top:0;color:#2d5a87">介面主題</h4>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <div
            class={`appearance-option ${theme.value === 'light' ? 'selected' : ''}`}
            style={{
              cursor: 'pointer', padding: '16px', borderRadius: '10px',
              border: theme.value === 'light' ? '2px solid #2d5a87' : '2px solid #e0e0e0',
              background: '#ffffff', minWidth: '160px', textAlign: 'center',
            }}
            onClick={() => selectTheme('light')}
          >
            <div style={{ fontSize: '32px', marginBottom: '8px' }}>☀️</div>
            <div style={{ fontWeight: 600 }}>淺色主題</div>
            <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '4px' }}>明亮清爽</div>
          </div>
          <div
            class={`appearance-option ${theme.value === 'dark' ? 'selected' : ''}`}
            style={{
              cursor: 'pointer', padding: '16px', borderRadius: '10px',
              border: theme.value === 'dark' ? '2px solid #2d5a87' : '2px solid #e0e0e0',
              background: '#1a1a2e', color: '#e0e0e0', minWidth: '160px', textAlign: 'center',
            }}
            onClick={() => selectTheme('dark')}
          >
            <div style={{ fontSize: '32px', marginBottom: '8px' }}>🌙</div>
            <div style={{ fontWeight: 600 }}>深色主題</div>
            <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>低光護眼</div>
          </div>
        </div>
        <div style="margin-top:14px">
          <button class="btn btn-primary" onClick={saveTheme} disabled={loading.value}>
            {loading.value ? '儲存中…' : '儲存主題設定'}
          </button>
        </div>
      </div>

      {/* 公司資訊 */}
      <div class="card" style="margin-bottom:16px">
        <h4 style="margin-top:0;color:#2d5a87">公司資訊</h4>
        <div class="form-grid">
          <div>
            <label class="f">公司名稱</label>
            <input value={companyName.value} onInput={(e: any) => (companyName.value = e.currentTarget.value)}
              placeholder="例如：輔凰商貿" style="width:100%" />
          </div>
          <div><label class="f">公司地址</label><input value={companyAddress.value} onInput={(e: any) => (companyAddress.value = e.currentTarget.value)} placeholder="例如：臺北市信義區…" style="width:100%" /></div><div><label class="f">電話</label><input value={companyPhone.value} onInput={(e: any) => (companyPhone.value = e.currentTarget.value)} placeholder="例如：(02) 2345-6789" style="width:100%" /></div>
          <div><label class="f">公司英文名稱</label><input value={companyNameEn.value} onInput={(e: any) => (companyNameEn.value = e.currentTarget.value)} placeholder="例如：MING JHONG TRADING CO., LTD." style="width:100%" /></div>
          <div><label class="f">公司統編</label><input value={companyTaxId.value} onInput={(e: any) => (companyTaxId.value = e.currentTarget.value)} placeholder="例如：12345678" style="width:100%" /></div>
          <div><label class="f">傳真電話</label><input value={companyFax.value} onInput={(e: any) => (companyFax.value = e.currentTarget.value)} placeholder="例如：(02) 2345-6788" style="width:100%" /></div>
          <div><label class="f">公司網址</label><input value={companyWebsite.value} onInput={(e: any) => (companyWebsite.value = e.currentTarget.value)} placeholder="例如：https://www.example.com" style="width:100%" /></div>
          <div style="display:flex;align-items:flex-end">
            <button class="btn btn-primary" onClick={saveCompanyName}>儲存公司資訊</button>
          </div>
        </div>

        <div style="margin-top:16px;padding-top:14px;border-top:1px dashed #d8dde4"><div style="font-size:11.5px;color:#6b7280;margin-top:8px">公司名稱／英文名稱／統編／地址／電話／傳真會帶入各單據 PDF 表頭；欄位空白時 PDF 對應位置預設為空白。</div>
          <label class="f">公司 Logo</label>
          <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:8px">
            {companyLogo.value ? (
              <img src={companyLogo.value} alt="公司 Logo" style="max-height:64px;max-width:200px;border:1px solid #e0e0e0;border-radius:6px;padding:4px;background:#fff" />
            ) : (
              <span style="color:#9ca3af;font-size:13px">（尚未設定 Logo）</span>
            )}
            <label class="btn btn-secondary" style="cursor:pointer;margin:0">
              {logoUploading.value ? '上傳中…' : '上傳 Logo'}
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
                style="display:none" onChange={onLogoUpload} disabled={logoUploading.value} />
            </label>
            {companyLogo.value && (
              <button class="btn btn-danger" onClick={deleteLogo}>刪除 Logo</button>
            )}
          </div>
          <div style="font-size:11.5px;color:#6b7280;margin-top:6px">
            支援 PNG / JPEG / GIF / WEBP / BMP，最大 5MB。Logo 會顯示在登入頁與側邊欄。
          </div>
        </div>
      </div>

      {/* 系統背景圖 */}
      <div class="card">
        <h4 style="margin-top:0;color:#2d5a87">系統背景圖</h4>
        <div style="margin-bottom:12px">
          {systemBackground.value ? (
            <img src={systemBackground.value} alt="系統背景預覽"
              style="max-width:100%;max-height:180px;border:1px solid #e0e0e0;border-radius:8px" />
          ) : (
            <div style="padding:32px;text-align:center;color:#9ca3af;background:#f8f9fa;border-radius:8px;border:1px dashed #d0d0d0">
              （尚未設定背景圖）
            </div>
          )}
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <label class="btn btn-secondary" style="cursor:pointer;margin:0">
            {bgUploading.value ? '上傳中…' : '上傳背景圖'}
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
              style="display:none" onChange={onBgUpload} disabled={bgUploading.value} />
          </label>
          {systemBackground.value && (
            <button class="btn btn-outline" onClick={clearBg}>清除背景</button>
          )}
        </div>
        <div style="font-size:11.5px;color:#6b7280;margin-top:8px">
          背景圖會顯示在主要內容區域的底層，建議使用低對比度、簡潔的圖片以免影響內容閱讀。
        </div>
      </div>
    </div>
  );
}
SystemAppearance.title = '系統外觀';
