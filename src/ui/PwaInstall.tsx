import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';

/**
 * PWA「安裝應用程式」入口。
 * - 捕捉 beforeinstallprompt：提供可靠的「安裝」按鈕（解決 Chrome 自動提示只出現一次、且不見的問題）。
 * - 若已以 App（standalone）形式安裝：不顯示。
 * - 關鍵改動（慈哥要求「觸發改為必須觸發條件」）：無論何種環境，這個安裝入口都「一定會出現」——
 *   安全上下文且瀏覽器願意安裝 → 綠色「安裝應用程式」（原生安裝）；
 *   非安全上下文（區網 IP / 電腦名稱 HTTP）或 SW 尚未就緒 → 顯示「如何安裝」按鈕並展開明確步驟，
 *   不再因條件不符而整條靜默消失（瀏覽器原生對話框仍只能在安全上下文由 beforeinstallprompt 啟動，此為瀏覽器硬限制）。
 */
export default function PwaInstall() {
  const deferred = useSignal<any>(null);
  const canInstall = useSignal(false);
  const installed = useSignal(false);
  const dismissed = useSignal(false);
  const notSecure = useSignal(false);
  const showGuide = useSignal(false);

  useEffect(() => {
    // 已安裝為 App（standalone / iOS standalone）就不顯示
    const mq = window.matchMedia('(display-mode: standalone)');
    if (mq.matches || (navigator as any).standalone) {
      installed.value = true;
      return;
    }
    // 記錄是否為非安全上下文（僅用於「如何安裝」說明內容，不再據此隱藏入口）
    notSecure.value = !window.isSecureContext;
    const onBefore = (e: any) => {
      e.preventDefault(); // 抑制 Chrome 自動 mini-infobar，改由我們的按鈕觸發
      deferred.value = e;
      canInstall.value = true;
    };
    const onInstalled = () => {
      installed.value = true;
      canInstall.value = false;
    };
    window.addEventListener('beforeinstallprompt', onBefore);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBefore);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const doInstall = async () => {
    const e = deferred.value;
    if (!e) return;
    try {
      await e.prompt();
      const choice = await e.userChoice;
      if (choice && choice.outcome === 'accepted') installed.value = true;
    } catch {
      /* 使用者取消或環境不支援，靜默處理 */
    }
    deferred.value = null;
    canInstall.value = false;
  };

  // 已安裝或使用者已關閉 → 不顯示（這兩種是使用者主動意圖，非「條件不符而消失」）
  if (installed.value || dismissed.value) return null;

  // 原生安裝可用（安全上下文 + Service Worker 就緒 + 未安裝）：綠色按鈕
  if (canInstall.value) {
    return (
      <div class="pwa-banner pwa-ok">
        <span>📲 可將本系統安裝為 App，離線也能一鍵開啟：</span>
        <button class="pwa-install-btn" onClick={doInstall}>安裝應用程式</button>
        <button class="pwa-x" onClick={() => (dismissed.value = true)}>稍後</button>
      </div>
    );
  }

  // 否則（非安全上下文 / Service Worker 未就緒 / 事件尚未觸發）：一律提供「如何安裝」入口，確保功能必須可觸發
  return (
    <div class="pwa-banner pwa-warn">
      <span>📱 本系統可安裝為桌面 / 手機 App（離線一鍵開啟）。</span>
      <button class="pwa-install-btn" onClick={() => (showGuide.value = true)}>如何安裝</button>
      <button class="pwa-x" onClick={() => (dismissed.value = true)}>稍後</button>
      {showGuide.value && (
        <div
          class="pwa-guide"
          style="margin-top:8px;padding:10px 12px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;color:#0f172a;font-size:13px;line-height:1.7;text-align:left"
        >
          <p style="margin:0 0 6px;font-weight:600">瀏覽器僅允許在「安全上下文」下安裝 App：</p>
          <ol style="margin:0;padding-left:20px">
            <li>在本機直接用 <code>http://127.0.0.1:5200</code> 或 <code>http://localhost:5200</code> 開啟（loopback 視為安全上下文），頁首即出現「安裝應用程式」。</li>
            <li>若需從其他電腦／手機使用，請於「網路設定」啟用 HTTPS（:5443）並以 <code>https://</code> 開啟，即可安裝。</li>
            <li>若以區網 IP 或電腦名稱的 http 開啟，瀏覽器基於安全設計不允許安裝（非系統缺失），請改以上述方式開啟。</li>
          </ol>
          <div style="margin-top:8px;text-align:right">
            <button class="pwa-x" onClick={() => (showGuide.value = false)}>關閉</button>
          </div>
        </div>
      )}
    </div>
  );
}
