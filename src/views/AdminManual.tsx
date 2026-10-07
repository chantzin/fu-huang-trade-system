// 管理者手冊（外部化 Markdown 動態載入）— 系統管理者查閱用
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import Markdown from '../ui/Markdown.tsx';

const SECTIONS = [
  { id: '一-管理者角色與權限', title: '一、管理者角色與權限' },
  { id: '二-使用者管理', title: '二、使用者管理' },
  { id: '三-參數設定', title: '三、參數設定' },
  { id: '四-匯率歷程', title: '四、匯率歷程' },
  { id: '五-帳期規則設定', title: '五、帳期規則設定' },
  { id: '六-電子簽核流程設定', title: '六、電子簽核流程設定' },
  { id: '七-excel-匯入', title: '七、Excel 匯入' },
  { id: '八-郵件設定', title: '八、郵件設定' },
  { id: '九-系統外觀', title: '九、系統外觀' },
  { id: '十-操作日誌與審計', title: '十、操作日誌與審計' },
  { id: '十一-文件防偽與密鑰輪替', title: '十一、文件防偽與密鑰輪替' },
  { id: '十二-系統備份與還原', title: '十二、系統備份與還原' },
  { id: '十三-常見問題', title: '十三、常見問題' },
];

export default function AdminManual() {
  const active = useSignal('');
  const content = useSignal('');
  const loading = useSignal(true);
  const error = useSignal('');
  const lastModified = useSignal('');

  useEffect(() => {
    api.getManual('admin')
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
          <div style="font-weight:700;font-size:14px;margin-bottom:8px;color:#0F766E">管理者手冊目錄</div>
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
          <h2 style="font-size:20px;color:#0F766E;margin-bottom:4px">輔凰商貿訂單暨應收帳款系統 — 管理者手冊</h2>
          <div style="font-size:12px;color:#98A0AC;margin-bottom:16px">
            外部化 Markdown 版本｜適用對象：系統管理者 / 主管
            {lastModified.value && `｜最後更新：${fmtDate(lastModified.value)}`}
          </div>
          {loading.value
            ? <div class="empty">手冊載入中…</div>
            : error.value
              ? <div class="empty" style="color:#C0392B">
                  手冊載入失敗：{error.value}
                  <div style="font-size:12px;margin-top:8px;color:#98A0AC">
                    請確認 docs/admin.md 檔案存在於伺服器目錄
                  </div>
                </div>
              : <Markdown source={content.value} />}
        </div>
      </div>
    </div>
  );
}
AdminManual.title = '管理者手冊';
