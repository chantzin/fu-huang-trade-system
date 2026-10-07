import { html } from './format.ts';

/**
 * 資料表元件（對應舊 MJ.ui.table）
 * columns: [{ key, label, num, render(row)→HTML字串或Preact節點, html(表頭是否 raw) }]
 * rows: array
 * actions(row) → HTML 字串或 Preact 節點（節點模式可直接綁 onClick）
 */
export default function Table({ columns, rows, actions, empty = '目前沒有資料', rowAttr }: any) {
  if (!rows || !rows.length) {
    return <div class="table-wrap"><div class="empty">{empty}</div></div>;
  }
  const head = columns.map((c: any) =>
    <th class={c.num ? 'num' : ''} dangerouslySetInnerHTML={html(c.html ? c.label : escLabel(c.label))} />
  );
  const body = rows.map((r: any, i: any) => {
    const tds = columns.map((c: any) => {
      const v = c.render ? c.render(r) : (r[c.key] === null || r[c.key] === undefined ? '' : r[c.key]);
      // 字串/數字維持原 innerHTML 行為（render 回傳 HTML 字串）；節點直接宣告式渲染
      if (typeof v === 'string' || typeof v === 'number') {
        return <td class={c.num ? 'num' : ''} dangerouslySetInnerHTML={html(String(v))} />;
      }
      return <td class={c.num ? 'num' : ''}>{v}</td>;
    });
    let act = null;
    if (actions) {
      const a = actions(r, i);
      act = (typeof a === 'string' || typeof a === 'number')
        ? <td style="white-space:nowrap"><div class="row-actions" dangerouslySetInnerHTML={html(String(a))} /></td>
        : <td style="white-space:nowrap"><div class="row-actions">{a}</div></td>;
    }
    const attr = rowAttr ? rowAttr(r) : {};
    return <tr {...attr} key={r.id ?? i}>{tds}{act}</tr>;
  });
  return (
    <div class="table-wrap">
      <table>
        <thead><tr>{head}{actions ? <th /> : null}</tr></thead>
        <tbody>{body}</tbody>
      </table>
    </div>
  );
}

function escLabel(s: any) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
