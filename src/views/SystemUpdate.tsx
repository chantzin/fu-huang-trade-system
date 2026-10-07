// 系統更新（更新包）：檢視目前版本 / 套用歷程，並匯入套用 .mjupd 更新包
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';
import { confirmDialog } from '../ui/Modal.tsx';

function fmtTime(ms: number | null) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-TW', { hour12: false });
}

export default function SystemUpdate() {
  const status = useSignal<any>(null);
  const history = useSignal<any[]>([]);
  const loading = useSignal(true);
  const applying = useSignal(false);
  const result = useSignal<any>(null);
  const fileInput = useSignal<HTMLInputElement | null>(null);

  const load = async () => {
    loading.value = true;
    try {
      const [s, h] = await Promise.all([
        api.get('/system-update/status'),
        api.get('/system-update/history'),
      ]);
      status.value = s;
      history.value = h || [];
    } catch (e: any) {
      toast(e.message || '載入失敗', 'err');
    } finally {
      loading.value = false;
    }
  };

  useEffect(() => { load(); }, []);

  const onPickFile = (e: any) => {
    const f = e.currentTarget.files && e.currentTarget.files[0];
    if (!f) return;
    doApply(f);
    e.currentTarget.value = '';
  };

  const doApply = async (file: File) => {
    const ok = await confirmDialog(
      `即將套用更新包「${file.name}」。\n\n系統會自動：① 整站備份 ② 套用新版本 ③ 重新啟動（約 10 秒）。\n套用期間系統將短暫中斷，確定要繼續嗎？`,
    );
    if (!ok) return;
    applying.value = true;
    result.value = null;
    try {
      const fd = new FormData();
      fd.append('pkg', file, file.name);
      const r: any = await api.post('/system-update/apply', fd);
      result.value = r;
      if (r.ok) {
        toast('更新包已套用，系統重啟中…', 'ok');
        // 等看門狗重生後重新整理，載入新前端
        setTimeout(() => location.reload(), 9000);
      } else {
        toast(r.error || '套用失敗', 'err');
        load();
      }
    } catch (e: any) {
      toast(e.message || '套用失敗', 'err');
      load();
    } finally {
      applying.value = false;
    }
  };

  const s = status.value;

  return (
    <div class="system-update">
      <div class="su-head">
        <div>
          <p class="muted" style="margin:0">分析與管理 · 系統更新（更新包模式）</p>
          <h2 style="margin:4px 0">系統更新</h2>
        </div>
        <button class="btn btn-primary" disabled={applying.value}
          onClick={() => fileInput.value && fileInput.value.click()}>
          {applying.value ? '套用中…' : '匯入並套用更新包'}
        </button>
        <input ref={(el: any) => (fileInput.value = el)} type="file" accept=".mjupd,.zip" style="display:none" onChange={onPickFile} />
      </div>

      {result.value && result.value.ok ? (
        <div class="su-banner ok">
          ✅ 更新包已套用：{result.value.from} → <b>{result.value.to}</b>。<br />
          系統正在重新啟動以載入新版本，約 10 秒後本頁會自動重新整理。
          {result.value.backup ? <><br /><span class="muted">升版前備份：{result.value.backup}</span></> : null}
        </div>
      ) : null}
      {result.value && !result.value.ok ? (
        <div class="su-banner err">❌ {result.value.error}</div>
      ) : null}

      <div class="su-cards">
        <div class="su-card">
          <div class="su-card-label">目前版本</div>
          <div class="su-card-value">{s ? s.version : '…'}</div>
          <div class="muted" style="font-size:12px">{s && s.edition ? s.edition : ''}{s && s.channel ? ` · ${s.channel}` : ''}</div>
        </div>
        <div class="su-card">
          <div class="su-card-label">建置時間</div>
          <div class="su-card-value" style="font-size:15px">{s && s.buildDate ? fmtTime(new Date(s.buildDate).getTime()) : '—'}</div>
        </div>
        <div class="su-card">
          <div class="su-card-label">已套用更新</div>
          <div class="su-card-value">{s ? s.historyCount : '…'} 次</div>
        </div>
        <div class="su-card">
          <div class="su-card-label">上次更新</div>
          <div class="su-card-value" style="font-size:14px">
            {s && s.lastUpdate ? `${s.lastUpdate.fromVersion} → ${s.lastUpdate.toVersion}` : '—'}
          </div>
          <div class="muted" style="font-size:12px">{s && s.lastUpdate ? fmtTime(s.lastUpdate.appliedAt) : ''}</div>
        </div>
      </div>

      <div class="su-note">
        <b>更新包模式說明</b>：日後系統的功能新增或 bug 修正，都會以「更新包（.mjupd）」形式交付。
        更新包由開發端 <code>scripts/build-update-pkg.mjs</code> 產生，您只需在此匯入即可完成升版——
        系統會自動備份現況、套用新版本檔案並重新啟動，過程無須登入伺服器。
      </div>

      <h3>套用歷程</h3>
      {loading.value ? <p class="muted">載入中…</p> : (
        history.value.length === 0 ? <p class="muted">尚無套用紀錄。</p> : (
          <table class="tbl">
            <thead>
              <tr><th>時間</th><th>從</th><th>至</th><th>套用者</th><th>說明</th><th>備份路徑</th></tr>
            </thead>
            <tbody>
              {history.value.map((h: any) => (
                <tr key={h.id}>
                  <td>{fmtTime(h.applied_at)}</td>
                  <td>{h.from_version}</td>
                  <td>{h.to_version}</td>
                  <td>{h.operator}</td>
                  <td>{h.description}</td>
                  <td class="muted" style="font-size:12px">{h.backup_path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </div>
  );
}

SystemUpdate.title = '系統更新';
