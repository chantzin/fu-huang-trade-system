import { useEffect, useRef } from 'preact/hooks';
import { toast, confirmBox } from '../store.ts';

/**
 * Modal 元件（對應舊 MJ.ui.modal）
 * props:
 *   title, wide, saveText, extraButtons(HTML字串 或 children 宣告式)
 *   body(string HTML) — 初始內容（舊式，向後相容）
 *   children — 宣告式內容（優先於 body）
 *   onSave(bodyEl | null) → Promise（return false 不關閉；宣告式模式下傳 null）
 *   onOpen(bodyEl, close) — 綁定事件用（舊式）
 *   onClose()
 *
 * 宣告式用法：
 *   <Modal title="..." onSave={() => save()} onClose={...}>
 *     <div>...表單元件...<div>
 *   </Modal>
 * 此時 onSave 收到的 bodyEl 為 null，元件應自行管理狀態。
 */
export default function Modal({ title, wide, body = '', saveText = '儲存', extraButtons = '', onSave, onOpen, onClose, children }: any) {
  const bodyRef = useRef(null);

  useEffect(() => {
    const bodyEl = bodyRef.current;
    if (bodyEl && onOpen && !children) onOpen(bodyEl, close);
  }, []);

  const close = () => { onClose && onClose(); };

  const save = async (e: any) => {
    if (!onSave) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      // 宣告式模式（有 children）傳 null；舊式 body 模式傳 bodyEl
      const r = await onSave(children ? null : bodyRef.current);
      if (r !== false) close();
    } catch (err) {
      toast(err.message || String(err), 'err');
    } finally {
      btn.disabled = false;
    }
  };

  return (
    <div class="modal-mask">
      <div class={`modal ${wide ? 'wide' : ''}`}>
        <header>
          {title !== undefined && title !== null && typeof title === 'string'
            ? <span dangerouslySetInnerHTML={{ __html: title }} />
            : <span>{title}</span>}
          <button class="x" type="button" onClick={close}>&times;</button>
        </header>
        {children ? (
          <div class="body" ref={bodyRef}>{children}</div>
        ) : (
          <div class="body" ref={bodyRef} dangerouslySetInnerHTML={{ __html: body }} />
        )}
        <footer>
          {extraButtons && typeof extraButtons === 'string'
            ? <span class="extra-buttons" dangerouslySetInnerHTML={{ __html: extraButtons }} />
            : <span class="extra-buttons">{extraButtons}</span>}
          <button class="btn" type="button" onClick={close}>取消</button>
          {onSave ? <button class="btn btn-primary" type="button" onClick={save}>{saveText}</button> : null}
        </footer>
      </div>
    </div>
  );
}

/** 確認對話框（宣告式：設定 signal，由根層 <ConfirmHost/> 渲染，API 維持 Promise<boolean>） */
export function confirmDialog(msg: any) {
  return new Promise<boolean>((resolve) => {
    confirmBox.value = { msg: String(msg), resolve };
  });
}

/** 根層掛載的宣告式確認對話框宿主（App 根部渲染一次即可） */
export function ConfirmHost() {
  const st = confirmBox.value;
  if (!st) return null;
  const done = (v: boolean) => {
    confirmBox.value = null;
    st.resolve(v);
  };
  return (
    <div class="modal-mask" onMouseDown={(e: any) => { if (e.target === e.currentTarget) done(false); }}>
      <div class="modal">
        <header>
          <span>請確認</span>
          <button class="x" type="button" onClick={() => done(false)}>&times;</button>
        </header>
        <div class="body">
          <div style="font-size:14px;line-height:1.8">{st.msg}</div>
        </div>
        <footer>
          <button class="btn" type="button" onClick={() => done(false)}>取消</button>
          <button class="btn btn-primary" type="button" onClick={() => done(true)}>確定</button>
        </footer>
      </div>
    </div>
  );
}
