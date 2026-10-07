// form.js 單元測試（B2：表單欄位產生器回歸防護網）
import { describe, it, expect } from 'vitest';
import { field, input, number, dateField, select, textarea, checkbox } from '../../src/ui/form.ts';

describe('field — 欄位包裝', () => {
  it('產生 label＋input 結構', () => {
    const f = field('客戶', '<input name="c" />');
    expect(f).toContain('<label');
    expect(f).toContain('客戶');
    expect(f).toContain('<input name="c"');
  });
  it('full=true 加上 full class', () => {
    expect(field('備註', '', true)).toContain('class="full"');
  });
});

describe('input — 文字輸入', () => {
  it('name＋value', () => {
    expect(input('order_no', 'SO-001')).toContain('name="order_no"');
    expect(input('order_no', 'SO-001')).toContain('value="SO-001"');
  });
  it('空值預設空字串', () => {
    expect(input('x')).toContain('value=""');
  });
  it('value 被 HTML 逃逸', () => {
    expect(input('x', '<b>')).toContain('value="&lt;b&gt;"');
  });
});

describe('number — 數字輸入', () => {
  it('type=number＋step', () => {
    const n = number('qty', 10, '1');
    expect(n).toContain('type="number"');
    expect(n).toContain('step="1"');
    expect(n).toContain('value="10"');
  });
  it('null/undefined → 0', () => {
    expect(number('x', null)).toContain('value="0"');
  });
});

describe('dateField — 日期輸入', () => {
  it('type=date＋value 截斷', () => {
    expect(dateField('order_date', '2026-09-06T12:00:00')).toContain('value="2026-09-06"');
  });
});

describe('select — 下拉選單', () => {
  it('陣列格式 [value,label]', () => {
    const s = select('status', [['a', '啟用'], ['b', '停用']], 'b');
    expect(s).toContain('<option value="a"');
    expect(s).toContain('<option value="b" selected');
    expect(s).toContain('停用');
  });
  it('物件格式 {value,label}', () => {
    const s = select('x', [{ value: 1, label: '一' }], 1);
    expect(s).toContain('value="1" selected');
  });
});

describe('textarea — 多行輸入', () => {
  it('name＋value', () => {
    expect(textarea('note', 'hello')).toContain('<textarea name="note">hello</textarea>');
  });
  it('value 被逃逸', () => {
    expect(textarea('note', '<x>')).toContain('&lt;x&gt;');
  });
});

describe('checkbox — 核取方塊', () => {
  it('checked=true 加上 checked 屬性', () => {
    expect(checkbox('active', true)).toContain('checked');
  });
  it('checked=false 不加', () => {
    expect(checkbox('active', false)).not.toContain('checked');
  });
});
