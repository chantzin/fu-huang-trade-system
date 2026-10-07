// format.js 單元測試（B2：格式化工具回歸防護網）
import { describe, it, expect } from 'vitest';
import { esc, money, num, pct, date, html, tag } from '../../src/ui/format.ts';

describe('esc — HTML 逃逸', () => {
  it('逃逸 & < > "', () => {
    expect(esc('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
  it('null/undefined → 空字串', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
  it('數字轉字串', () => {
    expect(esc(123)).toBe('123');
  });
});

describe('money — 金額格式化', () => {
  it('預設無小數點（0 位）＋千分位', () => {
    expect(money(1234567)).toContain('1,234,567');
  });
  it('帶幣別', () => {
    expect(money(100, 'TWD')).toContain('TWD');
  });
  it('零值', () => {
    expect(money(0)).toContain('0');
  });
});

describe('num — 數字格式化', () => {
  it('預設 0 位小數', () => {
    expect(num(1234.5)).toContain('1,235');
  });
  it('指定小數位', () => {
    expect(num(1234.567, 2)).toContain('1,234.57');
  });
});

describe('pct — 百分比', () => {
  it('0.05 → 5.00%', () => {
    expect(pct(0.05)).toBe('5.00%');
  });
  it('1 → 100.00%', () => {
    expect(pct(1)).toBe('100.00%');
  });
  it('負值', () => {
    expect(pct(-0.1)).toBe('-10.00%');
  });
});

describe('date — 日期截斷', () => {
  it('擷取前 10 字元（YYYY-MM-DD）', () => {
    expect(date('2026-09-06T12:34:56Z')).toBe('2026-09-06');
  });
  it('空值 → 空字串', () => {
    expect(date('')).toBe('');
    expect(date(null)).toBe('');
  });
});

describe('html — Preact 安全包裝', () => {
  it('回傳 { __html: str }', () => {
    expect(html('<b>test</b>')).toEqual({ __html: '<b>test</b>' });
  });
});

describe('tag — 標籤 HTML', () => {
  it('產生 span.tag 結構', () => {
    const t = tag('已確認', 'blue');
    expect(t).toContain('class="tag t-blue"');
    expect(t).toContain('已確認');
  });
  it('預設 gray', () => {
    expect(tag('草稿')).toContain('t-gray');
  });
});
