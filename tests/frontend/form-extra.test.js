// form.js 擴充單元測試（field/input/number/dateField/checkbox/select/textarea/formData）
import { describe, it, expect } from 'vitest';
import { field, input, number, dateField, checkbox, select, textarea, formData } from '../../src/ui/form.ts';

describe('form — field() 欄位包裝', () => {
  it('基本欄位（含 label 和 input）', () => {
    const result = field('姓名', '<input name="name" />');
    expect(result).toContain('姓名');
    expect(result).toContain('<input name="name" />');
    expect(result).toContain('<label');
  });

  it('full=true 時含 full class', () => {
    const result = field('備註', '<textarea />', true);
    expect(result).toContain('full');
  });

  it('label 會被 HTML 跳脫', () => {
    const result = field('<b>姓名</b>', '<input />');
    expect(result).toContain('&lt;b&gt;');
  });
});

describe('form — input() 文字輸入', () => {
  it('基本 input（name + value）', () => {
    const result = input('username', 'admin');
    expect(result).toContain('name="username"');
    expect(result).toContain('value="admin"');
  });

  it('空 value', () => {
    const result = input('username');
    expect(result).toContain('value=""');
  });

  it('value 會被 HTML 跳脫', () => {
    const result = input('name', '<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('附加 attrs', () => {
    const result = input('email', '', 'placeholder="請輸入 Email"');
    expect(result).toContain('placeholder="請輸入 Email"');
  });
});

describe('form — number() 數字輸入', () => {
  it('基本 number（type=number）', () => {
    const result = number('qty', 10);
    expect(result).toContain('type="number"');
    expect(result).toContain('name="qty"');
    expect(result).toContain('value="10"');
  });

  it('null value 回傳 0', () => {
    const result = number('qty', null);
    expect(result).toContain('value="0"');
  });

  it('undefined value 回傳 0', () => {
    const result = number('qty', undefined);
    expect(result).toContain('value="0"');
  });

  it('指定 step', () => {
    const result = number('price', 99.5, '0.01');
    expect(result).toContain('step="0.01"');
  });
});

describe('form — dateField() 日期輸入', () => {
  it('基本 date（type=date）', () => {
    const result = dateField('order_date', '2024-01-15');
    expect(result).toContain('type="date"');
    expect(result).toContain('name="order_date"');
    expect(result).toContain('value="2024-01-15"');
  });

  it('ISO 日期取前 10 字元', () => {
    const result = dateField('order_date', '2024-01-15T10:30:00Z');
    expect(result).toContain('value="2024-01-15"');
  });

  it('空 value', () => {
    const result = dateField('order_date', '');
    expect(result).toContain('value=""');
  });
});

describe('form — checkbox() 核取方塊', () => {
  it('勾選狀態（含 checked）', () => {
    const result = checkbox('active', true);
    expect(result).toContain('type="checkbox"');
    expect(result).toContain('name="active"');
    expect(result).toContain('checked');
  });

  it('未勾選狀態（不含 checked）', () => {
    const result = checkbox('active', false);
    expect(result).not.toContain('checked');
  });

  it('預設未勾選', () => {
    const result = checkbox('active');
    expect(result).not.toContain('checked');
  });
});

describe('form — select() 下拉選單', () => {
  it('陣列格式 options（[[value,label],...]）', () => {
    const result = select('status', [['draft', '草稿'], ['confirmed', '已確認']], 'draft');
    expect(result).toContain('<select name="status"');
    expect(result).toContain('value="draft"');
    expect(result).toContain('selected');
    expect(result).toContain('草稿');
    expect(result).toContain('value="confirmed"');
    expect(result).toContain('已確認');
  });

  it('物件格式 options（[{value,label},...]）', () => {
    const result = select('role', [{ value: 'admin', label: '管理者' }, { value: 'sales', label: '業務' }], 'sales');
    expect(result).toContain('value="admin"');
    expect(result).toContain('管理者');
    expect(result).toContain('value="sales"');
    expect(result).toContain('selected');
    expect(result).toContain('業務');
  });

  it('value 不匹配時沒有 selected', () => {
    const result = select('status', [['a', 'A'], ['b', 'B']], 'c');
    expect(result).not.toContain('selected');
  });

  it('option value 和 label 會被 HTML 跳脫', () => {
    const result = select('x', [['<a>', '<b>']], '<a>');
    expect(result).toContain('&lt;a&gt;');
    expect(result).toContain('&lt;b&gt;');
  });
});

describe('form — textarea() 多行文字', () => {
  it('基本 textarea', () => {
    const result = textarea('note', '這是備註');
    expect(result).toContain('<textarea name="note"');
    expect(result).toContain('這是備註');
  });

  it('空 value', () => {
    const result = textarea('note', '');
    expect(result).toContain('<textarea name="note"></textarea>');
  });

  it('value 會被 HTML 跳脫', () => {
    const result = textarea('note', '<script>alert(1)</script>');
    expect(result).toContain('&lt;script&gt;');
  });
});

describe('form — formData() 表單收集（需 DOM mock）', () => {
  // 建立模擬 DOM 元素
  function mockElement(name, type, value, checked = false) {
    return { name, type, value, checked };
  }

  it('收集一般文字欄位（trim）', () => {
    const root = {
      querySelectorAll: () => [
        mockElement('name', 'text', '  小明  '),
        mockElement('email', 'text', 'test@example.com'),
      ],
    };
    const result = formData(root);
    expect(result.name).toBe('小明');
    expect(result.email).toBe('test@example.com');
  });

  it('數字欄位自動轉型為 Number', () => {
    const root = {
      querySelectorAll: () => [
        mockElement('qty', 'number', '10'),
        mockElement('price', 'number', '99.5'),
      ],
    };
    const result = formData(root);
    expect(typeof result.qty).toBe('number');
    expect(result.qty).toBe(10);
    expect(result.price).toBe(99.5);
  });

  it('空數字欄位回傳 0', () => {
    const root = {
      querySelectorAll: () => [mockElement('qty', 'number', '')],
    };
    const result = formData(root);
    expect(result.qty).toBe(0);
  });

  it('checkbox 勾選回傳 1，未勾選回傳 0', () => {
    const root = {
      querySelectorAll: () => [
        mockElement('active', 'checkbox', 'on', true),
        mockElement('newsletter', 'checkbox', 'on', false),
      ],
    };
    const result = formData(root);
    expect(result.active).toBe(1);
    expect(result.newsletter).toBe(0);
  });

  it('沒有 name 的元素被忽略', () => {
    const root = {
      querySelectorAll: () => [
        mockElement('', 'text', 'ignored'),
        mockElement('valid', 'text', 'kept'),
      ],
    };
    const result = formData(root);
    expect(result.valid).toBe('kept');
    // 空 name 不會成為屬性
    expect(Object.keys(result)).not.toContain('');
  });

  it('空表單回傳空物件', () => {
    const root = { querySelectorAll: () => [] };
    const result = formData(root);
    expect(Object.keys(result).length).toBe(0);
  });
});
