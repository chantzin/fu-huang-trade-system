// 系統備份：手動/自動備份、過期自動清理、異地備份、系統還原（參照 HR 行政管理中心）
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';
import Table from '../ui/Table.tsx';
import Pagination from '../ui/Pagination.tsx';
import { confirmDialog } from '../ui/Modal.tsx';
import { esc } from '../ui/format.ts';

function fmtTime(ms: number | null) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString('zh-TW', { hour12: false });
}
function fmtSize(b: number) {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}

export default function SystemBackup() {
  const loading = useSignal(true);
  const backingUp = useSignal(false);

  // 自動備份
  const autoEnabled = useSignal(false);
  const autoInterval = useSignal(1);
  const autoLast = useSignal<string | null>(null);
  const autoNext = useSignal<string | null>(null);

  // 自動清理
  const cleanEnabled = useSignal(false);
  const cleanDays = useSignal(30);
  const cleanCount = useSignal(0);
  const cleanLast = useSignal<string | null>(null);
  const cleanNext = useSignal<string | null>(null);

  // 雲端／異地備份目標（P0 解耦 OneDrive 寫死，多目標清單）
  const targetsList = useSignal<any[]>([]);
  const newTargetType = useSignal('localfolder');
  const newTargetName = useSignal('');
  const newTargetPath = useSignal('');
  const newTargetKeep = useSignal(0);
  const targetFiles = useSignal<Record<string, any>>({});
  const editing = useSignal<Record<string, any>>({});

  // 備份清單
  const list = useSignal<any[]>([]);
  const selected = useSignal<Set<string>>(new Set());
  const restoreFile = useSignal<File | null>(null);
  const restoring = useSignal(false);
  const page = useSignal(1);
  const pageSize = useSignal(10);
  const paged = list.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value);

  // 維運支援工具（H2/H4/M2）
  const diagLoading = useSignal(false);
  const drillLoading = useSignal(false);
  const drillResult = useSignal<any>(null);
  const vacuumLoading = useSignal(false);
  const vacuumResult = useSignal<any>(null);

  const doDownloadDiag = async () => {
    diagLoading.value = true;
    try { await api.downloadDiagnostics(); toast('診斷包已開始下載', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
    finally { diagLoading.value = false; }
  };
  const doRestoreDrill = async () => {
    drillLoading.value = true; drillResult.value = null;
    try {
      const r = await api.restoreDrill();
      drillResult.value = r;
      toast(r.pass ? '還原演練通過（備份可完整還原）' : '還原演練發現不一致', r.pass ? 'ok' : 'warn');
    } catch (e) { toast(e.message, 'err'); }
    finally { drillLoading.value = false; }
  };
  const doVacuum = async () => {
    vacuumLoading.value = true; vacuumResult.value = null;
    try {
      const r = await api.vacuumDb();
      vacuumResult.value = r;
      toast('VACUUM 完成，釋出 ' + fmtSize(r.reclaimedBytes), 'ok');
    } catch (e) { toast(e.message, 'err'); }
    finally { vacuumLoading.value = false; }
  };

  const loadAll = async () => {
    loading.value = true;
    try {
      const [cfg, cc, backups, targets] = await Promise.all([
        api.get('/backup/config'),
        api.get('/backup/cleanup-config'),
        api.get('/backup'),
        api.get('/cloud-backup/targets'),
      ]);
      autoEnabled.value = !!cfg.enabled;
      autoInterval.value = cfg.intervalDays || 1;
      autoLast.value = cfg.lastRun || null;
      autoNext.value = cfg.nextRun || null;
      cleanEnabled.value = !!cc.enabled;
      cleanDays.value = cc.retentionDays || 0;
      cleanCount.value = cc.retentionCount || 0;
      cleanLast.value = cc.lastRun || null;
      cleanNext.value = cc.nextRun || null;
      list.value = backups;
      targetsList.value = Array.isArray(targets) ? targets : [];
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      loading.value = false;
    }
  };
  useEffect(() => { loadAll(); }, []);

  const doBackup = async () => {
    backingUp.value = true;
    try {
      const r = await api.post('/backup');
      toast('備份完成：' + r.name, 'ok');
      loadAll();
    } catch (e) { toast(e.message, 'err'); }
    finally { backingUp.value = false; }
  };

  const saveAuto = async () => {
    try {
      await api.post('/backup/config', { enabled: autoEnabled.value, intervalDays: autoInterval.value });
      toast('自動備份設定已儲存', 'ok');
      loadAll();
    } catch (e) { toast(e.message, 'err'); }
  };

  const saveCleanup = async () => {
    try {
      await api.post('/backup/cleanup-config', { enabled: cleanEnabled.value, retentionDays: cleanDays.value, retentionCount: cleanCount.value });
      toast('自動清理設定已儲存', 'ok');
      loadAll();
    } catch (e) { toast(e.message, 'err'); }
  };

  const runCleanup = async () => {
    try {
      const r = await api.post('/backup/cleanup');
      toast(r.deleted.length ? '已清理 ' + r.deleted.length + ' 個過期備份' : '沒有需要清理的備份', 'ok');
      loadAll();
    } catch (e) { toast(e.message, 'err'); }
  };

  /* ── 雲端／異地目標（P0 解耦 OneDrive 寫死，多目標）── */
  const addTarget = async () => {
    try {
      if (newTargetType.value !== 'localfolder') { toast('此類型需 P1/P2/P3 憑證，暫不開放新增', 'warn'); return; }
      await api.post('/cloud-backup/targets', {
        type: 'localfolder',
        name: newTargetName.value || '本機資料夾',
        remote_path: newTargetPath.value,
        keep_count: newTargetKeep.value,
      });
      toast('已新增備份目標', 'ok');
      newTargetName.value = ''; newTargetPath.value = ''; newTargetKeep.value = 0;
      loadAll();
    } catch (e) { toast(e.message, 'err'); }
  };

  const toggleTarget = async (t: any, enabled: boolean) => {
    try {
      await api.put('/cloud-backup/targets/' + t.id, { enabled });
      targetsList.value = targetsList.value.map((x: any) => x.id === t.id ? { ...x, enabled } : x);
    } catch (e) { toast(e.message, 'err'); }
  };

  const startEdit = (t: any) => {
    editing.value = { ...editing.value, [t.id]: { active: true, name: t.name, remote_path: t.remote_path, keep_count: t.keep_count || 0 } };
  };
  const updateDraft = (id: string, k: string, v: any) => {
    const d = { ...editing.value }; d[id] = { ...d[id], [k]: v }; editing.value = d;
  };
  const cancelEdit = (id: string) => {
    const d = { ...editing.value }; delete d[id]; editing.value = d;
  };
  const saveTarget = async (t: any) => {
    const ed = editing.value[t.id]; if (!ed) return;
    try {
      await api.put('/cloud-backup/targets/' + t.id, { name: ed.name, remote_path: ed.remote_path, keep_count: ed.keep_count });
      toast('目標已更新', 'ok'); cancelEdit(t.id); loadAll();
    } catch (e) { toast(e.message, 'err'); }
  };

  const deleteTarget = async (t: any) => {
    const ok = await confirmDialog(`確定刪除備份目標「${t.name}」？此操作不可復原。`);
    if (!ok) return;
    try { await api.del('/cloud-backup/targets/' + t.id); toast('目標已刪除', 'ok'); loadAll(); }
    catch (e) { toast(e.message, 'err'); }
  };

  const testTarget = async (t: any) => {
    try {
      const r = await api.post('/cloud-backup/targets/' + t.id + '/test');
      toast(r.message || (r.ok ? '連線測試通過' : '測試失敗'), r.ok ? 'ok' : 'warn');
      loadAll();
    } catch (e) { toast(e.message, 'err'); }
  };
  const syncTarget = async (t: any) => {
    try {
      const r = await api.post('/cloud-backup/targets/' + t.id + '/sync');
      toast('同步完成：新增 ' + (r.copied || 0) + '、失敗 ' + ((r.failed || []).length), 'ok');
      loadAll();
    } catch (e) { toast(e.message, 'err'); }
  };
  const listTargetFiles = async (t: any) => {
    try {
      const r = await api.get('/cloud-backup/targets/' + t.id + '/list');
      targetFiles.value = { ...targetFiles.value, [t.id]: r };
    } catch (e) { toast(e.message, 'err'); }
  };
  const deleteTargetFile = async (t: any, name: string) => {
    const ok = await confirmDialog(`確定從目標刪除備份檔「${name}」？`);
    if (!ok) return;
    try { await api.del('/cloud-backup/targets/' + t.id + '/file/' + encodeURIComponent(name)); toast('已刪除', 'ok'); listTargetFiles(t); }
    catch (e) { toast(e.message, 'err'); }
  };

  const delBackup = async (name: string) => {
    const ok = await confirmDialog(`確定刪除備份「${name}」？此操作不可復原。`);
    if (!ok) return;
    try { await api.del('/backup/' + encodeURIComponent(name)); toast('備份已刪除', 'ok'); loadAll(); }
    catch (e) { toast(e.message, 'err'); }
  };

  const toggleSelect = (name: string) => {
    const s = new Set(selected.value);
    if (s.has(name)) s.delete(name); else s.add(name);
    selected.value = s;
  };
  const toggleSelectAll = () => {
    selected.value = selected.value.size === list.value.length
      ? new Set()
      : new Set(list.value.map((b: any) => b.name));
  };
  const bulkDelete = async () => {
    if (!selected.value.size) return;
    const ok = await confirmDialog(`確定批量刪除 ${selected.value.size} 個備份檔？此操作不可復原。`);
    if (!ok) return;
    try {
      const r = await api.post('/backup/bulk-delete', { names: Array.from(selected.value) });
      toast('已刪除 ' + r.deleted.length + ' 個備份檔' + (r.failed.length ? '，失敗 ' + r.failed.length + ' 個' : ''), 'ok');
      loadAll();
    } catch (e) { toast(e.message, 'err'); }
  };

  const doRestore = async () => {
    let confirmMsg = '⚠️ 還原會先清空系統內所有現有資料，再依備份重建。此操作不可復原，確定繼續？';
    if (restoreFile.value) confirmMsg = '⚠️ 將以上傳檔案還原系統（清空現有資料）。確定繼續？';
    const ok = await confirmDialog(confirmMsg);
    if (!ok) return;
    restoring.value = true;
    try {
      let r: any;
      if (restoreFile.value) {
        const fd = new FormData();
        fd.append('file', restoreFile.value);
        fd.append('confirm', 'true');
        r = await api.post('/backup/restore', fd);
      } else {
        const names = Array.from(selected.value);
        if (names.length !== 1) return toast('請選取 1 個備份檔，或上傳備份檔', 'warn');
        r = await api.post('/backup/restore', { filename: names[0], confirm: true });
      }
      toast('還原完成：' + r.tables + ' 張表已重建', 'ok');
      loadAll();
    } catch (e) { toast(e.message, 'err'); }
    finally { restoring.value = false; }
  };

  const backupsCols = [
    { key: 'name', label: '備份檔名', render: (r: any) => `<b>${esc(r.name)}</b>` },
    { key: 'size', label: '大小', render: (r: any) => fmtSize(r.size) },
    { key: 'type', label: '類型', render: (r: any) => (r.type === 'auto' ? '自動' : '手動') },
    { key: 'mtime', label: '建立時間', render: (r: any) => fmtTime(r.mtime) },
  ];

  return (
    <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0">系統備份</h3>
        <button class="btn btn-primary" onClick={doBackup} disabled={backingUp.value}>
          {backingUp.value ? '備份中…' : '＋ 立即備份'}
        </button>
      </div>

      {loading.value && <div class="calc-note">載入中…</div>}

      {/* 自動備份 */}
      <div class="card" style="padding:14px 16px;margin-bottom:12px">
        <h4 style="margin:0 0 8px">自動備份</h4>
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px">
            <input type="checkbox" checked={autoEnabled.value} onChange={(e: any) => (autoEnabled.value = e.currentTarget.checked)} />
            啟用自動備份
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px">
            備份週期（天）
            <input type="number" min="1" value={autoInterval.value} style="width:80px"
              onInput={(e: any) => (autoInterval.value = Math.max(1, Number(e.currentTarget.value) || 1))} />
          </label>
          <span style="font-size:12px;color:#6b7280">
            上次：{fmtTime(autoLast.value ? new Date(autoLast.value).getTime() : null)}
            ｜ 下次：{fmtTime(autoNext.value ? new Date(autoNext.value).getTime() : null)}
          </span>
          <button class="btn btn-sm btn-primary" onClick={saveAuto}>儲存設定</button>
        </div>
      </div>

      {/* 自動清理 */}
      <div class="card" style="padding:14px 16px;margin-bottom:12px">
        <h4 style="margin:0 0 8px">備份自動清理（過期自動刪除）</h4>
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px">
            <input type="checkbox" checked={cleanEnabled.value} onChange={(e: any) => (cleanEnabled.value = e.currentTarget.checked)} />
            啟用自動清理
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px">
            保留天數（0 = 不限制）
            <input type="number" min="0" value={cleanDays.value} style="width:80px"
              onInput={(e: any) => (cleanDays.value = Math.max(0, Number(e.currentTarget.value) || 0))} />
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px">
            保留數量（0 = 不限制）
            <input type="number" min="0" value={cleanCount.value} style="width:80px"
              onInput={(e: any) => (cleanCount.value = Math.max(0, Number(e.currentTarget.value) || 0))} />
          </label>
          <span style="font-size:12px;color:#6b7280">
            上次：{fmtTime(cleanLast.value ? new Date(cleanLast.value).getTime() : null)}
            ｜ 下次：{fmtTime(cleanNext.value ? new Date(cleanNext.value).getTime() : null)}
          </span>
          <button class="btn btn-sm btn-primary" onClick={saveCleanup}>儲存設定</button>
          <button class="btn btn-sm" onClick={runCleanup}>立即清理</button>
        </div>
        <div class="calc-note" style="margin-top:8px;font-size:12px">💡 任一條件符合即刪除（保留天數或保留數量）。</div>
      </div>

      {/* 雲端／異地備份目標（P0 解耦 OneDrive 寫死，多目標清單） */}
      <div class="card" style="padding:14px 16px;margin-bottom:12px">
        <h4 style="margin:0 0 4px">雲端／異地備份目標</h4>
        <div class="calc-note" style="font-size:12px;margin-bottom:10px">
          💡 可新增多個<strong>本機／網路資料夾</strong>目標（如 <code>C:\TradeBackup</code>、<code>\\nas\share\tradebackup</code>、OneDrive 同步資料夾）。
          備份完成後自動同步到所有「啟用」的本機資料夾目標。Google 雲端硬碟 / OneDrive / WebDAV / S3 於 P1/P2/P3 接妥憑證後開放。
        </div>

        {/* 新增目標表單 */}
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px;padding:10px;background:#f8fafc;border-radius:8px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:12px">
            類型
            <select value={newTargetType.value} onChange={(e: any) => (newTargetType.value = e.currentTarget.value)} style="padding:6px 8px">
              <option value="localfolder">本機／網路資料夾</option>
              <option value="googledrive" disabled>Google 雲端硬碟（P1 待憑證）</option>
              <option value="onedrive" disabled>OneDrive（P2 待憑證）</option>
              <option value="webdav" disabled>WebDAV（P3）</option>
              <option value="s3" disabled>S3（P3）</option>
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;flex:1;min-width:160px">
            名稱
            <input type="text" value={newTargetName.value} placeholder="例如：NAS 異地備份"
              onInput={(e: any) => (newTargetName.value = e.currentTarget.value)} style="padding:6px 8px" />
          </label>
          {newTargetType.value === 'localfolder' && (
            <label style="display:flex;flex-direction:column;gap:4px;font-size:12px;flex:2;min-width:240px">
              資料夾路徑
              <input type="text" value={newTargetPath.value} placeholder="C:\TradeBackup 或 \\nas\share\tradebackup"
                onInput={(e: any) => (newTargetPath.value = e.currentTarget.value)} style="padding:6px 8px" />
            </label>
          )}
          {newTargetType.value !== 'localfolder' && (
            <div style="font-size:12px;color:#b45309;align-self:center">此類型需 P1/P2/P3 憑證，暫不開放新增</div>
          )}
          <label style="display:flex;flex-direction:column;gap:4px;font-size:12px">
            保留份數
            <input type="number" min="0" value={newTargetKeep.value} style="width:80px;padding:6px 8px"
              onInput={(e: any) => (newTargetKeep.value = Math.max(0, Number(e.currentTarget.value) || 0))} />
          </label>
          <button class="btn btn-sm btn-primary" disabled={newTargetType.value !== 'localfolder'} onClick={addTarget}>＋ 新增目標</button>
        </div>

        {/* 目標清單 */}
        {targetsList.value.length === 0 && <div class="calc-note">尚無備份目標。新增一個本機／網路資料夾以啟用異地備份。</div>}
        {targetsList.value.map((t: any) => {
          const ed = editing.value[t.id];
          const files = targetFiles.value[t.id];
          return (
            <div key={t.id} style="border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:10px">
              <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
                <span style={"font-size:11px;padding:2px 8px;border-radius:999px;" + (t.type === 'localfolder' ? 'background:#dcfce7;color:#157347' : 'background:#fef3c7;color:#92400e')}>
                  {t.type === 'localfolder' ? '本機/網路資料夾' : t.type}
                </span>
                <b>{esc(t.name)}</b>
                <label style="display:flex;align-items:center;gap:4px;font-size:12px">
                  <input type="checkbox" checked={!!t.enabled} onChange={(e: any) => toggleTarget(t, e.currentTarget.checked)} />
                  啟用
                </label>
                <span style="font-size:12px;color:#6b7280">
                  上次：{fmtTime(t.last_run ? new Date(t.last_run).getTime() : null)}
                  ｜ 狀態：<b class={t.last_status === 'error' ? 'text-danger' : ''}>{t.last_status === 'error' ? '失敗：' + esc(t.last_error || '') : (t.last_status || '—')}</b>
                </span>
                <div style="margin-left:auto;display:flex;gap:6px">
                  <button class="btn btn-sm" onClick={() => testTarget(t)}>測試</button>
                  <button class="btn btn-sm btn-primary" onClick={() => syncTarget(t)}>立即同步</button>
                  <button class="btn btn-sm" onClick={() => listTargetFiles(t)}>檔案</button>
                  <button class="btn btn-sm" onClick={() => startEdit(t)}>編輯</button>
                  <button class="btn btn-sm btn-danger" onClick={() => deleteTarget(t)}>刪除</button>
                </div>
              </div>
              <div style="font-size:12px;color:#6b7280;margin-top:4px">
                路徑：<code>{esc(t.remote_path || '—')}</code> ｜ 保留 {t.keep_count || 0} 份
              </div>
              {ed && ed.active && (
                <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:8px;background:#f8fafc;border-radius:8px">
                  <input type="text" value={ed.name} placeholder="名稱" style="padding:4px 8px"
                    onInput={(e: any) => updateDraft(t.id, 'name', e.currentTarget.value)} />
                  <input type="text" value={ed.remote_path} placeholder="資料夾路徑" style="flex:1;min-width:200px;padding:4px 8px"
                    onInput={(e: any) => updateDraft(t.id, 'remote_path', e.currentTarget.value)} />
                  <input type="number" min="0" value={ed.keep_count} style="width:70px;padding:4px 8px"
                    onInput={(e: any) => updateDraft(t.id, 'keep_count', Number(e.currentTarget.value) || 0)} />
                  <button class="btn btn-sm btn-primary" onClick={() => saveTarget(t)}>儲存</button>
                  <button class="btn btn-sm" onClick={() => cancelEdit(t.id)}>取消</button>
                </div>
              )}
              {files && (
                <div style="margin-top:8px">
                  <div style="font-size:12px;color:#6b7280;margin-bottom:4px">目標內備份檔</div>
                  {files.files && files.files.length === 0 && <div class="calc-note">（無）</div>}
                  {files.files && files.files.map((f: any) => (
                    <div key={f.name} style="display:flex;gap:8px;align-items:center;font-size:12px;padding:2px 0">
                      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{esc(f.name)}</span>
                      <span style="color:#6b7280">{fmtSize(f.size)}</span>
                      <button class="btn btn-sm btn-danger" onClick={() => deleteTargetFile(t, f.name)}>刪除</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 系統還原 */}
      <div class="card card-danger" style="padding:14px 16px">
        <h4 style="margin:0 0 4px">系統還原</h4>
        <div class="calc-note" style="font-size:12px;margin-bottom:10px">
          ⚠️ 還原會<strong>先清空系統內所有現有資料</strong>，再依所選備份重建。此操作不可復原，請謹慎使用。
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px">
            <input type="checkbox" checked={selected.value.size === list.value.length && list.value.length > 0}
              onChange={toggleSelectAll} /> 全選
          </label>
          <button class="btn btn-sm btn-danger" disabled={!selected.value.size} onClick={bulkDelete}>批量刪除</button>
          <label class="btn btn-sm" style="margin:0">
            上傳備份檔
            <input type="file" accept=".json,application/json" style="display:none"
              onChange={(e: any) => (restoreFile.value = e.currentTarget.files && e.currentTarget.files[0] ? e.currentTarget.files[0] : null)} />
          </label>
          {restoreFile.value && <span style="font-size:12px;color:#6b7280">已選上傳檔：{esc(restoreFile.value.name)}</span>}
        </div>
        <Table
          columns={[
            { key: '__sel', label: '', render: (r: any) => (
              `<input type="checkbox" ${selected.value.has(r.name) ? 'checked' : ''} />`
            ) },
            ...backupsCols,
          ]}
          rows={paged}
          loading={loading.value}
          actions={(r: any) => (
            <div style="display:flex;gap:6px;white-space:nowrap">
              <button class="btn btn-sm" onClick={() => toggleSelect(r.name)}>
                {selected.value.has(r.name) ? '取消選取' : '選取'}
              </button>
              <button class="btn btn-sm" onClick={() => { restoreFile.value = null; selected.value = new Set([r.name]); doRestore(); }}>還原此檔</button>
              <button class="btn btn-sm btn-danger" onClick={() => delBackup(r.name)}>刪除</button>
            </div>
          )}
        />
        {list.value.length === 0 && !loading.value && <div class="calc-note" style="margin-top:8px">尚無備份檔，請先執行備份</div>}
        <Pagination
          total={list.value.length}
          page={page.value}
          pageSize={pageSize.value}
          onPageChange={(p: any) => (page.value = p)}
          onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }}
        />
        <div style="margin-top:10px">
          <button class="btn btn-danger" disabled={restoring.value} onClick={doRestore}>
            {restoring.value ? '還原中…' : (selected.value.size === 1 && !restoreFile.value ? '還原所選備份' : '還原所選 / 上傳檔')}
          </button>
        </div>
      </div>

      {/* 維運支援工具（H2 還原演練 / H4 診斷包 / M2 VACUUM） */}
      <div class="card" style="padding:14px 16px;margin-top:12px">
        <h4 style="margin:0 0 4px">維運支援工具</h4>
        <div class="calc-note" style="font-size:12px;margin-bottom:10px">
          一鍵產出支援診斷包、執行非破壞性還原演練（驗證備份可完整還原）、或執行 SQLite VACUUM 釋出閒置空間。
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <button class="btn btn-sm btn-primary" disabled={diagLoading.value} onClick={doDownloadDiag}>
            {diagLoading.value ? '產生中…' : '⬇ 下載支援診斷包'}
          </button>
          <button class="btn btn-sm" disabled={drillLoading.value} onClick={doRestoreDrill}>
            {drillLoading.value ? '演練中…' : '執行還原演練'}
          </button>
          <button class="btn btn-sm" disabled={vacuumLoading.value} onClick={doVacuum}>
            {vacuumLoading.value ? '執行中…' : '執行資料庫 VACUUM'}
          </button>
        </div>
        {drillResult.value && (
          <div style={"font-size:12px;margin-top:10px;padding:8px 10px;border-radius:8px;" + (drillResult.value.pass ? 'background:#dcfce7;color:#157347' : 'background:#fee2e2;color:#b42318')}>
            {drillResult.value.pass ? '✅ 還原演練通過' : '⚠️ 還原演練發現不一致'}：
            來源備份 <b>{esc(drillResult.value.source || '—')}</b>，還原表數 <b>{drillResult.value.tables}</b>
            {drillResult.value.mismatches && drillResult.value.mismatches.length ? '，不一致：' + drillResult.value.mismatches.map((m: any) => `${esc(m.table)}(${m.expected}≠${m.got})`).join('、') : ''}
          </div>
        )}
        {vacuumResult.value && (
          <div style="font-size:12px;margin-top:10px;padding:8px 10px;border-radius:8px;background:#e0f2fe;color:#0369a1">
            ✅ VACUUM 完成：{fmtSize(vacuumResult.value.beforeBytes)} → {fmtSize(vacuumResult.value.afterBytes)}（釋出 {fmtSize(vacuumResult.value.reclaimedBytes)}）
          </div>
        )}
      </div>
    </div>
  );
}
SystemBackup.title = '系統備份';
