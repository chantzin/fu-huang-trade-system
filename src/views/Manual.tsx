// 操作手冊（外部化 Markdown 動態載入）— 使用者查閱用
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import Markdown from '../ui/Markdown.tsx';

const SECTIONS = [
  { id: '一-系統簡介', title: '一、系統簡介' },
  { id: '二-登入與登出', title: '二、登入與登出' },
  { id: '三-系統地圖與導覽', title: '三、系統地圖與導覽' },
  { id: '四-儀表板', title: '四、儀表板' },
  { id: '五-主檔管理', title: '五、主檔管理' },
  { id: '六-客戶報價單', title: '六、客戶報價單' },
  { id: '七-客戶訂單管理', title: '七、客戶訂單管理' },
  { id: '八-出貨與單據', title: '八、出貨與單據' },
  { id: '九-應收帳款', title: '九、應收帳款' },
  { id: '十-供應商與應付', title: '十、供應商與應付' },
  { id: '十一-表單編輯', title: '十一、表單編輯' },
  { id: '十二-報表分析', title: '十二、報表分析' },
  { id: '十三-電子簽核', title: '十三、電子簽核' },
  { id: '十四-文件驗證', title: '十四、文件驗證' },
  { id: '十五-常見問題', title: '十五、常見問題' },
];

export default function Manual() {
  const active = useSignal('');
  const content = useSignal('');
  const loading = useSignal(true);
  const error = useSignal('');
  const lastModified = useSignal('');

  useEffect(() => {
    api.getManual('operation')
      .then((r: any) => {
        content.value = r.content || '';
        lastModified.value = r.lastModified || '';
        loading.value = false;
      })
      .catch((e: any) => {
        error.value = e.message || '載入失敗';
        loading.value = false;
      });
  }, []);

  const scrollTo = (id: any) => {
    active.value = id;
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const fmtDate = (iso: any) => {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString('zh-TW'); } catch { return iso; }
  };

  return (
    <div style="display:flex;gap:16px;align-items:flex-start">
      {/* 左側目錄 */}
      <div style="flex:0 0 200px;position:sticky;top:16px">
        <div class="card" style="padding:12px">
          <div style="font-weight:700;font-size:14px;margin-bottom:8px;color:#0F766E">操作手冊目錄</div>
          {SECTIONS.map((s: any) => (
            <div onClick={() => scrollTo(s.id)}
              style={`padding:6px 8px;border-radius:6px;cursor:pointer;font-size:13px;${active.value === s.id ? 'background:#ECFDF5;color:#0F766E;font-weight:600' : 'color:#5A6270'}`}
              onMouseOver={(e: any) => (e.currentTarget.style.background = '#F4F6F8')}
              onMouseOut={(e: any) => (e.currentTarget.style.background = active.value === s.id ? '#ECFDF5' : 'transparent')}>
              {s.title}
            </div>
          ))}
        </div>
      </div>
      {/* 右側內容 */}
      <div style="flex:1;min-width:0">
        <div class="card" style="padding:20px 24px">
          <h2 style="font-size:20px;color:#0F766E;margin-bottom:4px">輔凰商貿訂單暨應收帳款系統 — 操作手冊</h2>
          <div style="font-size:12px;color:#98A0AC;margin-bottom:16px">
            外部化 Markdown 版本｜適用對象：全體使用者
            {lastModified.value && `｜最後更新：${fmtDate(lastModified.value)}`}
          </div>
          {loading.value
            ? <div class="empty">手冊載入中…</div>
            : error.value
              ? <div class="empty" style="color:#C0392B">
                  手冊載入失敗：{error.value}
                  <div style="font-size:12px;margin-top:8px;color:#98A0AC">
                    請確認 docs/operation.md 檔案存在於伺服器目錄
                  </div>
                </div>
              : <Markdown source={content.value} />}
        </div>
      </div>
    </div>
  );
}
Manual.title = '操作手冊';
