import Modal from './Modal.tsx';
import api from '../api.ts';

/**
 * Email 收件 Modal（批次寄送強化版）
 * props:
 *   count — 幾張單
 *   type  — '訂單' / '出貨單' / '報價單' / ...
 *   defaultSubject — 預設主旨（可選）
 *   onConfirm(payload) → Promise
 *       payload = { to, subject, html, bcc, extraAttachments:[{id,filename,contentType}] }
 *   onClose()
 *
 * 行為：
 *   - 收件者「自動」依各單據所屬客戶聯絡人；「額外收件者」為選填。
 *   - 每封郵件自動附加「公司名片」（公司名稱/地址/網址/負責業務），不可編輯（確保準確）。
 *   - 可編輯郵件本文、可填密件副本(BCC)、可上傳額外附件（5MB、常見格式）。
 */
function escHtml(v: any) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function escAttr(v: any) { return escHtml(v).replace(/'/g, '&#39;'); }

export default function EmailModal({ count, type = '訂單', defaultSubject = '', onConfirm, onClose }: any) {
  return (
    <Modal
      title={`批次寄送 Email（${count} 張${type}）`}
      body={`
        <div style="font-size:12.5px;color:#5A6270;line-height:1.5;background:#EAF2FB;border:1px solid #CFE0F5;border-radius:6px;padding:8px 10px;margin-bottom:10px">
          系統將<b>依各單據所屬客戶</b>，自動寄給該客戶聯絡人；每封郵件並<b>自動附加「公司名片」</b>（含負責業務姓名）。您可編輯本文、增設密件副本與額外附件。
        </div>

        <div style="font-size:13px;color:#5A6270;margin:6px 0 6px">額外收件者（選填，逗號/分號分隔，所有郵件副本）：</div>
        <input id="em-to" type="text" style="width:100%;padding:8px;font-size:13px;box-sizing:border-box;border:1px solid #ccc;border-radius:6px" placeholder="extra1@example.com, extra2@example.com" />

        <div style="font-size:13px;color:#5A6270;margin:10px 0 6px">主旨：</div>
        <input id="em-subject" type="text" value="${escAttr(defaultSubject)}" style="width:100%;padding:8px;font-size:13px;box-sizing:border-box;border:1px solid #ccc;border-radius:6px" placeholder="請輸入主旨" />

        <div style="font-size:13px;color:#5A6270;margin:10px 0 6px">郵件本文（可編輯）：</div>
        <textarea id="em-body" rows={5} style="width:100%;padding:8px;font-size:13px;box-sizing:border-box;border:1px solid #ccc;border-radius:6px" placeholder="您好，&#10;&#10;附件為貴司相關單據，請查收。"></textarea>

        <div style="font-size:13px;color:#5A6270;margin:10px 0 6px">密件副本 BCC（選填，給特定人，收件者看不到）：</div>
        <input id="em-bcc" type="text" style="width:100%;padding:8px;font-size:13px;box-sizing:border-box;border:1px solid #ccc;border-radius:6px" placeholder="boss@example.com, auditor@example.com" />

        <div style="font-size:13px;color:#5A6270;margin:10px 0 6px">額外附件（選填，最多 10 個、單檔 5MB）：</div>
        <input id="em-files" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.zip,.txt,.csv" style="width:100%;font-size:13px" />
        <div id="em-files-list" style="font-size:12px;color:#5A6270;background:#F7F8FA;border:1px solid #E4E7EC;border-radius:6px;padding:8px;margin-top:6px;word-break:break-all;display:none"></div>

        <div style="font-size:13px;color:#5A6270;margin:10px 0 6px">名片預覽（自動附加，不可編輯）：</div>
        <pre id="em-card" style="font-family:Menlo,Consolas,monospace;font-size:12px;line-height:1.5;color:#333;background:#f7f7f7;padding:10px 12px;border-left:3px solid #2d5a87;white-space:pre-wrap;margin:0">載入中…</pre>

        <div id="em-error" style="color:#C0392B;font-size:12px;margin-top:8px;display:none;min-height:16px"></div>
      `}
      saveText="寄送"
      onOpen={async (bodyEl: any) => {
        const ta = bodyEl.querySelector('#em-to'); if (ta) ta.focus();
        // 名片預覽：讀取公司資料（網址可能為空）
        try {
          const p = await fetch('/api/company-profile', { cache: 'no-store' }).then((r: any) => r.json());
          const lines = [];
          if (p.companyName) lines.push(p.companyName);
          if (p.companyAddress) lines.push('地址：' + p.companyAddress);
          if (p.companyWebsite) lines.push('網址：' + p.companyWebsite);
          lines.push('負責業務：（依各客戶自動帶入）');
          const el = bodyEl.querySelector('#em-card');
          if (el) el.textContent = lines.join('\n');
        } catch { /* ignore */ }
      }}
      onSave={async (bodyEl: any) => {
        const to = (bodyEl.querySelector('#em-to')?.value || '').trim();
        const subject = (bodyEl.querySelector('#em-subject')?.value || '').trim();
        const body = (bodyEl.querySelector('#em-body')?.value || '').trim();
        const bcc = (bodyEl.querySelector('#em-bcc')?.value || '').trim();
        const errEl = bodyEl.querySelector('#em-error');

        const showErr = (m: any) => { errEl.textContent = m; errEl.style.display = 'block'; };
        errEl.style.display = 'none';

        // 驗證 Email 格式（to / bcc）
        const emails = (to + ' ' + bcc).split(/[,;，；\s]+/).map((s: any) => s.trim()).filter(Boolean);
        const bad = emails.filter((e: any) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
        if (bad.length) { showErr('Email 格式錯誤：' + bad.join(', ')); return false; }

        // 上傳額外附件
        const fileInput = bodyEl.querySelector('#em-files');
        const extraAttachments: any[] = [];
        if (fileInput && fileInput.files && fileInput.files.length) {
          for (const f of Array.from(fileInput.files)) {
            const fd = new FormData();
            fd.append('files', f as any);
            try {
              const r: any = await api.post('/email/upload', fd);
              if (!r.ok) { showErr('附件上傳失敗：' + (r.error || '未知錯誤')); return false; }
              for (const uf of r.files) extraAttachments.push({ id: uf.id, filename: uf.filename, contentType: uf.contentType });
            } catch (e: any) { showErr('附件上傳失敗：' + e.message); return false; }
          }
        }

        // 本文轉 HTML（轉義＋換行）
        const html = body ? escHtml(body).replace(/\n/g, '<br>') : '';

        try {
          await onConfirm({ to, subject, html, bcc, extraAttachments });
          return true;
        } catch (e: any) {
          showErr('寄送失敗：' + e.message);
          return false;
        }
      }}
      onClose={onClose}
    />
  );
}
