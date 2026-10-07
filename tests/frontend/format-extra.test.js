// format.js 擴充單元測試（esc/money/num/pct/date/tag/html）
import { describe, it, expect } from 'vitest';
import { esc, money, num, pct, date, tag, html, setMoneyDecimals } from '../../src/ui/format.ts';

describe('format — esc() HTML 跳脫', () => {
  it('一般字串不變', () => {
    expect(esc('hello')).toBe('hello');
  });

  it('& 跳脫為 &amp;', () => {
    expect(esc('a&b')).toBe('a&amp;b');
  });

  it('< 跳脫為 &lt;', () => {
    expect(esc('a<b')).toBe('a&lt;b');
  });

  it('> 跳脫為 &gt;', () => {
    expect(esc('a>b')).toBe('a&gt;b');
  });

  it('" 跳脫為 &quot;', () => {
    expect(esc('a"b')).toBe('a&quot;b');
  });

  it('組合：完整 HTML 標籤跳脫', () => {
    expect(esc('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });

  it('null 回傳空字串', () => {
    expect(esc(null)).toBe('');
  });

  it('undefined 回傳空字串', () => {
    expect(esc(undefined)).toBe('');
  });

  it('數字自動轉為字串', () => {
    expect(esc(123)).toBe('123');
  });

  it('中文不變', () => {
    expect(esc('中文測試')).toBe('中文測試');
  });
});

describe('format — money() 金額格式化', () => {
  it('預設無小數點（0 位）＋千分位', () => {
    expect(money(1234.5)).toContain('1,235');
    expect(money(1234.5)).not.toContain('.');
  });

  it('整數金額（0 位）', () => {
    expect(money(1000)).toContain('1,000');
  });

  it('負數金額', () => {
    expect(money(-500)).toContain('-500');
  });

  it('零金額', () => {
    expect(money(0)).toContain('0');
  });

  it('null 回傳 0', () => {
    expect(money(null)).toContain('0');
  });

  it('undefined 回傳 0', () => {
    expect(money(undefined)).toContain('0');
  });

  it('帶幣別參數', () => {
    const result = money(100, 'TWD');
    expect(result).toContain('TWD');
  });

  it('大數字含千分位（0 位四捨五入）', () => {
    expect(money(1234567.89)).toContain('1,234,568');
  });

  it('setMoneyDecimals(2) 後顯示小數點後 2 位，設回 0 位還原', () => {
    setMoneyDecimals(2);
    expect(money(1234.5)).toContain('1,234.50');
    setMoneyDecimals(0);
    expect(money(1234.5)).toContain('1,235');
  });
});

describe('format — num() 數字格式化', () => {
  it('預設零位小數', () => {
    expect(num(1234.56)).toContain('1,235');
  });

  it('指定兩位小數', () => {
    expect(num(1234.567, 2)).toContain('1,234.57');
  });

  it('零', () => {
    expect(num(0)).toContain('0');
  });

  it('null 回傳 0', () => {
    expect(num(null)).toContain('0');
  });
});

describe('format — pct() 百分比格式化', () => {
  it('基本百分比（0.05 → 5.00%）', () => {
    expect(pct(0.05)).toBe('5.00%');
  });

  it('1 → 100.00%', () => {
    expect(pct(1)).toBe('100.00%');
  });

  it('0 → 0.00%', () => {
    expect(pct(0)).toBe('0.00%');
  });

  it('負數百分比', () => {
    expect(pct(-0.1)).toBe('-10.00%');
  });

  it('指定小數位數', () => {
    // 0.056 * 100 = 5.6 → toFixed(1) = '5.6'
    expect(pct(0.056, 1)).toBe('5.6%');
  });

  it('null 回傳 0.00%', () => {
    expect(pct(null)).toBe('0.00%');
  });
});

describe('format — date() 日期格式化', () => {
  it('ISO 日期取前 10 字元', () => {
    expect(date('2024-01-15T10:30:00Z')).toBe('2024-01-15');
  });

  it('單純日期字串不變', () => {
    expect(date('2024-01-15')).toBe('2024-01-15');
  });

  it('null 回傳空字串', () => {
    expect(date(null)).toBe('');
  });

  it('undefined 回傳空字串', () => {
    expect(date(undefined)).toBe('');
  });

  it('空字串回傳空字串', () => {
    expect(date('')).toBe('');
  });
});

describe('format — tag() 標籤產生', () => {
  it('基本標籤（預設 gray）', () => {
    const result = tag('已完成');
    expect(result).toContain('tag');
    expect(result).toContain('t-gray');
    expect(result).toContain('已完成');
  });

  it('指定類型 red', () => {
    const result = tag('逾期', 'red');
    expect(result).toContain('t-red');
  });

  it('指定類型 green', () => {
    const result = tag('正常', 'green');
    expect(result).toContain('t-green');
  });

  it('標籤文字會被 HTML 跳脫', () => {
    const result = tag('<script>');
    expect(result).toContain('&lt;script&gt;');
  });
});

describe('format — html() 危險 HTML 包裝', () => {
  it('回傳物件含 __html 屬性', () => {
    const result = html('<b>test</b>');
    expect(result).toHaveProperty('__html');
    expect(result.__html).toBe('<b>test</b>');
  });

  it('空字串', () => {
    const result = html('');
    expect(result.__html).toBe('');
  });
});
