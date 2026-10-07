import { toasts } from '../store.ts';

// Toast 容器（對應舊 MJ.ui.toast 的顯示層）
export default function ToastHost() {
  return (
    <div id="toast-root">
      {toasts.value.map((t: any) => (
        <div key={t.id} class={`toast ${t.type}`}>{t.msg}</div>
      ))}
    </div>
  );
}
