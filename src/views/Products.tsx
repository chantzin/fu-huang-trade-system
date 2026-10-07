// 產品（料號）主檔（Level B / Preact）
import MasterView from '../ui/MasterView.tsx';
import { field, input, select, number, textarea } from '../ui/form.ts';
import { esc, tag, money, num } from '../ui/format.ts';

const columns = [
  { key: 'part_no', label: '料號', render: (r: any) => `<b>${esc(r.part_no)}</b>` },
  { key: 'name', label: '品名' },
  { key: 'spec', label: '規格' },
  { key: 'version', label: '版本' },
  { key: 'unit', label: '單位' },
  { key: 'stock_qty', label: '庫存量', num: true, render: (r: any) => num(r.stock_qty) },
  { key: 'cost_unit', label: '台幣單價成本', num: true, render: (r: any) => money(r.cost_unit) },
  { key: 'price', label: '預設單價', num: true },
  { key: 'supplier_name', label: '供應商' },
  { key: 'active', label: '狀態', render: (r: any) => (r.active ? tag('啟用', 'green') : tag('停用', 'gray')) },
];

function buildForm(ctx: any, d: any) {
  const supOpts = [[0, '（未指定）']].concat((ctx.suppliers || []).map((s: any) => [s.id, s.name]));
  const curOpts = (ctx.meta?.currencies || []).map((c: any) => [c, c]);
  return `<div class="form-grid">
    ${field('料號 *', input('part_no', d.part_no))}
    ${field('品名 *', input('name', d.name))}
    ${field('規格', input('spec', d.spec))}
    ${field('版本', input('version', d.version))}
    ${field('單位', input('unit', d.unit))}
    ${field('預設單價', number('price', d.price, '0.0001'))}
    ${field('幣別', select('currency', curOpts, d.currency))}
    ${field('供應商', select('supplier_id', supOpts, d.supplier_id || 0))}
    ${field('備註', textarea('note', d.note), true)}
    ${field('啟用', select('active', [[1, '啟用'], [0, '停用']], d.active ? 1 : 0))}
    <div class="field" style="grid-column:1/-1"><label>庫存與成本</label><div class="muted">請至「庫存管理」建立期初庫存，或透過收貨單／庫存異動過帳；產品主檔不直接修改庫存與成本。</div></div>
  </div>`;
}

export default function Products() {
  return (
    <MasterView
      title="產品料號"
      listUrl="/products"
      columns={columns}
      deps={[{ key: 'suppliers', url: '/suppliers' }, { key: 'meta', url: '/params/meta' }]}
      buildForm={buildForm}
      validate={(p: any) => (!p.part_no ? '料號為必填' : !p.name ? '品名為必填' : true)}
      searchable={(r: any) => [r.part_no, r.name, r.spec]}
      rowLabel={(r: any) => r.part_no}
      newDefaults={{ unit: 'PCS', currency: 'TWD', active: 1 }}
    />
  );
}
Products.title = '產品料號';
