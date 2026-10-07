// 管理者網路設定（自助設定內部 IP / 對外固定 IP / HTTPS / 憑證 / 允許網段）
// 目標：售予客戶後，客戶依自身網路環境自助設定，且「設完不會把自己鎖死」。
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';

/** 把字串（PEM）做成 blob 觸發瀏覽器下載 */
function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/x-x509-cert' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// 三種典型場景預設
function scenarioPreset(scn: string, suggested: string[]) {
  switch (scn) {
    case 'lan': // 內網（同一區網內電腦存取）
      return {
        httpLocalOnly: true,
        enabled: true,
        cidrs: suggested && suggested.length ? [suggested[0]] : ['192.168.0.0/24'],
        certMode: 'generate',
        note: '內網使用：僅同區網裝置可連線。請先在路由器將本機 IP 設為 DHCP 保留，並確認防火牆開放 5443。',
      };
    case 'public': // 對外固定 IP（公司固定 IP 直連）
      return {
        httpLocalOnly: true,
        enabled: true,
        cidrs: ['0.0.0.0/0'],
        certMode: 'generate',
        note: '對外固定 IP：網際網路任一裝置皆可連線。請在路由器做 DHCP 保留 + 對外轉發 5443，並在 DDNS/防火牆放行。開放 0.0.0.0/0 前請確認密碼強度。',
      };
    case 'ddns': // 網域 + DDNS
      return {
        httpLocalOnly: true,
        enabled: true,
        cidrs: ['0.0.0.0/0'],
        certMode: 'generate',
        note: '網域 + DDNS：建議將憑證 SAN 填入您的網域（如 www.example.com）。同樣需路由器 DHCP 保留 + 對外轉發 5443。',
      };
    default:
      return null;
  }
}

export default function NetworkSettings() {
  const loading = useSignal(true);
  const saving = useSignal(false);

  // 本機網路資訊（來自 /status）
  const statusData = useSignal<any>(null);
  const clientIp = useSignal('');
  const localInterfaces = useSignal<any[]>([]);
  const suggestedCidrs = useSignal<string[]>([]);
  const rollbackSeconds = useSignal(300);
  const currentCert = useSignal<any>(null);

  // 表單：場景
  const scenario = useSignal('');

  // 表單：HTTPS
  const httpLocalOnly = useSignal(true);
  const httpsEnabled = useSignal(true);
  const httpsPort = useSignal('5443');

  // 表單：CIDR 允許清單
  const cidrs = useSignal<string[]>([]);
  const cidrInput = useSignal('');
  const confirmOpenAll = useSignal(false);

  // 表單：憑證
  const certMode = useSignal<'keep' | 'generate' | 'upload'>('keep');
  const certCommonName = useSignal('');
  const certSan = useSignal('');
  const certDays = useSignal('3650');
  const generating = useSignal(false);
  const generated = useSignal<any>(null);   // { certPath, keyPath, certPem, keyPem, fingerprint }
  const uploadedCertPem = useSignal('');
  const uploadedKeyPem = useSignal('');

  // 連線測試（防鎖死預檢）
  const testing = useSignal(false);
  const testResult = useSignal<any>(null);

  // 待確認回滾
  const pending = useSignal<any>(null);
  const countdown = useSignal(0);
  const confirming = useSignal(false);

  useEffect(() => { loadStatus(); }, []);
  // 待確認倒數
  useEffect(() => {
    if (!pending.value) { countdown.value = 0; return; }
    const tick = () => {
      const ms = Math.max(0, (pending.value.expiresAt || 0) - Date.now());
      countdown.value = Math.ceil(ms / 1000);
      if (ms <= 0) pending.value = null;
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [pending.value]);

  async function loadStatus() {
    loading.value = true;
    try {
      const s = await api.get('/network/status');
      statusData.value = s;
      clientIp.value = s.clientIp;
      localInterfaces.value = s.localInterfaces || [];
      suggestedCidrs.value = s.suggestedCidrs || [];
      rollbackSeconds.value = s.rollbackSeconds || 300;
      currentCert.value = s.cert || null;
      pending.value = s.pending || null;
      const cur = s.current || {};
      httpsEnabled.value = !!(cur.https && cur.https.enabled);
      httpsPort.value = String((cur.https && cur.https.port) || 5443);
      httpLocalOnly.value = !cur.security || cur.security.httpLocalOnly !== false;
      cidrs.value = (cur.security && Array.isArray(cur.security.allowedRemoteCidrs)) ? cur.security.allowedRemoteCidrs : [];
      // 憑證模式預設
      certMode.value = currentCert.value ? 'keep' : 'generate';
      if (!certCommonName.value && clientIp.value) {
        const iface = (s.localInterfaces || []).find((i: any) => i.address === clientIp.value);
        certCommonName.value = iface ? iface.name : (clientIp.value || 'localhost');
      }
      if (!certSan.value && (cur.https && cur.https.certFile)) {
        // 保留現有 SAN 預設為空（產生時再填）
      }
    } catch (e) {
      toast('載入網路設定失敗：' + e.message, 'err');
    } finally {
      loading.value = false;
    }
  }

  function applyScenario(scn: string) {
    scenario.value = scn;
    const p = scenarioPreset(scn, suggestedCidrs.value);
    if (!p) return;
    httpsEnabled.value = p.enabled;
    httpLocalOnly.value = p.httpLocalOnly;
    cidrs.value = p.cidrs;
    certMode.value = p.certMode as any;
    toast(p.note, 'info');
  }

  // 目前模式：單機版（預設） / 網路版（已啟用外部存取）
  function networkMode(): boolean {
    const s = statusData.value;
    if (!s || !s.current) return false;
    const cur = s.current;
    const cidrs = (cur.security && Array.isArray(cur.security.allowedRemoteCidrs)) ? cur.security.allowedRemoteCidrs : [];
    const httpsEnabled = !!(cur.https && cur.https.enabled);
    return httpsEnabled || cidrs.length > 0;
  }

  function addCidr() {
    const v = cidrInput.value.trim();
    if (!v) return;
    if (!/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(v)) {
      toast('CIDR 格式不正確，例如 192.168.0.0/24', 'err');
      return;
    }
    if (v === '0.0.0.0/0') {
      confirmOpenAll.value = true;
      // 仍加入，但需使用者於對話框再次確認
    }
    if (!cidrs.value.includes(v)) cidrs.value = [...cidrs.value, v];
    cidrInput.value = '';
  }
  function removeCidr(v: string) {
    cidrs.value = cidrs.value.filter((c) => c !== v);
  }
  function addSuggested(s: string) {
    if (!cidrs.value.includes(s)) cidrs.value = [...cidrs.value, s];
  }

  async function doTest() {
    testing.value = true;
    testResult.value = null;
    try {
      const r = await api.post('/network/test-connection', {
        cidrs: cidrs.value,
        enabled: httpsEnabled.value,
        httpLocalOnly: httpLocalOnly.value,
        ip: clientIp.value,
      });
      testResult.value = r;
      if (r.allowed) toast('預檢通過：套用後此裝置仍可連線', 'ok');
      else toast('⚠️ ' + r.reason, 'err');
    } catch (e) {
      testResult.value = { allowed: false, reason: e.message };
      toast('連線測試失敗：' + e.message, 'err');
    } finally {
      testing.value = false;
    }
  }

  async function doGenerate() {
    const cn = certCommonName.value.trim();
    if (!cn) { toast('請填寫憑證名稱（CN）', 'err'); return; }
    generating.value = true;
    try {
      const san = certSan.value.split(',').map((s) => s.trim()).filter(Boolean);
      const r = await api.post('/network/cert-generate', { commonName: cn, san, days: Number(certDays.value) || 3650 });
      generated.value = r;
      certMode.value = 'generate';
      toast('自簽憑證已產生：' + r.fingerprint, 'ok');
    } catch (e) {
      toast('憑證產生失敗：' + e.message, 'err');
    } finally {
      generating.value = false;
    }
  }

  async function doApply() {
    if (!httpsEnabled.value) {
      // 關閉 HTTPS：仍走 httpLocalOnly（5200 本機）
      toast('關閉 HTTPS 後，系統僅於本機 5200 提供服務。', 'info');
    }
    // 防鎖死預檢（前端先擋一次）
    if (httpLocalOnly.value && httpsEnabled.value && !isLoopback(clientIp.value)) {
      if (!cidrs.value.some((c) => c === '0.0.0.0/0' || cidrCovers(c, clientIp.value))) {
        const ok = await window.confirm(
          '目前的設定可能切斷您現在的連線（您的 IP ' + clientIp.value + ' 不在允許清單內）。\n' +
          '若繼續，您可能需改用本機或加入該 IP 後再行設定。\n仍要套用嗎？'
        );
        if (!ok) return;
      }
    }
    saving.value = true;
    try {
      const body: any = {
        https: { enabled: httpsEnabled.value, port: Number(httpsPort.value) || 5443 },
        security: { httpLocalOnly: httpLocalOnly.value, allowedRemoteCidrs: cidrs.value },
        certMode: certMode.value,
      };
      if (certMode.value === 'generate' && generated.value) {
        body.certPath = generated.value.certPath;
        body.keyPath = generated.value.keyPath;
      }
      if (certMode.value === 'upload') {
        body.certPem = uploadedCertPem.value;
        body.keyPem = uploadedKeyPem.value;
        if (!body.certPem || !body.keyPem) { toast('請貼上憑證與私鑰 PEM', 'err'); saving.value = false; return; }
      }
      const r = await api.post('/network/apply', body);
      pending.value = { appliedAt: Date.now(), expiresAt: r.expiresAt, remainingMs: r.expiresAt - Date.now() };
      toast('✅ ' + (r.message || '已套用，請於其他裝置確認'), 'ok');
      // 重啟後重新載入狀態
      setTimeout(() => loadStatus(), 4000);
    } catch (e) {
      toast('套用失敗：' + e.message, 'err');
    } finally {
      saving.value = false;
    }
  }

  async function doConfirm() {
    confirming.value = true;
    try {
      await api.post('/network/confirm');
      pending.value = null;
      toast('已確認套用，網路設定正式生效', 'ok');
      await loadStatus();
    } catch (e) {
      toast('確認失敗：' + e.message, 'err');
    } finally {
      confirming.value = false;
    }
  }

  async function doCancel() {
    confirming.value = true;
    try {
      await api.post('/network/cancel');
      toast('已取消並復原原設定，系統重啟中', 'ok');
      setTimeout(() => loadStatus(), 4000);
    } catch (e) {
      toast('取消失敗：' + e.message, 'err');
    } finally {
      confirming.value = false;
    }
  }

  if (loading.value) {
    return <div class="card" style="padding:40px;text-align:center;color:#98A0AC">載入中…</div>;
  }

  const scnNote = scenario.value ? (scenarioPreset(scenario.value, suggestedCidrs.value) || {}).note : '';

  return (
    <div style="max-width:880px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <span style="font-size:26px">🌐</span>
        <h2 style="font-size:20px;color:#0F766E;margin:0">管理者網路設定</h2>
      </div>
      <p style="font-size:13px;color:#6B7280;margin:0 0 14px">
        自助設定「內部 IP 存取 / 對外固定 IP / 網域 + DDNS」與 HTTPS 加密。套用後有
        <b>{Math.round(rollbackSeconds.value / 60)} 分鐘</b>待確認視窗，未確認將自動復原，<b>不會把自己鎖死</b>。
      </p>

      {/* 供應商專屬 + 單機版/網路版 指示 banner */}
      <div style="background:#FEF2F2;border:1px solid #FCA5A5;border-left:4px solid #DC2626;padding:12px 16px;border-radius:8px;margin-bottom:16px">
        <div style="font-size:13px;font-weight:700;color:#991B1B;margin-bottom:4px">
          🔒 供應商專屬功能（單機版 / 網路版切換）
        </div>
        <div style="font-size:12.5px;color:#7F1D1D;line-height:1.6">
          本頁僅 <b>供應商交付帳號（超級管理員）</b> 可見與操作，權限模式與「授權管理」相同。
          安裝包預設為 <b>單機版</b>；當您於此啟用 HTTPS 對外存取與允許網段後，即轉為 <b>網路版</b>（支援多機連線）。
        </div>
        <div style="font-size:12.5px;color:#374151;margin-top:6px">
          目前模式：
          <b style="color:{networkMode() ? '#0F766E' : '#6B7280'}">
            {networkMode() ? '🌐 網路版（已啟用外部存取）' : '💻 單機版（預設，僅本機）'}
          </b>
        </div>
      </div>

      {/* 待確認回滾 banner */}
      {pending.value && (
        <div style="background:#FFF7ED;border:1px solid #FDBA74;border-left:4px solid #EA580C;padding:14px 16px;border-radius:8px;margin-bottom:16px">
          <div style="font-size:14px;font-weight:700;color:#9A3412;margin-bottom:6px">
            ⏳ 網路設定已套用，待您於「其他裝置」確認（{Math.floor(countdown.value / 60)} 分 {countdown.value % 60} 秒後自動復原）
          </div>
          <div style="font-size:13px;color:#7C2D12;margin-bottom:10px">
            請從另一台裝置（或同區網手機）重新開啟本系統並進入「網路設定」點擊「確認套用」。若無法連線，請等待自動復原，或在本機點擊「取消復原」。
          </div>
          <div style="display:flex;gap:10px">
            <button onClick={doConfirm} disabled={confirming.value}
              style="padding:8px 18px;background:#0F766E;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;opacity:${confirming.value ? 0.6 : 1}">
              {confirming.value ? '確認中…' : '✅ 確認套用（正式生效）'}
            </button>
            <button onClick={doCancel} disabled={confirming.value}
              style="padding:8px 18px;background:#fff;color:#9A3412;border:1px solid #FDBA74;border-radius:8px;font-size:14px;cursor:pointer;opacity:${confirming.value ? 0.6 : 1}">
              取消並復原
            </button>
          </div>
        </div>
      )}

      {/* 本機網路資訊面板 */}
      <div class="card" style="margin-bottom:16px">
        <h3 style="font-size:15px;color:#0F766E;margin-bottom:10px">本機網路資訊</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;font-size:13px">
          <div style="background:#F4F6F8;border-radius:8px;padding:8px 10px">
            <div style="color:#98A0AC;font-size:11px">您目前的連線 IP</div>
            <div style="font-weight:700;color:#1F2937">{clientIp.value || '—'}</div>
          </div>
          {(localInterfaces.value || []).map((i: any) => (
            <div style="background:#F4F6F8;border-radius:8px;padding:8px 10px" key={i.name + i.address}>
              <div style="color:#98A0AC;font-size:11px">{i.name}{i.internal ? '（內部）' : ''}</div>
              <div style="font-weight:700;color:#1F2937">{i.address}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 場景精靈 */}
      <div class="card" style="margin-bottom:16px">
        <h3 style="font-size:15px;color:#0F766E;margin-bottom:6px">① 選擇佈署場景</h3>
        <p style="font-size:12.5px;color:#6B7280;margin:0 0 12px">
          依您的網路環境選擇，系統會自動預填下方設定；您仍可手動調整。
        </p>
        <div style="display:flex;flex-wrap:wrap;gap:10px">
          <button onClick={() => applyScenario('lan')}
            style={scenario.value === 'lan' ? btnActive : btnIdle}>
            🏠 內網（同區網）
          </button>
          <button onClick={() => applyScenario('public')}
            style={scenario.value === 'public' ? btnActive : btnIdle}>
            🌍 對外固定 IP
          </button>
          <button onClick={() => applyScenario('ddns')}
            style={scenario.value === 'ddns' ? btnActive : btnIdle}>
            🔗 網域 + DDNS
          </button>
        </div>
        {scnNote && (
          <div style="background:#ECFDF5;border-left:3px solid #0F766E;padding:10px 14px;border-radius:6px;font-size:13px;color:#115E59;margin-top:12px">
            💡 {scnNote}
          </div>
        )}
      </div>

      {/* HTTPS 設定 */}
      <div class="card" style="margin-bottom:16px">
        <h3 style="font-size:15px;color:#0F766E;margin-bottom:12px">② HTTPS 加密設定</h3>
        <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;margin-bottom:12px">
          <input type="checkbox" checked={httpsEnabled.value}
            onChange={(e: any) => (httpsEnabled.value = e.currentTarget.checked)}
            style="width:16px;height:16px" />
          啟用 HTTPS（推薦，外部存取必須加密）
        </label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;opacity:${httpsEnabled.value ? 1 : 0.5}">
          <div>
            <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px">HTTPS 連接埠</label>
            <input type="text" value={httpsPort.value} disabled={!httpsEnabled.value}
              onInput={(e: any) => (httpsPort.value = e.currentTarget.value)}
              style="width:100%;padding:8px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px" />
            <div style="font-size:11px;color:#98A0AC;margin-top:2px">預設 5443。注意：5200 為內部 HTTP 專用，<b>永不對外</b>。</div>
          </div>
          <div>
            <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px">HTTP 本機限制</label>
            <label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px;cursor:pointer">
              <input type="checkbox" checked={httpLocalOnly.value}
                onChange={(e: any) => (httpLocalOnly.value = e.currentTarget.checked)}
                style="width:16px;height:16px" />
              僅允許本機走 HTTP（:5200 只回 127.0.0.1）
            </label>
            <div style="font-size:11px;color:#98A0AC;margin-top:2px">開啟後，外部 IP 只能走 HTTPS（:5443）。</div>
          </div>
        </div>
      </div>

      {/* 憑證三模式 */}
      <div class="card" style="margin-bottom:16px">
        <h3 style="font-size:15px;color:#0F766E;margin-bottom:6px">③ TLS 憑證</h3>
        <p style="font-size:12.5px;color:#6B7280;margin:0 0 12px">
          憑證用於 HTTPS 加密。系統內建「自簽憑證產生器」，客戶完全免命令列即可使用（無須安裝 openssl）。
        </p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">
          <button onClick={() => (certMode.value = 'keep')} style={certMode.value === 'keep' ? tabActive : tabIdle}>保留現有</button>
          <button onClick={() => (certMode.value = 'generate')} style={certMode.value === 'generate' ? tabActive : tabIdle}>產生自簽</button>
          <button onClick={() => (certMode.value = 'upload')} style={certMode.value === 'upload' ? tabActive : tabIdle}>上傳 PEM</button>
          <span style="font-size:11px;color:#98A0AC;align-self:center">（ACME / Let's Encrypt 自動續期為選配，未含於標準包）</span>
        </div>

        {certMode.value === 'keep' && (
          <div style="background:#F4F6F8;border-radius:8px;padding:12px;font-size:13px;color:#374151">
            將沿用目前的憑證：{currentCert.value
              ? <span><b>{currentCert.value.subject}</b>（有效期至 {fmtDate(currentCert.value.validTo)}）
                {currentCert.value.selfSigned ? '，自簽憑證' : ''}</span>
              : <span style="color:#B45309">目前無可用憑證，請改用「產生自簽」或「上傳 PEM」。</span>}
          </div>
        )}

        {certMode.value === 'generate' && (
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
            <div>
              <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px">憑證名稱（CN）</label>
              <input type="text" value={certCommonName.value}
                onInput={(e: any) => (certCommonName.value = e.currentTarget.value)}
                placeholder="例如：www.fuhuang.com.tw 或 DESKTOP-XXX"
                style="width:100%;padding:8px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px" />
            </div>
            <div>
              <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px">有效期（天）</label>
              <input type="text" value={certDays.value}
                onInput={(e: any) => (certDays.value = e.currentTarget.value)}
                style="width:100%;padding:8px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px" />
            </div>
            <div style="grid-column:1 / -1">
              <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px">主體備用名稱（SAN，逗號分隔）</label>
              <input type="text" value={certSan.value}
                onInput={(e: any) => (certSan.value = e.currentTarget.value)}
                placeholder="例如：www.fuhuang.com.tw, fuhuang.com.tw, 192.168.0.92"
                style="width:100%;padding:8px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px" />
              <div style="font-size:11px;color:#98A0AC;margin-top:2px">填入您的網域與本機 IP，客戶端才不會跳出憑證警告。留空則僅含 CN。</div>
            </div>
            <div style="grid-column:1 / -1">
              <button onClick={doGenerate} disabled={generating.value}
                style="padding:10px 20px;background:#1B8A3A;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;opacity:${generating.value ? 0.6 : 1}">
                {generating.value ? '產生中…' : '🔐 產生自簽憑證'}
              </button>
            </div>
            {generated.value && (
              <div style="grid-column:1 / -1;background:#ECFDF5;border:1px solid #A7F3D0;border-radius:8px;padding:12px">
                <div style="font-size:13px;color:#065F46;margin-bottom:6px">
                  ✅ 已產生自簽憑證
                </div>
                <div style="font-size:12px;color:#374151;margin-bottom:6px">
                  SHA-256 指紋：<code style="background:#fff;padding:2px 6px;border-radius:4px;word-break:break-all">{generated.value.fingerprint}</code>
                </div>
                <div style="font-size:12px;color:#374151;margin-bottom:8px">
                  請將此 <b>.crt</b> 匯入客戶端「信任的根憑證授權單位」，再點擊下方「套用」。
                </div>
                <div style="display:flex;gap:10px">
                  <button onClick={() => downloadText('selfsigned.crt', generated.value.certPem)}
                    style="padding:6px 14px;background:#0F766E;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer">
                    ⬇️ 下載根憑證 (.crt)
                  </button>
                  <button onClick={() => downloadText('selfsigned.key', generated.value.keyPem)}
                    style="padding:6px 14px;background:#fff;color:#0F766E;border:1px solid #0F766E;border-radius:6px;font-size:13px;cursor:pointer">
                    ⬇️ 下載私鑰 (.key)
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {certMode.value === 'upload' && (
          <div style="display:grid;grid-template-columns:1fr;gap:14px">
            <div>
              <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px">憑證 PEM（含 BEGIN/END CERTIFICATE）</label>
              <textarea value={uploadedCertPem.value}
                onInput={(e: any) => (uploadedCertPem.value = e.currentTarget.value)}
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                style="width:100%;min-height:120px;padding:8px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:12px;font-family:monospace;resize:vertical" />
            </div>
            <div>
              <label style="display:block;font-size:13px;font-weight:600;color:#333;margin-bottom:4px">私鑰 PEM（含 BEGIN/END PRIVATE KEY）</label>
              <textarea value={uploadedKeyPem.value}
                onInput={(e: any) => (uploadedKeyPem.value = e.currentTarget.value)}
                placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                style="width:100%;min-height:120px;padding:8px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:12px;font-family:monospace;resize:vertical" />
            </div>
          </div>
        )}
      </div>

      {/* CIDR 允許清單 */}
      <div class="card" style="margin-bottom:16px">
        <h3 style="font-size:15px;color:#0F766E;margin-bottom:6px">④ 允許連線的網段（CIDR）</h3>
        <p style="font-size:12.5px;color:#6B7280;margin:0 0 12px">
          僅清單內的 IP 可透過 HTTPS（:{httpsEnabled.value ? httpsPort.value : '5443'}）連線。本機回路恆允許。
        </p>

        {/* 建議本機網段 */}
        {suggestedCidrs.value.length > 0 && (
          <div style="margin-bottom:10px">
            <div style="font-size:12px;color:#98A0AC;margin-bottom:4px">建議本機網段（點擊加入）：</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              {suggestedCidrs.value.map((s: string) => (
                <button key={s} onClick={() => addSuggested(s)}
                  disabled={cidrs.value.includes(s)}
                  style="padding:4px 10px;background:#EFF6FF;color:#1D4ED8;border:1px solid #BFDBFE;border-radius:16px;font-size:12px;cursor:${cidrs.value.includes(s) ? 'default' : 'pointer'}">
                  ➕ {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style="display:flex;gap:8px;margin-bottom:10px">
          <input type="text" value={cidrInput.value}
            onInput={(e: any) => (cidrInput.value = e.currentTarget.value)}
            onKeyDown={(e: any) => { if (e.key === 'Enter') addCidr(); }}
            placeholder="例如：192.168.0.0/24 或 0.0.0.0/0（全部）"
            style="flex:1;padding:8px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px" />
          <button onClick={addCidr}
            style="padding:8px 18px;background:#0F766E;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer">
            加入
          </button>
        </div>

        {cidrs.value.length === 0 && (
          <div style="font-size:12px;color:#B45309;background:#FFFBEB;border-left:3px solid #F59E0B;padding:8px 12px;border-radius:6px">
            ⚠️ 目前允許清單為空。啟用 HTTPS 後除本機外，<b>任何裝置都無法連線</b>。請至少加入一個網段（如 192.168.0.0/24）。
          </div>
        )}

        {cidrs.value.length > 0 && (
          <ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px">
            {cidrs.value.map((c: string) => (
              <li key={c} style="display:flex;align-items:center;justify-content:space-between;background:#F4F6F8;border-radius:8px;padding:8px 12px;font-size:13px">
                <span>
                  {c}
                  {c === '0.0.0.0/0' && <span style="color:#B45309">（⚠️ 開放全部 IP）</span>}
                  {c !== '0.0.0.0/0' && c.includes(clientIp.value.split('.').slice(0, 3).join('.')) && !isLoopback(clientIp.value)
                    ? <span style="color:#1B8A3A">（含您目前的 IP）</span> : null}
                </span>
                <button onClick={() => removeCidr(c)}
                  style="background:none;border:none;color:#DC2626;cursor:pointer;font-size:13px">✕</button>
              </li>
            ))}
          </ul>
        )}

        <div style="margin-top:12px;display:flex;gap:10px;align-items:center">
          <button onClick={doTest} disabled={testing.value}
            style="padding:8px 16px;background:#F4F6F8;color:#374151;border:1px solid #D1D5DB;border-radius:8px;font-size:13px;cursor:pointer;opacity:${testing.value ? 0.6 : 1}">
            {testing.value ? '測試中…' : '🧪 測試連線（防鎖死預檢）'}
          </button>
          {testResult.value && (
            <span style={testResult.value.allowed ? 'color:#1B8A3A;font-size:13px' : 'color:#DC2626;font-size:13px'}>
              {testResult.value.allowed ? '✅ ' : '❌ '}{testResult.value.reason}
            </span>
          )}
        </div>
      </div>

      {/* 套用 */}
      <div class="card" style="margin-bottom:16px">
        <h3 style="font-size:15px;color:#0F766E;margin-bottom:8px">⑤ 套用設定</h3>
        <p style="font-size:12.5px;color:#6B7280;margin:0 0 14px">
          套用將寫入設定並重啟系統。隨後有 <b>{Math.round(rollbackSeconds.value / 60)} 分鐘</b>待確認視窗：
          請於<b>其他裝置</b>重新登入並點擊「確認套用」；若未確認或連不上，系統會<b>自動復原原設定</b>。
        </p>
        <div style="display:flex;gap:10px">
          <button onClick={doApply} disabled={saving.value}
            style="padding:12px 28px;background:#0F766E;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;opacity:${saving.value ? 0.6 : 1}">
            {saving.value ? '套用中…' : '💾 套用並重啟'}
          </button>
          <button onClick={loadStatus} disabled={saving.value}
            style="padding:12px 20px;background:#F4F6F8;color:#333;border:1px solid #D1D5DB;border-radius:8px;font-size:14px;cursor:pointer">
            重新載入
          </button>
        </div>
      </div>

      {/* 操作小提示 */}
      <div style="font-size:11px;color:#98A0AC;line-height:1.7">
        ℹ️ 路由器端的「DHCP 保留（固定本機 IP）」「防火牆開放 {httpsEnabled.value ? httpsPort.value : '5443'}」與（對外時）「連接埠轉發 / DDNS」需由客戶在路由器自行設定；
        本系統負責監聽、加密與允許清單。
      </div>

      {/* 開放全部二次確認對話框 */}
      {confirmOpenAll.value && (
        <div style="position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:999"
          onClick={() => (confirmOpenAll.value = false)}>
          <div style="background:#fff;border-radius:12px;padding:24px;max-width:420px" onClick={(e: any) => e.stopPropagation()}>
            <div style="font-size:16px;font-weight:700;color:#9A3412;margin-bottom:10px">⚠️ 確認開放 0.0.0.0/0？</div>
            <div style="font-size:13px;color:#374151;line-height:1.7;margin-bottom:16px">
              這會允許<b>網際網路上任何 IP</b> 連線。請確認您已設定強密碼，且明瞭此舉的安全性風險。
            </div>
            <div style="display:flex;gap:10px;justify-content:flex-end">
              <button onClick={() => (confirmOpenAll.value = false)}
                style="padding:8px 16px;background:#F4F6F8;color:#333;border:1px solid #D1D5DB;border-radius:8px;font-size:14px;cursor:pointer">
                取消
              </button>
              <button onClick={() => { confirmOpenAll.value = false; toast('已加入 0.0.0.0/0，請確保密碼強度', 'info'); }}
                style="padding:8px 16px;background:#EA580C;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">
                我了解，加入
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- 樣式常數 ---- */
const btnActive = 'padding:10px 16px;background:#0F766E;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer';
const btnIdle = 'padding:10px 16px;background:#F4F6F8;color:#333;border:1px solid #D1D5DB;border-radius:8px;font-size:14px;cursor:pointer';
const tabActive = 'padding:8px 16px;background:#0F766E;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer';
const tabIdle = 'padding:8px 16px;background:#fff;color:#374151;border:1px solid #D1D5DB;border-radius:8px;font-size:13px;cursor:pointer';

/* ---- 工具 ---- */
function fmtDate(s: string) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString('zh-TW'); } catch { return s; }
}
function isLoopback(ip: string) {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.0.0.1');
}
// 簡易 CIDR 包含判斷（與後端同義）
function cidrCovers(cidr: string, ip: string) {
  try {
    const [net, bitsStr] = cidr.split('/');
    const bits = Number(bitsStr);
    const toInt = (a: string) => {
      const p = a.split('.').map(Number);
      return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
    };
    const mask = bits === 0 ? 0 : bits === 32 ? 0xffffffff : (((1 << bits) - 1) << (32 - bits)) >>> 0;
    return (toInt(net) & mask) === (toInt(ip) & mask);
  } catch { return false; }
}

NetworkSettings.title = '網路設定';
