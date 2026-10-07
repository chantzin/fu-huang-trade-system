// @ts-nocheck
'use strict';
/** Excel 匯出／匯入（xlsx） */
const XLSX = require('xlsx');

/** 二維陣列（首列為標題）→ xlsx Buffer */
function toWorkbook(rows, sheetName = 'Sheet1') {
  const ws = XLSX.utils.aoa_to_sheet(rows || []);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, String(sheetName).slice(0, 31));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** 物件陣列 → xlsx Buffer（headers: {欄位: 標題}） */
function fromObjects(list, headers, sheetName = 'Sheet1') {
  const keys = Object.keys(headers);
  const rows = [keys.map((k) => headers[k])];
  for (const r of list || []) rows.push(keys.map((k) => (r[k] === null || r[k] === undefined ? '' : r[k])));
  return toWorkbook(rows, sheetName);
}

/** 讀取上傳的 xlsx 第一個工作表 → 物件陣列（以標題列為 key） */
function readObjects(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });
}

export { toWorkbook, fromObjects, readObjects };
