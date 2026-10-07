// @ts-nocheck
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';

export default function SecuritySettings() {
  const enabled = useSignal(false);
  const busy = useSignal(false);
  const msg = useSignal('');
  const setup = useSignal<any>(null);   // { secret, otpauthUrl, qrDataUrl }
  const code = useSignal('');
  const password = useSignal('');
  const disableCode = useSignal('');
  const viewPwd = useSignal('');
  const viewQR = useSignal<any>(null);   // { secret, otpauthUrl, qrDataUrl }

  const loadStatus = async () => {
    try {
      const me = await api.get('/auth/me');
      enabled.value = !!me.user.mfaEnabled;
    } catch { /* ignore */ }
  };

  useEffect(() => { loadStatus(); }, []);

  const startSetup = async () => {
    busy.value = true; msg.value = '';
    try {
      const r = await api.post('/auth/mfa/setup', {});
      setup.value = r;
      code.value = '';
    } catch (e: any) { msg.value = e.message || '啟用失敗'; }
    finally { busy.value = false; }
  };

  const confirmSetup = async () => {
    busy.value = true; msg.value = '';
    try {
      await api.post('/auth/mfa/confirm', { code: code.value });
      setup.value = null; code.value = '';
      msg.value = '✅ MFA 已啟用，下次登入需輸入動態碼。';
      await loadStatus();
    } catch (e: any) { msg.value = e.message || '確認失敗'; }
    finally { busy.value = false; }
  };

  const disable = async () => {
    busy.value = true; msg.value = '';
    try {
      await api.post('/auth/mfa/disable', { password: password.value, code: disableCode.value });
      password.value = ''; disableCode.value = '';
      msg.value = '✅ MFA 已停用。';
      await loadStatus();
    } catch (e: any) { msg.value = e.message || '停用失敗'; }
    finally { busy.value = false; }
  };

  // 查看目前綁定的 QR（遺失 PNG 時自助重看；密碼 step-up）
  const viewCurrent = async () => {
    busy.value = true; msg.value = '';
    try {
      const r = await api.post('/auth/mfa/view', { password: viewPwd.value });
      viewQR.value = r; viewPwd.value = '';
    } catch (e: any) { msg.value = e.message || '查看失敗'; }
    finally { busy.value = false; }
  };

  return (
    <div class="view security-settings">
      <h2>安全設定（MFA 二階段驗證）</h2>
      <p class="muted">啟用後，登入除密碼外，還需輸入 Authenticator App（Google / Microsoft Authenticator 等）的 6 位動態碼，大幅提升帳號安全。</p>

      {msg.value ? <div class="login-msg">{msg.value}</div> : null}

      {!setup.value ? (
        <div class="mfa-card">
          <div class="mfa-status">
            目前狀態：{enabled.value
              ? <span class="badge ok">已啟用 MFA</span>
              : <span class="badge warn">未啟用</span>}
          </div>

          {!enabled.value ? (
            <button class="btn-primary" onClick={startSetup} disabled={busy.value}>
              {busy.value ? '準備中…' : '啟用 MFA'}
            </button>
          ) : (
            <div class="mfa-manage">
              <div class="mfa-disable-form">
                <p>停用 MFA 需驗證身分：</p>
                <label>登入密碼
                  <input type="password" placeholder="請輸入密碼" value={password.value}
                    onInput={(e: any) => (password.value = e.currentTarget.value)} />
                </label>
                <label>目前動態碼
                  <input type="text" placeholder="6 位驗證碼" value={disableCode.value}
                    onInput={(e: any) => (disableCode.value = e.currentTarget.value)} inputmode="numeric" />
                </label>
                <button class="btn-danger" onClick={disable} disabled={busy.value || !password.value}>停用 MFA</button>
              </div>

              <hr />
              <div class="mfa-view-form">
                <p>查看目前綁定的 QR Code（遺失 PNG 時可在此重看，需輸入密碼）：</p>
                {!viewQR.value ? (
                  <>
                    <label>登入密碼
                      <input type="password" placeholder="請輸入密碼" value={viewPwd.value}
                        onInput={(e: any) => (viewPwd.value = e.currentTarget.value)} />
                    </label>
                    <button class="btn-secondary" onClick={viewCurrent} disabled={busy.value || !viewPwd.value}>顯示綁定 QR</button>
                  </>
                ) : (
                  <div class="mfa-qr-view">
                    <div class="mfa-qr"><img src={viewQR.value.qrDataUrl} alt="MFA QR Code" /></div>
                    <div class="mfa-secret">密鑰（Secret）：<code>{viewQR.value.secret}</code></div>
                    <button class="btn-ghost" onClick={() => { viewQR.value = null; }}>關閉</button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div class="mfa-setup">
          <p>請用 Authenticator App 掃描下方 QR Code，或手動輸入密鑰：</p>
          <div class="mfa-qr"><img src={setup.value.qrDataUrl} alt="MFA QR Code" /></div>
          <div class="mfa-secret">密鑰（Secret）：<code>{setup.value.secret}</code></div>
          <label>輸入 App 顯示的 6 位動態碼以完成啟用
            <input type="text" placeholder="6 位驗證碼" value={code.value}
              onInput={(e: any) => (code.value = e.currentTarget.value)} inputmode="numeric" autocomplete="one-time-code" />
          </label>
          <button class="btn-primary" onClick={confirmSetup} disabled={busy.value || !code.value}>確認啟用</button>
          <button class="btn-ghost" onClick={() => { setup.value = null; }}>取消</button>
        </div>
      )}
    </div>
  );
}
SecuritySettings.title = '安全設定';
