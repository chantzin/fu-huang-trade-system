/**
 * 統一分頁元件
 * props:
 *   page          - 目前頁碼（1-based）
 *   pageSize      - 每頁項數
 *   total         - 總筆數
 *   onPageChange  - 頁碼變化回調 (newPage: any) => void
 *   onPageSizeChange - 每頁項數變化回調 (newSize: any) => void
 *   pageSizeOptions - 可選每頁項數，預設 [10,20,50,100]
 */
export default function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange, pageSizeOptions = [10, 20, 50, 100] }: any) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const curPage = Math.min(Math.max(1, page), totalPages);
  const start = total === 0 ? 0 : (curPage - 1) * pageSize + 1;
  const end = Math.min(curPage * pageSize, total);

  const goPage = (p: any) => {
    const np = Math.min(Math.max(1, p), totalPages);
    if (np !== curPage) onPageChange(np);
  };

  return (
    <div class="pagination-bar">
      <div class="pg-info">
        共 <b>{total}</b> 筆，顯示第 <b>{start}-{end}</b> 筆，第 <b>{curPage}/{totalPages}</b> 頁
      </div>
      <div class="pg-controls">
        <label class="pg-size-label">
          每頁
          <select class="pg-size-select" value={pageSize} onChange={(e: any) => onPageSizeChange(Number((e.target as HTMLSelectElement).value))}>
            {pageSizeOptions.map((s: any) => <option value={s}>{s}</option>)}
          </select>
          項
        </label>
        <button class="btn btn-sm pg-btn" onClick={() => goPage(1)} disabled={curPage <= 1}>« 首頁</button>
        <button class="btn btn-sm pg-btn" onClick={() => goPage(curPage - 1)} disabled={curPage <= 1}>‹ 上一頁</button>
        <button class="btn btn-sm pg-btn" onClick={() => goPage(curPage + 1)} disabled={curPage >= totalPages}>下一頁 ›</button>
        <button class="btn btn-sm pg-btn" onClick={() => goPage(totalPages)} disabled={curPage >= totalPages}>末頁 »</button>
      </div>
    </div>
  );
}
