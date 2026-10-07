// 格式化與小工具（對應舊 MJ.ui 的格式化部分）
export function esc(s: any) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 全系統金額小數點位數（參數 money_decimals；未設定＝0 位；由 App 載入或設定頁儲存時更新）
let moneyDecimals = 0;
export function setMoneyDecimals(d: any) {
  const n = parseInt(d, 10);
  moneyDecimals = Number.isFinite(n) && n >= 0 && n <= 6 ? n : 0;
}
export function getMoneyDecimals() { return moneyDecimals; }

const nf = (n: any, d = 2) => {
  const v = Number(n || 0);
  return v.toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
};
export const money = (n: any, cur = '') => nf(n, moneyDecimals) + (cur ? ' ' + cur : '');
export const num = (n: any, d = 0) => nf(n, d);
export const pct = (n: any, d = 2) => (Number(n || 0) * 100).toFixed(d) + '%';
export const date = (s: any) => (s ? String(s).slice(0, 10) : '');

/** 把「render 回傳的 HTML 字串」安全塞進 Preact（維持舊 view 的 render 寫法） */
export function html(str: any) {
  return { __html: str };
}

/** 標籤（對應舊 MJ.ui.tag，產生 HTML 字串供 render 使用） */
export function tag(text: any, type = 'gray') {
  return `<span class="tag t-${type}">${esc(text)}</span>`;
}
