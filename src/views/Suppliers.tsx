// 供應商／大陸工廠主檔（Level B / Preact）
import MasterView from '../ui/MasterView.tsx';
import { field, input, select, number, textarea } from '../ui/form.ts';
import { esc, tag } from '../ui/format.ts';

const columns = [
  { key: 'code', label: '代號' },
  { key: 'name', label: '供應商名稱', render: (r: any) => `<b>${esc(r.name)}</b>` },
  { key: 'contact_name', label: '聯絡人' },
  { key: 'phone', label: '電話' },
  { key: 'country', label: '國家' },
  { key: 'lead_time_days', label: '交期天數', num: true },
  { key: 'payment_terms', label: '付款條件' },
  { key: 'currency', label: '幣別' },
  { key: 'active', label: '狀態', render: (r: any) => (r.active ? tag('啟用', 'green') : tag('停用', 'gray')) },
];

function buildForm(ctx: any, d: any) {
  return `<div class="form-grid">
    ${field('代號', input('code', d.code))}
    ${field('供應商名稱 *', input('name', d.name))}
    ${field('聯絡人', input('contact_name', d.contact_name))}
    ${field('電話', input('phone', d.phone))}
    ${field('Email', input('email', d.email))}
    ${field('國家', input('country', d.country))}
    ${field('交期天數', number('lead_time_days', d.lead_time_days, '1'))}
    ${field('付款條件', input('payment_terms', d.payment_terms))}
    ${field('幣別', select('currency', [['RMB', 'RMB'], ['USD', 'USD'], ['TWD', 'TWD']], d.currency))}
    ${field('備註', textarea('note', d.note), true)}
    ${field('啟用', select('active', [[1, '啟用'], [0, '停用']], d.active ? 1 : 0))}
  </div>`;
}

export default function Suppliers() {
  return (
    <MasterView
      title="供應商工廠"
      listUrl="/suppliers"
      columns={columns}
      buildForm={buildForm}
      validate={(p: any) => (p.name ? true : '供應商名稱為必填')}
      searchable={(r: any) => [r.code, r.name, r.contact_name]}
      rowLabel={(r: any) => r.name}
      newDefaults={{ country: '中國', lead_time_days: 30, currency: 'RMB', active: 1 }}
    />
  );
}
Suppliers.title = '供應商工廠';
