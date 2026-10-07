import { useSignal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import api from '../api.ts';
import { toast } from '../store.ts';
import Modal from '../ui/Modal.tsx';
import Table from '../ui/Table.tsx';
import Pagination from '../ui/Pagination.tsx';
import { esc, date, tag } from '../ui/format.ts';
import TipTapEditor from '../components/TipTapEditor.tsx';

const STATUS: any = { draft: '草稿', final: '定稿' };
const STATUS_TAG: any = { draft: 'gray', final: 'green' };

/* ====================== 主頁：文件＋模板 雙頁籤 ====================== */
export default function FormEditor() {
  const tab = useSignal('docs');
  return (
    <>
      <div class="toolbar">
        <div class="tabs">
          <button class={tab.value === 'docs' ? 'tab active' : 'tab'} onClick={() => (tab.value = 'docs')}>文件</button>
          <button class={tab.value === 'tpl' ? 'tab active' : 'tab'} onClick={() => (tab.value = 'tpl')}>模板管理</button>
        </div>
      </div>
      {tab.value === 'docs' ? <DocsTab /> : <TemplatesTab />}
    </>
  );
}
FormEditor.title = '表單編輯';

/* ====================== 文件頁籤 ====================== */
function DocsTab() {
  const rows = useSignal<any[]>([]);
  const kw = useSignal('');
  const loading = useSignal(true);
  const showModal = useSignal(false);
  const editing = useSignal<any>(null);
  const page = useSignal(1);
  const pageSize = useSignal(20);

  const load = async () => {
    loading.value = true;
    try {
      const list = await api.get('/forms/documents');
      rows.value = list;
    } catch (e: any) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };
  useEffect(() => { load(); }, []);
  const resetPage = () => (page.value = 1);

  const filtered = useMemo(() => {
    const k = kw.value.trim();
    if (!k) return rows.value;
    return rows.value.filter((d: any) =>
      String(d.doc_no || '').includes(k) || String(d.title || '').includes(k) ||
      String(d.template_name || '').includes(k) || String(d.created_by || '').includes(k));
  }, [rows.value, kw.value]);
  const pagedRows = useMemo(() => {
    const start = (page.value - 1) * pageSize.value;
    return filtered.slice(start, start + pageSize.value);
  }, [filtered, page.value, pageSize.value]);

  const openNew = () => { editing.value = null; showModal.value = true; };
  const openEdit = (d: any) => { editing.value = d; showModal.value = true; };
  const doPrint = (d: any) => { window.open(`/api/forms/documents/${d.id}/render?token=${encodeURIComponent(localStorage.getItem('app_token') || '')}`, '_blank'); };
  const doDelete = async (d: any) => {
    if (!confirm(`確定刪除文件 ${d.doc_no}（${d.title}）？`)) return;
    try { await api.del('/forms/documents/' + d.id); toast('已刪除', 'ok'); load(); }
    catch (e: any) { toast(e.message, 'err'); }
  };
  const onListClick = (e: any) => {
    const t = e.target;
    const id = t.dataset.edit || t.dataset.print || t.dataset.del;
    if (!id) return;
    const cur = rows.value.find((r: any) => String(r.id) === String(id));
    if (!cur) return;
    if (t.dataset.edit) openEdit(cur);
    else if (t.dataset.print) doPrint(cur);
    else if (t.dataset.del) doDelete(cur);
  };

  const columns = [
    { key: 'doc_no', label: '文件號', render: (r: any) => `<b>${esc(r.doc_no)}</b>` },
    { key: 'title', label: '標題', render: (r: any) => `<span class="cell-ellipsis" title="${esc(r.title || '')}">${esc(r.title || '')}</span>` },
    { key: 'template_name', label: '模板', render: (r: any) => esc(r.template_name || '') },
    { key: 'status', label: '狀態', render: (r: any) => tag(STATUS[r.status] || r.status, STATUS_TAG[r.status] || 'gray') },
    { key: 'created_by', label: '建立人', render: (r: any) => esc(r.created_by || '') },
    { key: 'created_at', label: '建立時間', render: (r: any) => date(r.created_at) },
    { key: 'updated_at', label: '更新時間', render: (r: any) => date(r.updated_at) },
  ];

  return (
    <>
      <div class="toolbar">
        <div class="fld"><label>關鍵字</label><input value={kw.value} onInput={(e: any) => { kw.value = e.currentTarget.value; resetPage(); }} placeholder="文件號／標題／模板／建立人" /></div>
        <div class="spacer" />
        <button class="btn btn-primary" onClick={openNew}>＋ 新增文件</button>
      </div>
      {loading.value
        ? <div class="empty">載入中…</div>
        : <>
            <div onClick={onListClick}>
              <Table columns={columns} rows={pagedRows}
                actions={(r: any) => `<button class="btn btn-sm" data-edit="${r.id}">開啟</button><button class="btn btn-sm" data-print="${r.id}">列印</button><button class="btn btn-sm btn-danger" data-del="${r.id}">刪除</button>`} />
            </div>
            <Pagination page={page.value} pageSize={pageSize.value} total={filtered.length}
              onPageChange={(p: any) => (page.value = p)}
              onPageSizeChange={(s: any) => { pageSize.value = s; page.value = 1; }} />
          </>}
      {showModal.value && (
        <DocFormModal d={editing.value}
          onClose={() => (showModal.value = false)}
          onSaved={() => { showModal.value = false; load(); }} />
      )}
    </>
  );
}

/* ====================== 文件表單 Modal（新增／編輯＋插入欄位＋列印） ====================== */
function DocFormModal({ d, onClose, onSaved }: any) {
  const isNew = !d || !d.id;
  const templates = useSignal<any[]>([]);
  const fields = useSignal<any[]>([]);
  const customers = useSignal<any[]>([]);
  const orders = useSignal<any[]>([]);
  const shipments = useSignal<any[]>([]);
  const quotes = useSignal<any[]>([]);
  const products = useSignal<any[]>([]);
  const company = useSignal<any>({});

  const form = useSignal<any>({
    template_id: d?.template_id || 0,
    title: d?.title || '',
    status: d?.status || 'draft',
    remark: d?.remark || '',
    ref_data: d?.ref_data || '{}',
    content: d?.content || '',
  });
  let parsedRef: any = {};
  try { parsedRef = d?.ref_data ? JSON.parse(d.ref_data) : {}; } catch { /* ignore */ }
  const refSig = useSignal<any>(parsedRef);

  const loadRefs = async () => {
    try {
      const [ts, fs, cs, os, shs, qs, ps, cp] = await Promise.all([
        api.get('/forms/templates'), api.get('/forms/fields'), api.get('/customers'),
        api.get('/orders'), api.get('/shipments'), api.get('/quotes'), api.get('/products'),
        api.get('/company-profile'),
      ]);
      templates.value = ts; fields.value = fs; customers.value = cs; orders.value = os;
      shipments.value = shs; quotes.value = qs; products.value = ps;
      company.value = cp || {};
      if (isNew && !form.value.template_id && ts.length) {
        form.value.template_id = ts[0].id;
        form.value.content = ts[0].content || '';
      }
    } catch (e: any) { toast(e.message, 'err'); }
  };
  useEffect(() => { loadRefs(); }, []);

  const onTemplateChange = (tid: any) => {
    form.value.template_id = Number(tid);
    const t = templates.value.find((x: any) => x.id === Number(tid));
    if (t) form.value.content = t.content || '';
  };

  const save = async () => {
    if (!form.value.template_id) return toast('請選擇模板', 'err');
    if (!form.value.title.trim()) return toast('請輸入標題', 'err');
    const body = {
      template_id: form.value.template_id,
      title: form.value.title,
      content: form.value.content,
      status: form.value.status,
      remark: form.value.remark,
      ref_data: refSig.value,
    };
    try {
      if (isNew) await api.post('/forms/documents', body);
      else await api.put('/forms/documents/' + d.id, body);
      toast(isNew ? '文件已建立' : '文件已儲存', 'ok');
      onSaved();
    } catch (e: any) { toast(e.message, 'err'); }
  };


  return (
    <Modal title={isNew ? '新增文件' : `編輯文件 ${d.doc_no}`} wide
      body={''}
      saveText={isNew ? '建立文件' : '儲存'}
      onSave={save} onClose={onClose}>
      <div class="form-grid">
        <div class="fld"><label>模板</label>
          <select value={form.value.template_id} onChange={(e: any) => onTemplateChange(e.currentTarget.value)}>
            <option value="0">請選擇模板</option>
            {templates.value.map((t: any) => <option value={t.id}>{esc(t.name)}（{t.doc_type === 'builtin' ? '內建' : '自訂'}）</option>)}
          </select>
        </div>
        <div class="fld"><label>標題 *</label><input value={form.value.title} onInput={(e: any) => (form.value.title = e.currentTarget.value)} placeholder="文件標題（如：出貨單 — 弘遠 2026/09）" /></div>
        <div class="fld"><label>狀態</label>
          <select value={form.value.status} onChange={(e: any) => (form.value.status = e.currentTarget.value)}>
            {Object.entries(STATUS).map(([v, t]: any) => <option value={v}>{t}</option>)}
          </select>
        </div>
        <div class="fld"><label>備註</label><input value={form.value.remark} onInput={(e: any) => (form.value.remark = e.currentTarget.value)} /></div>
      </div>

      <div style="margin:10px 0 4px;font-size:12.5px;font-weight:600;color:#26324d;">抓取系統資料（帶入文件）</div>
      <div class="form-grid">
        <div class="fld"><label>客戶</label>
          <select value={refSig.value.customerId || 0} onChange={(e: any) => { refSig.value = { ...refSig.value, customerId: Number(e.currentTarget.value) || 0 }; }}>
            <option value="0">不帶入</option>{customers.value.map((c: any) => <option value={c.id}>{esc(c.name)}</option>)}
          </select></div>
        <div class="fld"><label>訂單</label>
          <select value={refSig.value.orderId || 0} onChange={(e: any) => { refSig.value = { ...refSig.value, orderId: Number(e.currentTarget.value) || 0 }; }}>
            <option value="0">不帶入</option>{orders.value.map((o: any) => <option value={o.id}>{esc(o.order_no)}（{esc(o.customer_name || '')}）</option>)}
          </select></div>
        <div class="fld"><label>出貨</label>
          <select value={refSig.value.shipmentId || 0} onChange={(e: any) => { refSig.value = { ...refSig.value, shipmentId: Number(e.currentTarget.value) || 0 }; }}>
            <option value="0">不帶入</option>{shipments.value.map((s: any) => <option value={s.id}>{esc(s.shipment_no)}</option>)}
          </select></div>
        <div class="fld"><label>報價單</label>
          <select value={refSig.value.quotationId || 0} onChange={(e: any) => { refSig.value = { ...refSig.value, quotationId: Number(e.currentTarget.value) || 0 }; }}>
            <option value="0">不帶入</option>{quotes.value.map((q: any) => <option value={q.id}>{esc(q.quotation_no)}（{esc(q.customer_name || '')}）</option>)}
          </select></div>
        <div class="fld"><label>產品</label>
          <select value={refSig.value.productId || 0} onChange={(e: any) => { refSig.value = { ...refSig.value, productId: Number(e.currentTarget.value) || 0 }; }}>
            <option value="0">不帶入</option>{products.value.map((p: any) => <option value={p.id}>{esc(p.part_no)} {esc(p.name)}</option>)}
          </select></div>
        <div class="fld"><label>數量</label><input type="number" value={refSig.value.qty || ''} onInput={(e: any) => (refSig.value = { ...refSig.value, qty: Number(e.currentTarget.value) || 0 })} /></div>
        <div class="fld"><label>單價</label><input type="number" value={refSig.value.unitPrice || ''} onInput={(e: any) => (refSig.value = { ...refSig.value, unitPrice: Number(e.currentTarget.value) || 0 })} /></div>
      </div>

            <div style="margin:10px 0 4px;font-size:12.5px;font-weight:600;color:#26324d;">文件內容（所見即所得）</div>
      <TipTapEditor value={form.value.content} fields={fields.value}
        onChange={(v: string) => (form.value.content = v)} />
      <div style="font-size:11.5px;color:#8a93a6;margin-top:4px;">
        如使用 Word 般直接編輯排版；點工具列「插入系統欄位」帶入資料（如「欄位」），列印時自動以實際資料替換；未帶入資料的欄位保留原樣。
      </div>

      {!isNew && (
        <div style="margin-top:10px;padding:8px 10px;background:#F7F9FC;border-radius:8px;font-size:12px;color:#555;">
          <b>列印／匯出 PDF：</b>儲存後點「列印」→ 系統會以完整版式（公司頁首＋替換後資料）開啟新視窗，可直接「另存 PDF」或列印。
          <button class="btn btn-sm" style="margin-left:8px;" onClick={() => window.open(`/api/forms/documents/${d.id}/render?token=${encodeURIComponent(localStorage.getItem('app_token') || '')}`, '_blank')}>列印此文件</button>
        </div>
      )}
    </Modal>
  );
}

/* ====================== 模板管理頁籤 ====================== */
function TemplatesTab() {
  const rows = useSignal<any[]>([]);
  const loading = useSignal(true);
  const showModal = useSignal(false);
  const editing = useSignal<any>(null);

  const load = async () => {
    loading.value = true;
    try { rows.value = await api.get('/forms/templates'); }
    catch (e: any) { toast(e.message, 'err'); }
    finally { loading.value = false; }
  };
  useEffect(() => { load(); }, []);

  const openNew = () => { editing.value = null; showModal.value = true; };
  const openEdit = (t: any) => { editing.value = t; showModal.value = true; };
  const doDelete = async (t: any) => {
    if (t.is_system === 1) return toast('內建模板不可刪除', 'err');
    if (!confirm(`確定刪除模板 ${t.name}？`)) return;
    try { await api.del('/forms/templates/' + t.id); toast('已刪除', 'ok'); load(); }
    catch (e: any) { toast(e.message, 'err'); }
  };
  const onListClick = (e: any) => {
    const t = e.target;
    const id = t.dataset.edit || t.dataset.del;
    if (!id) return;
    const cur = rows.value.find((r: any) => String(r.id) === String(id));
    if (!cur) return;
    if (t.dataset.edit) openEdit(cur);
    else if (t.dataset.del) doDelete(cur);
  };

  const columns = [
    { key: 'name', label: '模板名稱', render: (r: any) => `<b>${esc(r.name)}</b>` },
    { key: 'doc_type', label: '類型', render: (r: any) => tag(r.doc_type === 'builtin' ? '內建' : '自訂', r.doc_type === 'builtin' ? 'blue' : 'gray') },
    { key: 'company_header', label: '公司頁首', render: (r: any) => (Number(r.company_header) === 1 ? '✓ 帶入' : '—') },
    { key: 'doc_count', label: '文件數', render: (r: any) => r.doc_count },
    { key: 'remark', label: '備註', render: (r: any) => `<span class="cell-ellipsis" title="${esc(r.remark || '')}">${esc(r.remark || '')}</span>` },
    { key: 'updated_at', label: '更新時間', render: (r: any) => date(r.updated_at) },
  ];

  return (
    <>
      <div class="toolbar">
        <div class="spacer" />
        <button class="btn btn-primary" onClick={openNew}>＋ 新增模板</button>
      </div>
      {loading.value
        ? <div class="empty">載入中…</div>
        : <>
            <div onClick={onListClick}>
              <Table columns={columns} rows={rows.value}
                actions={(r: any) => `<button class="btn btn-sm" data-edit="${r.id}">編輯</button><button class="btn btn-sm btn-danger" data-del="${r.id}">刪除</button>`} />
            </div>
          </>}
      {showModal.value && (
        <TemplateFormModal d={editing.value}
          onClose={() => (showModal.value = false)}
          onSaved={() => { showModal.value = false; load(); }} />
      )}
    </>
  );
}

function TemplateFormModal({ d, onClose, onSaved }: any) {
  const isNew = !d || !d.id;
  const fields = useSignal<any[]>([]);
  useEffect(() => {
    api.get('/forms/fields').then((fs: any) => { fields.value = fs; }).catch((e: any) => toast(e.message, 'err'));
  }, []);
  const form = useSignal<any>({
    name: d?.name || '',
    remark: d?.remark || '',
    company_header: d?.company_header === undefined ? 1 : Number(d.company_header),
    content: d?.content || '',
  });
  const save = async () => {
    if (!form.value.name.trim()) return toast('請輸入模板名稱', 'err');
    try {
      if (isNew) await api.post('/forms/templates', form.value);
      else await api.put('/forms/templates/' + d.id, form.value);
      toast(isNew ? '模板已建立' : '模板已儲存', 'ok');
      onSaved();
    } catch (e: any) { toast(e.message, 'err'); }
  };
  return (
    <Modal title={isNew ? '新增模板' : `編輯模板：${d.name}`} wide body={''} saveText="儲存" onSave={save} onClose={onClose}>
      <div class="form-grid">
        <div class="fld"><label>模板名稱 *</label><input value={form.value.name} onInput={(e: any) => (form.value.name = e.currentTarget.value)} placeholder="如：客戶聯絡函" /></div>
        <div class="fld"><label>公司頁首</label>
          <div style="padding:7px 10px;background:#f0f5fb;border:1px solid #d8e2ef;border-radius:6px;font-size:12.5px;color:#2d5a87;">✔ 一律帶入（公司名稱／英文名稱／統編／地址／電話／傳真）— 系統固定</div>
        </div>
        <div class="fld"><label>備註</label><input value={form.value.remark} onInput={(e: any) => (form.value.remark = e.currentTarget.value)} /></div>
      </div>
            <div style="font-size:12.5px;font-weight:600;color:#26324d;margin-bottom:4px;">模板內容（所見即所得）</div>
      <TipTapEditor value={form.value.content} fields={fields.value}
        onChange={(v: string) => (form.value.content = v)} />
      <div style="font-size:11.5px;color:#8a93a6;margin-top:4px;">欄位格式：「欄位」（如{'\u007b\u007b公司名稱\u007d\u007d'}、{'\u007b\u007b客戶名稱\u007d\u007d'}、{'\u007b\u007b訂單單號\u007d\u007d'}、{'\u007b\u007b今日日期\u007d\u007d'}），於文件編輯時以實際資料替換。</div>
    </Modal>
  );
}
