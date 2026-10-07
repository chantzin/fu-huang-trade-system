// 郵件設定（SMTP 伺服器設定＋測試郵件發送）
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';

export default function MailSettings() {
  const loading = useSignal(true);
  const saving = useSignal(false);
  const testing = useSignal(false);

  // 表單狀態
  const smtpHost = useSignal('');
  const smtpPort = useSignal('587');
  const smtpUser = useSignal('');
  const smtpPass = useSignal('');
  const smtpPassSet = useSignal(false);
  const smtpSecure = useSignal(false);
  const mailFrom = useSignal('');
  const mailFooter = useSignal('');

  // 目前生效模式
  const effectiveMode = useSignal('ethereal');
  const effectiveSource = useSignal('none');
  const configSmtpHost = useSignal('');
  // 目前生效的加密方式（2026-09-24 防呆：顯示實際送信用的加密，避免「587+SSL」錯配）
  const effectivePort = useSignal(587);
  const effectiveSecure = useSignal(false);
  const effectiveEncryption = useSignal('');
  const secureAutoOverride = useSignal(false);

  // 已知連接埠 → 對應的正確加密模式（與後端 resolveSecure 保持一致）
  const KNOWN_PORTS = [465, 587, 25, 2525];
  function portKnown(p) { return KNOWN_PORTS.includes(Number(p)); }
  function _portSuggestedSecure(p) {
    const n = Number(p);
    if (n === 465) return true;       // 隱式 SSL
    if (KNOWN_PORTS.includes(n)) return false; // 587/25/2525 → STARTTLS
    return smtpSecure.value;          // 自訂端口：尊重使用者
  }

  // 測試郵件
  const testEmail = useSignal('');
  const testResult = useSignal(null);

  // 載入目前設定
  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    loading.value = true;
    try {
      const cfg = await api.getMailConfig();
      smtpHost.value = cfg.smtp_host || '';
      smtpPort.value = cfg.smtp_port || '587';
      smtpUser.value = cfg.smtp_user || '';
      smtpPass.value = '';  // 密碼不回傳，保持空白
      smtpPassSet.value = !!cfg.smtp_pass_set;
      smtpSecure.value = !!cfg.smtp_secure;
      mailFrom.value = cfg.mail_from || '';
      mailFooter.value = cfg.mail_footer || '';
      effectiveMode.value = cfg.effective_mode || 'ethereal';
      effectiveSource.value = cfg.effective_source || 'none';
      configSmtpHost.value = cfg.config_smtp_host || '';
      effectivePort.value = cfg.effective_port || Number(cfg.smtp_port) || 587;
      effectiveSecure.value = !!cfg.effective_secure;
      effectiveEncryption.value = cfg.effective_encryption || '';
      secureAutoOverride.value = !!cfg.secure_auto_override;
    } catch (e) {
      toast('載入郵件設定失敗：' + e.message, 'err');
    } finally {
      loading.value = false;
    }
  }

  // 連接埠變動時自動校正 SSL/TLS 勾選（防呆：避免「587 + SSL」致死組合）
  function onPortInput(e: any) {
    const v = e.currentTarget.value;
    smtpPort.value = v;
    const n = Number(v);
    if (n === 465) smtpSecure.value = true;          // 隱式 SSL
    else if (KNOWN_PORTS.includes(n)) smtpSecure.value = false; // 587/25/2525 → STARTTLS
    // 自訂端口：保留使用者勾選
  }

  async function doSave() {
    if (!smtpHost.value.trim()) {
      toast('請填寫 SMTP 主機', 'err');
      return;
    }
    saving.value = true;
    try {
      const data: any = {
        smtp_host: smtpHost.value.trim(),
        smtp_port: smtpPort.value.trim() || '587',
        smtp_user: smtpUser.value.trim(),
        smtp_secure: smtpSecure.value,
        mail_from: mailFrom.value.trim(),
        mail_footer: mailFooter.value,
      };
      // 只有在輸入新密碼時才帶入（否則後端會保留舊密碼）
      if (smtpPass.value && smtpPass.value.length > 0) {
        data.smtp_pass = smtpPass.value;
      }
      await api.saveMailConfig(data);
      toast('郵件設定已儲存', 'ok');
      smtpPass.value = '';
      await loadConfig();  // 重新載入以更新 effective_mode
    } catch (e) {
      toast('儲存失敗：' + e.message, 'err');
    } finally {
      saving.value = false;
    }
  }

  async function doTest() {
    const to = testEmail.value.trim();
    if (!to) {
      toast('請填寫測試收件人 Email', 'err');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      toast('Email 格式不正確', 'err');
      return;
    }
    testing.value = true;
    testResult.value = null;
    try {
      const r = await api.testMailConfig(to);
      testResult.value = { ok: true, message: r.message, previewUrl: r.previewUrl };
      toast('測試郵件已寄送', 'ok');
    } catch (e) {
      testResult.value = { ok: false, message: e.message };
      toast('測試郵件發送失敗', 'err');
    } finally {
      testing.value = false;
    }
  }

  if (loading.value) {
    return <div class="card" style="padding:40px;text-align:center;color:#98A0AC">載入中…</div>;
  }

  const isSmtpMode = effectiveMode.value === 'smtp';
  const isDbSource = effectiveSource.value === 'db';

  return (
    <div style="max-width:720px">
      {/* 目前狀態卡片 */}
      <div class="card" style="margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
          <span style={`font-size:28px`}>{isSmtpMode ? '📧' : '🧪'}</span>
          <div>
            <div style="font-size:16px;font-weight:700;color:#0F766E">
              目前模式：{isSmtpMode ? '真實 SMTP 郵件伺服器' : 'ethereal.email 測試模式'}
            </div>
            <div style="font-size:12px;color:#98A0AC;margin-top:2px">
              設定來源：
              {isDbSource ? '資料庫（UI 設定）' :
               effectiveSource.value === 'config' ? 'config.json 靜態設定' :
               '無（使用 ethereal 測試模式）'}
            </div>
            {isSmtpMode && effectiveEncryption.value && (
              <div style="font-size:12px;color:#0F766E;margin-top:4px">
                目前送信加密方式：<b>{effectiveEncryption.value}</b>
                {secureAutoOverride.value && (
                  <span style="color:#B45309">（系統已依連接埠自動校正您原本的 SSL 設定）</span>
                )}
              </div>
            )}
          </div>
        </div>
        {!isSmtpMode && (
          <div style="background:#FBF6EE;border-left:3px solid #E8A33D;padding:10px 14px;border-radius:6px;font-size:13px;color:#7A5A1E;margin-top:8px">
            ⚠️ 目前為測試模式，所有郵件都會送到 ethereal.email 測試收件匣，<b>不會真正寄給客戶</b>。
            請在下方填寫真實 SMTP 設定並儲存，即可切換為真實寄送模式。
          </div>
        )}
        {isSmtpMode && !isDbSource && configSmtpHost.value && (
          <div style="background:#ECFDF5;border-left:3px solid #0F766E;padding:10px 14px;border-radius:6px;font-size:13px;color:#115E59;margin-top:8px">
            ℹ️ 目前生效的 SMTP 設定來自 config.json（{configSmtpHost.value}）。
            若要在 UI 中編輯，請在下方填寫設定並儲存，儲存後會以資料庫設定為優先。
          </div>
        )}
      </div>

      {/* SMTP 設定表單 */}
      <div class="card">
        <h3 style="font-size:17px;color:#0F766E;margin-bottom:16px">SMTP 郵件伺服器設定</h3>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <div style="grid-column:1 / -1">
            <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px">
              SMTP 主機 <span style="color:#C0392B">*</span>
            </label>
            <input type="text" value={smtpHost.value}
              onInput={(e: any) => (smtpHost.value = e.currentTarget.value)}
              placeholder="例如：smtp.gmail.com、smtp.office365.com"
              style="width:100%;padding:8px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px" />
          </div>

          <div>
            <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px">連接埠</label>
            <input type="text" value={smtpPort.value}
              onInput={onPortInput}
              placeholder="587"
              style="width:100%;padding:8px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px" />
            <div style="font-size:11px;color:#98A0AC;margin-top:2px">常用：587（STARTTLS）、465（SSL）、25（無加密）</div>
          </div>

          <div>
            <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px">
              SSL/TLS 加密
            </label>
            <label style={`display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px;${portKnown(smtpPort.value) ? 'background:#F4F6F8;cursor:not-allowed;color:#6B7280' : 'cursor:pointer'}`}>
              <input type="checkbox" checked={smtpSecure.value}
                disabled={portKnown(smtpPort.value)}
                onChange={(e: any) => (smtpSecure.value = e.currentTarget.checked)}
                style="width:16px;height:16px" />
              <span>
                {portKnown(smtpPort.value)
                  ? `已依連接埠 ${smtpPort.value} 自動設定（${smtpSecure.value ? 'SSL/TLS 隱式加密' : 'STARTTLS 加密'}）`
                  : '啟用 SSL/TLS（自訂連接埠時手動設定）'}
              </span>
            </label>
            {portKnown(smtpPort.value) && (
              <div style="font-size:11px;color:#1B8A3A;margin-top:4px">
                ✅ 已知連接埠會自動對應正確加密方式，無需手動勾選，可避免「wrong version number」錯誤。
              </div>
            )}
          </div>

          <div>
            <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px">使用者名稱（帳號）</label>
            <input type="text" value={smtpUser.value}
              onInput={(e: any) => (smtpUser.value = e.currentTarget.value)}
              placeholder="SMTP 登入帳號"
              style="width:100%;padding:8px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px" />
          </div>

          <div>
            <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px">
              密碼 {smtpPassSet.value && <span style="color:#1B8A3A;font-weight:400;font-size:12px">（已設定，留空則不變更）</span>}
            </label>
            <input type="password" value={smtpPass.value}
              onInput={(e: any) => (smtpPass.value = e.currentTarget.value)}
              placeholder={smtpPassSet.value ? '輸入新密碼以變更，留空保留舊密碼' : 'SMTP 登入密碼'}
              style="width:100%;padding:8px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px" />
          </div>

          <div style="grid-column:1 / -1">
            <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px">寄件者（From）</label>
            <input type="text" value={mailFrom.value}
              onInput={(e: any) => (mailFrom.value = e.currentTarget.value)}
              placeholder="例如：輔凰商貿 &lt;noreply@fuhuang.com&gt;"
              style="width:100%;padding:8px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px" />
            <div style="font-size:11px;color:#98A0AC;margin-top:2px">客戶收到郵件時顯示的寄件者名稱與 Email</div>
          </div>

          <div style="grid-column:1 / -1">
            <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px">信件頁尾文字</label>
            <textarea value={mailFooter.value}
              onInput={(e: any) => (mailFooter.value = e.currentTarget.value)}
              placeholder="本郵件由 輔凰商貿系統 自動寄出。"
              style="width:100%;min-height:64px;padding:8px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px;resize:vertical" />
            <div style="font-size:11px;color:#98A0AC;margin-top:2px">
              所有自動寄出的信件（批次寄 Email／單張訂單／出貨／測試信）正文末尾都會附加此文字。
              留空則使用系統預設「本郵件由 輔凰商貿系統 自動寄出。」；僅允許純文字（特殊字元會自動轉義）。
            </div>
          </div>
        </div>

        <div style="margin-top:18px;display:flex;gap:10px">
          <button onClick={doSave} disabled={saving.value}
            style="padding:10px 24px;background:#0F766E;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;opacity:${saving.value ? 0.6 : 1}">
            {saving.value ? '儲存中…' : '💾 儲存設定'}
          </button>
          <button onClick={loadConfig} disabled={saving.value}
            style="padding:10px 20px;background:#F4F6F8;color:#333;border:1px solid #D1D5DB;border-radius:8px;font-size:14px;cursor:pointer">
            重新載入
          </button>
        </div>
      </div>

      {/* 測試郵件 */}
      <div class="card" style="margin-top:16px">
        <h3 style="font-size:17px;color:#0F766E;margin-bottom:8px">測試郵件發送</h3>
        <p style="font-size:13px;color:#6B7280;margin-bottom:14px">
          儲存 SMTP 設定後，可輸入一個測試收件 Email，確認郵件伺服器設定正確運作。
        </p>
        <div style="display:flex;gap:10px;align-items:flex-start">
          <input type="email" value={testEmail.value}
            onInput={(e: any) => (testEmail.value = e.currentTarget.value)}
            placeholder="測試收件人 Email，例如：your@email.com"
            style="flex:1;padding:10px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px"
            onKeyDown={(e: any) => { if (e.key === 'Enter') doTest(); }} />
          <button onClick={doTest} disabled={testing.value || !isSmtpMode}
            style="padding:10px 20px;background:#1B8A3A;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;opacity:${testing.value || !isSmtpMode ? 0.6 : 1};white-space:nowrap">
            {testing.value ? '寄送中…' : '✉️ 發送測試郵件'}
          </button>
        </div>
        {!isSmtpMode && (
          <div style="font-size:12px;color:#B8860B;margin-top:6px">⚠️ 需先儲存真實 SMTP 設定才能發送測試郵件</div>
        )}
        {testResult.value && (
          <div style={`margin-top:12px;padding:12px 16px;border-radius:8px;font-size:13px;${testResult.value.ok ? 'background:#E6F7EC;color:#1B5E20' : 'background:#FDEDEC;color:#7F1D1D'}`}>
            {testResult.value.ok ? '✅ ' : '❌ '}{testResult.value.message}
            {testResult.value.previewUrl && (
              <div style="margin-top:6px">
                <a href={testResult.value.previewUrl} target="_blank" rel="noopener"
                  style="color:#1B5E20;text-decoration:underline;font-size:12px">
                  📬 查看 ethereal 測試預覽
                </a>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 常見 SMTP 設定參考 */}
      <div class="card" style="margin-top:16px">
        <h3 style="font-size:15px;color:#0F766E;margin-bottom:10px">常見 SMTP 伺服器設定參考</h3>
        <table class="mini-table" style="font-size:12.5px">
          <tr><th>服務</th><th>主機</th><th>連接埠</th><th>SSL/TLS</th><th>備註</th></tr>
          <tr><td>Gmail</td><td>smtp.gmail.com</td><td>587</td><td>STARTTLS</td><td>需啟用「應用程式密碼」</td></tr>
          <tr><td>Outlook / Office 365</td><td>smtp.office365.com</td><td>587</td><td>STARTTLS</td><td>—</td></tr>
          <tr><td>Yahoo 奇摩</td><td>smtp.mail.yahoo.com</td><td>465</td><td>SSL</td><td>需產生應用程式密碼</td></tr>
          <tr><td>中華電信 Hinet</td><td>ms.hinet.net</td><td>25</td><td>無</td><td>需使用 Hinet 網路</td></tr>
          <tr><td>Seednet</td><td>smtp.seed.net.tw</td><td>25</td><td>無</td><td>需使用 Seednet 網路</td></tr>
          <tr><td>Google Workspace</td><td>smtp-relay.gmail.com</td><td>587</td><td>STARTTLS</td><td>企業版，需管理員設定</td></tr>
        </table>
        <div style="font-size:11px;color:#98A0AC;margin-top:8px">
          💡 若使用 Gmail 個人帳號，需先在 Google 帳戶安全設定中啟用「兩步驟驗證」，再產生「應用程式密碼」做為 SMTP 密碼。
        </div>
      </div>
    </div>
  );
}

MailSettings.title = '郵件設定';
