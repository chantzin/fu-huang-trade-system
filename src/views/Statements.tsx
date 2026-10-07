// 客戶對帳單
import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';
import Table from '../ui/Table.tsx';
import Pagination from '../ui/Pagination.tsx';
import Modal, { confirmDialog } from '../ui/Modal.tsx';
import PdfPreviewModal from '../ui/PdfPreviewModal.tsx';
import EmailModal from '../ui/EmailModal.tsx';
import { esc, num, date } from '../ui/format.ts';

export default function Statements() {
  const rows = useSignal([]);
  const customers = useSignal([]);
  const loading = useSignal(true);
  const showModal = useSignal(false);
  const editing = useSignal(null);
  const previewUrl = useSignal('');
  const showPreview = useSignal(false);
  const emailIds = useSignal([]);
  const showEmailModal = useSignal(false);
  const page = useSignal(1);
  const pageSize = useSignal(20);

  const load = async () => {
    loading.value = true;
    try {
      const [list, cust] = await Promise.all([api.get('/customer-statements'), api.get('/customers')]);
      rows.value = list;
      customers.value = cust;
    } catch (e: any) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };
  useEffect(() => { load(); }, []);

  const onListChange = (e: any) => { if (e.target && e.target.id === 'sel-all') { const chk = e.target.checked; document.querySelectorAll('.sel-one').forEach((el: any) => (el.checked = chk)); } };
  const paged = rows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value);

  const del = async (r: any) => {
    if (await confirmDialog(`確定刪除對帳單「${r.statement_no}」？`)) {
      try { await api.del('/customer-statements/' + r.id); toast('已刪除', 'ok'); load(); }
      catch (e: any) { toast(e.message, 'err'); }
    }
  };
  const preview = (r: any) => {
    previewUrl.value = `/api/pdf/customer-statements/${r.id}?token=${encodeURIComponent(localStorage.getItem('app_token') || '')}`;
    showPreview.value = true;
  };
  const download = (r: any) => api.downloadPdf(`/pdf/customer-statements/${r.id}`, `對帳單_${r.statement_no}.pdf`);

  const doBatchEmail = () => {
    const ids = Array.from(document.querySelectorAll('.sel-one:checked')).map((el: any) => Number(el.dataset.id));
    if (!ids.length) return toast('請先勾選要寄的對帳單', 'warn');
    emailIds.value = ids;
    showEmailModal.value = true;
  };
  const doSendEmails = async (p: any) => {
    try {
      const r = await api.sendEmail('/email/send-batch', {
        items: emailIds.value.map((id: any) => ({ type: 'statement', id })),
        to: p.to,
        subject: p.subject || `客戶對帳單通知（${emailIds.value.length} 份）`,
        html: p.html,
        bcc: p.bcc,
        extraAttachments: p.extraAttachments,
      });
      toast(`已寄出 ${r.sent} 封郵件` + (r.skipped && r.skipped.length ? `，${r.skipped.length} 組略過` : ''), 'ok');
      if (r.details && r.details[0] && r.details[0].previewUrl) toast('測試模式：預覽郵件 ' + r.details[0].previewUrl, 'ok');
    } catch (e: any) { toast(e.message, 'err'); }
  };

  const columns = [
    { key: '_sel', label: '<input type="checkbox" id="sel-all" />', html: true, render: (r: any) => `<input type="checkbox" class="sel-one" data-id="${r.id}" />` },
    { key: 'statement_no', label: '對帳單號', render: (r: any) => `<b>${esc(r.statement_no)}</b>` },
    { key: 'customer_name', label: '客戶' },
    { key: 'period_start', label: '起', render: (r: any) => date(r.period_start) },
    { key: 'period_end', label: '訖', render: (r: any) => date(r.period_end) },
    { key: 'subtotal', label: '未稅金額', num: true, render: (r: any) => num(r.subtotal) },
    { key: 'tax_amount', label: '營業稅', num: true, render: (r: any) => num(r.tax_amount) },
    { key: 'grand_total', label: '總計', num: true, render: (r: any) => `<b>${num(r.grand_total)}</b>` },
    { key: 'payment_terms', label: '付款條件' },
    { key: 'created_by_name', label: '製單者' },
    { key: 'created_at', label: '建立時間', render: (r: any) => date(r.created_at) },
  ];

  return (
    <>
      <div class="toolbar">
        <div class="spacer" />
        <button class="btn btn-primary" onClick={() => { editing.value = null; showModal.value = true; }}>＋ 新增對帳單</button>
        <button class="btn btn-mail" onClick={doBatchEmail}>批次寄 E-mail</button>
      </div>
      {loading.value
        ? <div class="empty">載入中…</div>
        : <>
            <Table columns={columns} rows={paged} onChange={onListChange} actions={(r: any) => (
              <div style="display:flex;gap:6px;white-space:nowrap">
                <button class="btn btn-sm" onClick={() => preview(r)}>預覽</button>
                <button class="btn btn-sm btn-pdf" onClick={() => download(r)}>📄 PDF</button>
                <button class="btn btn-sm btn-danger" onClick={() => del(r)}>刪除</button>
              </div>
            )} />
            <Pagination page={page.value} pageSize={pageSize.value} total={rows.value.length}
              onPageChange={(p: any) => (page.value = p)}
              onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
          </>}
      {showModal.value && (
        <StatementFormModal custList={customers.value} onClose={() => { showModal.value = false; load(); }} />
      )}
      {showPreview.value && (
        <PdfPreviewModal title="對帳單預覽" pdfUrl={previewUrl.value}
          onClose={() => (showPreview.value = false)} />
      )}
      {showEmailModal.value && (
        <EmailModal count={emailIds.value.length} type="對帳單"
          defaultEmails={emailIds.value.map((id: any) => rows.value.find((r: any) => String(r.id) === String(id))?.customer_email || '').filter(Boolean).filter((v: any, i: any, a: any) => a.indexOf(v) === i).join(', ')}
          defaultSubject="感謝貴公司，隨函附上本月對帳單，請查閱並核對，如有任何問題請與我司聯繫。"
          attachments={emailIds.value.map((id: any) => rows.value.find((r: any) => String(r.id) === String(id))?.statement_no || '').filter(Boolean).map((no: any) => `statement-${no}.pdf`)}
          onConfirm={doSendEmails}
          onClose={() => (showEmailModal.value = false)} />
      )}
    </>
  );
}
Statements.title = '客戶對帳單';

function StatementFormModal({ custList, onClose }: any) {
  const today = new Date().toISOString().slice(0, 10);
  const form = useSignal({
    customer_id: 0,
    period_start: today.slice(0, 8) + '01',
    period_end: today,
    payment_terms: '月結90天',
    note: '',
  });
  const busy = useSignal(false);
  const set = (k: any, v: any) => (form.value = { ...form.value, [k]: v });

  const save = async () => {
    const f = form.value;
    if (!Number(f.customer_id)) return toast('請選擇客戶', 'warn');
    if (!f.period_start || !f.period_end) return toast('請填列帳起訖日', 'warn');
    busy.value = true;
    try {
      await api.post('/customer-statements', f);
      toast('對帳單已建立', 'ok');
      onClose();
    } catch (e: any) { toast(e.message, 'err'); }
    finally { busy.value = false; }
  };

  return (
    <Modal title="新增對帳單" saveText="建立" onSave={save} onClose={onClose}>
      <div class="form-grid">
        <div>
          <label class="f">客戶 *</label>
          <select value={form.value.customer_id} onChange={(e: any) => set('customer_id', Number(e.currentTarget.value))} style="width:100%">
            <option value={0}>（請選擇）</option>
            {custList.map((c: any) => <option value={c.id}>{esc(c.name)}</option>)}
          </select>
        </div>
        <div><label class="f">列帳起日 *</label><input type="date" value={form.value.period_start} onInput={(e: any) => set('period_start', e.currentTarget.value)} /></div>
        <div><label class="f">列帳訖日 *</label><input type="date" value={form.value.period_end} onInput={(e: any) => set('period_end', e.currentTarget.value)} /></div>
        <div><label class="f">付款條件</label><input value={form.value.payment_terms} onInput={(e: any) => set('payment_terms', e.currentTarget.value)} /></div>
        <div style="grid-column:1/-1"><label class="f">備註</label><textarea value={form.value.note} onInput={(e: any) => set('note', e.currentTarget.value)} rows={2} style="width:100%" /></div>
      </div>
      <div class="calc-note">建立時系統自動抓該客戶於列帳區間內的出貨明細。</div>
      {busy.value && <div style="font-size:12px;color:#6b7280;margin-top:6px">產生中…</div>}
    </Modal>
  );
}
