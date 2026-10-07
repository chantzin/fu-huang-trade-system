// 文件驗證 — 指紋查驗與 PDF 防竄改驗證（分析與管理）
//
// 三種查驗途徑：
//   1) 單據頁尾的「文件指紋」（16 碼）→ 查系統列印紀錄
//   2) 直接輸入單號
//   3) 選擇 PDF 檔 → 於瀏覽器本機算 SHA-256 → 比對系統留存雜湊（檔案不會上傳）
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';
import Table from '../ui/Table.tsx';
import { esc } from '../ui/format.ts';
import { sha256HexOfFile } from '../ui/sha256.ts';

const SOURCE_LABEL: any = { single: '系統列印', batch: '批次列印', email: 'Email 附件' };
const PAGE_SIZE = 20;

/** 讀取 hash 中的 query（供掃 QR 直連 #/doc-verify?q=<指紋> 自動查驗） */
function readQuery(): string {
  try {
    const h = location.hash || '';
    const i = h.indexOf('?');
    return i < 0 ? '' : (new URLSearchParams(h.slice(i + 1)).get('q') || '');
  } catch { return ''; }
}

export default function DocVerify() {
  const q = useSignal(readQuery());
  const busy = useSignal(false);
  const result = useSignal<any>(null);

  const fileBusy = useSignal(false);
  const fileResult = useSignal<any>(null);
  const fileName = useSignal('');
  const fileSha = useSignal('');

  const rows = useSignal<any[]>([]);
  const total = useSignal(0);
  const listBusy = useSignal(false);
  const fType = useSignal('');
  const fKw = useSignal('');
  const page = useSignal(1);

  const docTypes = useSignal<any[]>([]);
  const stats = useSignal<any>(null);

  const loadList = async (p = 1) => {
    listBusy.value = true;
    try {
      const r = await api.get('/fingerprints', {
        type: fType.value, q: fKw.value, limit: PAGE_SIZE, offset: (p - 1) * PAGE_SIZE,
      });
      rows.value = r.items || [];
      total.value = r.total || 0;
      page.value = p;
    } catch (e: any) { toast(e.message, 'err'); }
    finally { listBusy.value = false; }
  };

  const loadStats = async () => {
    try { stats.value = await api.get('/fingerprints/stats'); } catch { /* ignore */ }
  };

  const verify = async (val?: string) => {
    const v = String(val ?? q.value).trim();
    if (!v) { toast('請輸入指紋、PDF 雜湊或單號', 'warn'); return; }
    q.value = v;
    busy.value = true;
    try { result.value = await api.get('/fingerprints/verify', { q: v }); }
    catch (e: any) { toast(e.message, 'err'); result.value = null; }
    finally { busy.value = false; }
  };

  const verifyFile = async (f: any) => {
    if (!f) return;
    fileBusy.value = true; fileResult.value = null; fileName.value = f.name; fileSha.value = '';
    try {
      const sha = await sha256HexOfFile(f);
      fileSha.value = sha;
      const r = await api.post('/fingerprints/verify', { sha256: sha });
      fileResult.value = r;
      toast(r.found ? '此 PDF 為系統原始產出，內容未被竄改' : '查無此 PDF 的產出紀錄', r.found ? 'ok' : 'warn');
    } catch (e: any) { toast(e.message, 'err'); }
    finally { fileBusy.value = false; }
  };

  useEffect(() => {
    const q0 = readQuery();
    if (q0) verify(q0);
    api.get('/fingerprints/doc-types').then((r: any) => { docTypes.value = r.items || []; }).catch(() => {});
    loadStats();
    loadList(1);
  }, []);

  const pages = Math.max(1, Math.ceil(total.value / PAGE_SIZE));

  const columns = [
    { key: 'created_at', label: '列印時間' },
    { key: 'doc_label', label: '單據別' },
    { key: 'doc_no', label: '單號', render: (r: any) => esc(r.doc_no || '-') },
    { key: 'fp', label: '文件指紋', render: (r: any) => `<code style="font-size:12px">${esc(r.fp)}</code>` },
    { key: 'sha_short', label: 'PDF 雜湊（前 16）', render: (r: any) => `<code style="font-size:11.5px;color:#6b7280">${esc(r.sha_short || '-')}</code>` },
    { key: 'pages', label: '頁數' },
    { key: 'generated_by_name', label: '列印人', render: (r: any) => esc(r.generated_by_name || '-') },
    { key: 'source', label: '來源', render: (r: any) => SOURCE_LABEL[r.source] || r.source || '-' },
    {
      key: 'secret_match', label: '密鑰',
      render: (r: any) => (r.secret_match === false
        ? '<span class="tag t-gray">舊密鑰</span>'
        : '<span class="tag t-green">現行</span>'),
    },
  ];

  return (
    <>
      {/* 單據指紋查驗 */}
      <div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:14px;background:#fff">
        <div style="font-weight:700;font-size:14px;margin-bottom:6px">🔍 單據指紋查驗</div>
        <div style="font-size:12.5px;color:#6b7280;margin-bottom:10px">
          輸入單據頁尾的「文件指紋」（16 碼）、PDF 檔案的 SHA-256（64 碼），或直接輸入單號。
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <input value={q.value} onInput={(e: any) => (q.value = e.currentTarget.value)}
            onKeyDown={(e: any) => { if (e.key === 'Enter') verify(); }}
            placeholder="例如 9280500e3f9d1b30 / 64 碼雜湊 / QT2026090001"
            style="flex:1;min-width:260px" />
          <button class="btn btn-primary" disabled={busy.value} onClick={() => verify()}>
            {busy.value ? '查驗中…' : '查驗'}
          </button>
        </div>
        {result.value && <VerifyResult r={result.value} />}
      </div>

      {/* PDF 檔案防竄改驗證 */}
      <div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:14px;background:#fff">
        <div style="font-weight:700;font-size:14px;margin-bottom:6px">📄 PDF 檔案防竄改驗證</div>
        <div style="font-size:12.5px;color:#6b7280;margin-bottom:10px">
          選擇一份本系統產出的 PDF —— 系統會在<strong>您的瀏覽器本機</strong>計算檔案雜湊後才送比對（檔案不會上傳）。
          若 PDF 內容被修改過，雜湊會完全不同，將查無紀錄。
        </div>
        <input type="file" accept="application/pdf" disabled={fileBusy.value}
          onChange={(e: any) => { verifyFile(e.currentTarget.files && e.currentTarget.files[0]); e.currentTarget.value = ''; }} />
        {fileBusy.value && <div style="font-size:12px;color:#6b7280;margin-top:8px">計算檔案雜湊中…</div>}
        {!!fileSha.value && (
          <div style="font-size:12px;color:#6b7280;margin-top:8px;word-break:break-all">
            檔案：{esc(fileName.value)}<br />SHA-256：<code>{fileSha.value}</code>
          </div>
        )}
        {fileResult.value && <VerifyResult r={fileResult.value} compact />}
      </div>

      {/* 統計摘要 */}
      {stats.value && (
        <div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:14px;background:#fff">
          <div style="display:flex;gap:32px;flex-wrap:wrap;align-items:flex-end">
            <div>
              <div style="font-size:12px;color:#6b7280">列印紀錄總數</div>
              <div style="font-size:24px;font-weight:700">{stats.value.total}</div>
            </div>
            <div>
              <div style="font-size:12px;color:#6b7280">簽章密鑰指紋（現行）</div>
              <div style="font-size:16px;font-weight:600"><code>{stats.value.current_secret_id || '-'}</code></div>
            </div>
            <div>
              <div style="font-size:12px;color:#6b7280">最近列印時間</div>
              <div style="font-size:13px">{stats.value.last_at || '-'}</div>
            </div>
            {stats.value.distinct_secrets > 1 && (
              <div style="font-size:12px;color:#92400e">
                ⚠️ 系統曾使用過 {stats.value.distinct_secrets} 把密鑰（曾輪替）
              </div>
            )}
          </div>
        </div>
      )}

      {/* 列印紀錄清單 */}
      <div class="toolbar">
        <div class="fld">
          <select value={fType.value} onChange={(e: any) => { fType.value = e.currentTarget.value; loadList(1); }}>
            <option value="">全部單據別</option>
            {docTypes.value.map((t: any) => <option value={t.type}>{t.label}</option>)}
          </select>
        </div>
        <div class="fld">
          <input value={fKw.value} onInput={(e: any) => (fKw.value = e.currentTarget.value)}
            onKeyDown={(e: any) => { if (e.key === 'Enter') loadList(1); }}
            placeholder="搜尋單號 / 指紋 / 雜湊" />
        </div>
        <button class="btn" onClick={() => loadList(1)}>查詢</button>
        <div class="spacer" />
        <span style="font-size:12.5px;color:#6b7280;align-self:center">共 {total.value} 筆</span>
      </div>
      {listBusy.value ? <div class="empty">載入中…</div> : <Table columns={columns} rows={rows.value} />}
      {pages > 1 && (
        <div style="display:flex;gap:10px;justify-content:center;align-items:center;margin-top:12px">
          <button class="btn btn-sm" disabled={page.value <= 1} onClick={() => loadList(page.value - 1)}>上一頁</button>
          <span style="font-size:12.5px">{page.value} / {pages}</span>
          <button class="btn btn-sm" disabled={page.value >= pages} onClick={() => loadList(page.value + 1)}>下一頁</button>
        </div>
      )}
    </>
  );
}
DocVerify.title = '文件驗證';

function VerifyResult({ r, compact }: any) {
  if (!r) return null;
  const ok = !!r.found;
  return (
    <div style={`margin-top:12px;border:1px solid ${ok ? '#a7f3d0' : '#fecaca'};background:${ok ? '#ecfdf5' : '#fef2f2'};border-radius:8px;padding:10px 12px`}>
      <div style={`font-weight:700;color:${ok ? '#065f46' : '#991b1b'}`}>
        {ok ? '✅ 查驗通過' : '❌ 查無紀錄'}
      </div>
      <div style="font-size:12.5px;color:#374151;margin-top:4px">{esc(r.message || '')}</div>
      {r.any_secret_mismatch && (
        <div style="font-size:12px;color:#92400e;margin-top:6px">
          ⚠️ 部分紀錄是以「舊簽章密鑰」產出（密鑰曾輪替）；這只影響「能否重算驗證」，不代表文件有問題。
        </div>
      )}
      {!!(r.items || []).length && (
        <div style="margin-top:8px;font-size:12.5px;color:#374151">
          {(r.items || []).slice(0, compact ? 3 : 10).map((it: any) => (
            <div style="border-top:1px dashed #e5e7eb;padding-top:6px;margin-top:6px">
              <b>{esc(it.doc_label)}</b>
              {it.doc_no ? <> 單號：<code>{esc(it.doc_no)}</code></> : null}
              <br />文件指紋：<code>{esc(it.fp)}</code>
              <br />PDF 雜湊：<code style="font-size:11.5px;word-break:break-all">{esc(it.pdf_sha256 || '-')}</code>
              <br />列印時間：{esc(it.created_at || '-')}
              {it.generated_by_name ? <> 列印人：{esc(it.generated_by_name)}</> : null}
               來源：{esc(SOURCE_LABEL[it.source] || it.source || '-')}
            </div>
          ))}
          {!compact && (r.items || []).length > 10 && (
            <div style="margin-top:6px;color:#6b7280">（僅顯示前 10 筆，共 {r.count} 筆）</div>
          )}
        </div>
      )}
    </div>
  );
}
