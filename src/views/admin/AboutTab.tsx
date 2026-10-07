// 系統資訊 Tab（系統管理）
import { user, companyInfo } from '../../store.ts';
import { field, input } from '../../ui/form.ts';
import { ROLES } from './shared.ts';

export default function AboutTab({ meta }: any) {
  const m = meta || {};
  // 從全域 companyInfo 讀取，與「系統外觀」頁面即時同步
  const theme = document.documentElement.getAttribute('data-theme') || 'light';

  return (
    <div>
      <div class="card"><h3>系統資訊</h3>
        <div class="form-grid">
          <div dangerouslySetInnerHTML={{ __html: field('系統名稱', input('_', m.appName, 'disabled')) }} />
          <div dangerouslySetInnerHTML={{ __html: field('公司名稱', input('_', companyInfo.value.name || '（未設定）', 'disabled')) }} />
          <div dangerouslySetInnerHTML={{ __html: field('目前主題', input('_', theme === 'dark' ? '深色主題' : '淺色主題', 'disabled')) }} />
          <div dangerouslySetInnerHTML={{ __html: field('本位幣', input('_', m.base, 'disabled')) }} />
          <div dangerouslySetInnerHTML={{ __html: field('支援幣別', input('_', (m.currencies || []).join(' / '), 'disabled')) }} />
          <div dangerouslySetInnerHTML={{ __html: field('帳期推導規則', input('_', m.arBasis === 'month_end' ? '結帳月底 + 月結天數' : '次月 1 日 + (天數-1)', 'disabled')) }} />
          <div dangerouslySetInnerHTML={{ __html: field('登入帳號', input('_', user.value?.empId, 'disabled')) }} />
          <div dangerouslySetInnerHTML={{ __html: field('目前角色', input('_', ROLES[user.value?.role] || user.value?.role, 'disabled')) }} />
        </div>
        <div class="calc-note" style="margin-top:14px">
          🔒 帳號識別一律使用「工號」，與 HR 帳號體系一致。<br />
          本系統為獨立系統，可單獨安裝使用；<code>config.json</code> 的 <code>auth.provider</code>
          由 <code>local</code> 改為 <code>shared</code> 即可與 HR 共用帳密（切換不改任何路由與 token 結構）。
        </div>
      </div>

      <div class="card" style="margin-top:16px"><h3>系統外觀設定（與「系統外觀」頁面同步）</h3>
        <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start">
          <div style="flex:1;min-width:200px">
            <div class="muted" style="font-size:12.5px;margin-bottom:6px">公司 Logo</div>
            {companyInfo.value.logo ? (
              <img src={companyInfo.value.logo} alt="公司 Logo" style="max-height:80px;max-width:200px;border:1px solid var(--line);border-radius:8px;padding:8px;background:#fff" />
            ) : (
              <div style="color:var(--muted);font-size:13px;padding:20px;border:1px dashed var(--line);border-radius:8px;text-align:center">未上傳 Logo</div>
            )}
          </div>
          <div style="flex:1;min-width:200px">
            <div class="muted" style="font-size:12.5px;margin-bottom:6px">系統背景圖</div>
            {companyInfo.value.background ? (
              <img src={companyInfo.value.background} alt="系統背景圖" style="max-height:80px;max-width:200px;border:1px solid var(--line);border-radius:8px;padding:4px;background:#fff;object-fit:cover" />
            ) : (
              <div style="color:var(--muted);font-size:13px;padding:20px;border:1px dashed var(--line);border-radius:8px;text-align:center">未上傳背景圖</div>
            )}
          </div>
        </div>
        <div class="calc-note" style="margin-top:12px">
          💡 公司名稱、Logo、背景圖、主題請至「系統外觀」頁面修改，修改後此處自動同步更新。
        </div>
      </div>
    </div>
  );
}
