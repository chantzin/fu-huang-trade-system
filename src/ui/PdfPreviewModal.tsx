import Modal from './Modal.tsx';

/**
 * PDF 預覽彈窗（內嵌 iframe，不跳離頁面）
 * props:
 *   title    彈窗標題
 *   pdfUrl   PDF 完整 URL（含 token 參數）
 *   onClose  關閉 callback
 */
export default function PdfPreviewModal({ title, pdfUrl, onClose }: any) {
  return (
    <Modal title={title || '文件預覽'} wide onClose={onClose}>
      <div style="width:100%;height:70vh;display:flex;flex-direction:column;gap:8px">
        <iframe
          src={pdfUrl}
          style="flex:1;width:100%;border:1px solid #e5e7eb;border-radius:6px;background:#fff"
          title="pdf-preview"
        />
        <div style="font-size:12px;color:#6b7280;text-align:center">
          預覽僅供檢視；如需列印或下載請使用列表「列印」按鈕，或於預覽區右鍵另存。
        </div>
      </div>
    </Modal>
  );
}
