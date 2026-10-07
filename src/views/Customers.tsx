// 客戶主檔（Level B / Preact）
import MasterView from '../ui/MasterView.tsx';
import { field, input, select, number, textarea } from '../ui/form.ts';
import { esc, tag, pct as fmtPct } from '../ui/format.ts';

const columns = [
  { key: 'customer_no', label: '客戶編號', render: (r: any) => esc(r.customer_no || '') },
  { key: 'name', label: '公司名稱', render: (r: any) => `<b>${esc(r.name)}</b>` },
  { key: 'contact_name', label: '聯絡人' },
  { key: 'phone', label: '電話' },
  { key: 'currency', label: '幣別' },
  { key: 'ar_terms_name', label: '交易條件', render: (r: any) => esc(r.ar_terms_name || r.payment_terms || '') },
  { key: 'terms_days', label: '月結天數', num: true },
  { key: 'tax_rate', label: '稅率', num: true, render: (r: any) => fmtPct(r.tax_rate, 1) },
  { key: 'active', label: '狀態', render: (r: any) => (r.active ? tag('啟用', 'green') : tag('停用', 'gray')) },
];

function buildForm(ctx: any, d: any) {
  const salesOpts = [[0, '（未指定）']].concat((ctx.sales || []).map((u: any) => [u.id, `${u.emp_id} ${u.name}`]));
  const curOpts = (ctx.meta?.currencies || []).map((c: any) => [c, c]);
  // 帳期規則下拉選項（從 /ar-terms/active 讀取啟用的規則）
  const arTermsOpts = [[0, '（未指定，使用系統預設）']].concat(
    (ctx.arTerms || []).map((t: any) => [t.id, `${t.name}（${t.basis_label}${t.days > 0 ? '，' + t.days + '天' : ''}）`])
  );
  return `<div class="form-grid">
    ${field('客戶編號', input('customer_no', d.customer_no))}
    ${field('公司名稱 *', input('name', d.name))}
    ${field('簡稱', input('short_name', d.short_name))}
    ${field('統一編號', input('tax_id', d.tax_id))}
    ${field('發票抬頭', input('invoice_title', d.invoice_title))}
    ${field('聯絡人', input('contact_name', d.contact_name))}
    ${field('電話', input('phone', d.phone))}
    ${field('傳真', input('fax', d.fax))}
    ${field('Email', input('email', d.email))}
    ${field('幣別', select('currency', curOpts, d.currency))}
    ${field('交易條件（帳期規則）', select('ar_terms_id', arTermsOpts, d.ar_terms_id || 0))}
    ${field('交易條件文字', input('payment_terms', d.payment_terms))}
    ${field('月結天數', number('terms_days', d.terms_days, '1'))}
    ${field('預設稅率（0.05 = 5%）', number('tax_rate', d.tax_rate, '0.001'))}
    ${field('歸屬業務', select('owner_id', salesOpts, d.owner_id || 0))}
    ${field('地址', input('address', d.address), true)}
    ${field('發票地址', input('invoice_addr', d.invoice_addr), true)}
    ${field('備註', textarea('note', d.note), true)}
    ${field('啟用', select('active', [[1, '啟用'], [0, '停用']], d.active ? 1 : 0))}
  </div>`;
}

export default function Customers() {
  return (
    <MasterView
      title="客戶主檔"
      listUrl="/customers"
      columns={columns}
      deps={[{ key: 'sales', url: '/users' }, { key: 'meta', url: '/params/meta' }, { key: 'arTerms', url: '/ar-terms/active' }]}
      buildForm={buildForm}
      validate={(p: any) => (p.name ? true : '公司名稱為必填')}
      searchable={(r: any) => [r.name, r.customer_no, r.short_name, r.tax_id]}
      rowLabel={(r: any) => r.name}
      newDefaults={{ currency: 'TWD', payment_terms: '月結60天', terms_days: 60, tax_rate: 0.05, active: 1, ar_terms_id: 0 }}
    />
  );
}
Customers.title = '客戶主檔';
