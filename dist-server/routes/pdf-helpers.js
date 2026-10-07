'use strict';
/**
 * PDF 渲染輔助（routes/pdf-helpers.js）
 *
 * 提供 email.js 需要的「載入單據 + 渲染成 Buffer」能力。
 *
 * 【2026-09-22 重構】
 *   原缺陷：本檔自帶一份「複製貼上」的訂單／出貨單繪圖碼（_drawOrderBody / _drawShipmentBody），
 *          與 routes/pdf.js 的正本逐漸不同步——例如出貨單「一頁兩份」與簽核欄位修正只做在正本，
 *          導致 email 附件的出貨單仍是舊排版（還含已移除的 generated_at）。
 *   修正：直接複用 routes/pdf.js 的正本繪圖函式，單一來源；並比照 HTTP 下載寫入指紋紀錄。
 */
const { createDoc, addPageFooter } = require('../lib/pdf');
const {
  loadOrder, drawOrderToDoc, loadShipment, drawShipmentToDoc,
  finishDoc, verifyUrlFor,
} = require('./pdf');

/** 渲染訂單確認單為 PDF Buffer（email 附件用） */
function renderOrderToBuffer(order) {
  const doc = createDoc({ title: '訂 單 確 認 單' });
  const fp = drawOrderToDoc(doc, order);
  addPageFooter(doc, undefined, fp, verifyUrlFor(null, fp));
  return finishDoc(doc, { fp, doc_type: 'order', doc_id: order.id, doc_no: order.order_no, source: 'email' });
}

/** 渲染出貨單為 PDF Buffer（email 附件用；drawShipmentToDoc 為 async） */
async function renderShipmentToBuffer(sh) {
  const doc = createDoc({ title: '', watermark: false });
  // 蓋掉 createDoc 自動畫的預設 header（出貨單用自己的置中格式）
  doc.rect(0, 0, doc.page.width, 100).fillColor('#ffffff').fill();
  const fp = await drawShipmentToDoc(doc, sh);
  addPageFooter(doc, undefined, fp, verifyUrlFor(null, fp));
  return finishDoc(doc, { fp, doc_type: 'shipment', doc_id: sh.id, doc_no: sh.shipment_no, source: 'email' });
}

module.exports = {
  loadOrder,
  loadShipment,
  renderOrderToBuffer,
  renderShipmentToBuffer,
};
