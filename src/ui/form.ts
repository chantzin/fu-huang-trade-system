// 表單欄位 HTML 產生器（對應舊 MJ.ui 的 form 部分；回傳字串，供 Modal body 使用）
import { date, esc } from './format.ts';

export function field(label: any, input: any, full: any = false) {
  return `<div class="${full ? 'full' : ''}"><label class="f">${esc(label)}</label>${input}</div>`;
}
export function input(name: any, value: any = '', attrs: any = '') {
  return `<input name="${name}" value="${esc(value)}" ${attrs} />`;
}
export function number(name: any, value: any = 0, step: any = 'any', attrs: any = '') {
  return `<input type="number" step="${step}" name="${name}" value="${value === null || value === undefined ? 0 : value}" ${attrs} />`;
}
export function dateField(name: any, value: any = '') {
  return `<input type="date" name="${name}" value="${date(value)}" />`;
}
export function checkbox(name: any, checked: any = false) {
  return `<input type="checkbox" name="${name}" ${checked ? 'checked' : ''} />`;
}
export function select(name: any, options: any, value: any = '', attrs: any = '') {
  const opts = options.map((o: any) => {
    const v = Array.isArray(o) ? o[0] : o.value;
    const t = Array.isArray(o) ? o[1] : o.label;
    return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`;
  }).join('');
  return `<select name="${name}" ${attrs}>${opts}</select>`;
}
export function textarea(name: any, value = '') {
  return `<textarea name="${name}">${esc(value || '')}</textarea>`;
}

/** 收集表單（數字欄位自動轉型；checkbox → 0/1；select 純數字值轉 number） */
export function formData(root: any) {
  const out: any = {};
  root.querySelectorAll('input,select,textarea').forEach((el: any) => {
    if (!el.name) return;
    if (el.type === 'number') out[el.name] = el.value === '' ? 0 : Number(el.value);
    else if (el.type === 'checkbox') out[el.name] = el.checked ? 1 : 0;
    else {
      const v = el.value.trim();
      // select 的值多為 id／旗標（ar_terms_id、supplier_id、owner_id、active…）。
      // 若保持字串，後端 `b.x ? Number(b.x) : null` 會把 "0" 視為 truthy → 寫入 0 → 違反 FK
      // （FOREIGN KEY constraint failed）；`active === false` 判斷也會失準使「停用」失效。
      // 故純整數字串一律轉為 number；非數字（幣別、角色…）維持字串。
      out[el.name] = el.tagName === 'SELECT' && /^-?\d+$/.test(v) ? Number(v) : v;
    }
  });
  return out;
}
