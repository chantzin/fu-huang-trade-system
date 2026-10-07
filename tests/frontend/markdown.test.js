// Markdown.jsx 純函式單元測試（slugify/parseInline）
import { describe, it, expect } from 'vitest';
import { slugify, parseInline } from '../../src/ui/Markdown.tsx';

describe('Markdown — slugify() 標題 id 生成', () => {
  it('英文小寫化', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('中文保留', () => {
    expect(slugify('系統簡介')).toBe('系統簡介');
  });

  it('特殊字元替換為連字號', () => {
    expect(slugify('a!@#b')).toBe('a-b');
  });

  it('多個連字號合併為一個', () => {
    expect(slugify('a---b')).toBe('a-b');
  });

  it('開頭和結尾的連字號被移除', () => {
    expect(slugify('-hello-')).toBe('hello');
  });

  it('空字串回傳空字串', () => {
    expect(slugify('')).toBe('');
  });

  it('數字保留', () => {
    expect(slugify('章節1-2')).toBe('章節1-2');
  });

  it('超過 50 字元被截斷', () => {
    const long = 'a'.repeat(60);
    expect(slugify(long).length).toBe(50);
  });

  it('中英文混合', () => {
    expect(slugify('4.1 新增訂單')).toBe('4-1-新增訂單');
  });
});

describe('Markdown — parseInline() 行內格式解析', () => {
  it('一般文字不變（回傳 Preact 元素陣列）', () => {
    const result = parseInline('hello world');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('粗體 **text** 被解析為 b 元素', () => {
    const result = parseInline('**bold**');
    // 找到 type 為 'b' 的元素
    const boldEl = result.find((el) => el && el.type === 'b');
    expect(boldEl).toBeTruthy();
    expect(boldEl.props.children).toBe('bold');
  });

  it('多個粗體', () => {
    const result = parseInline('**a** and **b**');
    const boldEls = result.filter((el) => el && el.type === 'b');
    expect(boldEls.length).toBe(2);
  });

  it('行內程式碼 `code` 被解析為 code 元素', () => {
    const result = parseInline('use `npm install`');
    const codeEl = result.find((el) => el && el.type === 'code');
    expect(codeEl).toBeTruthy();
    expect(codeEl.props.children).toBe('npm install');
  });

  it('連結 [text](url) 被解析為 a 元素', () => {
    const result = parseInline('click [here](https://example.com)');
    const linkEl = result.find((el) => el && el.type === 'a');
    expect(linkEl).toBeTruthy();
    expect(linkEl.props.href).toBe('https://example.com');
    expect(linkEl.props.children).toBe('here');
  });

  it('混合格式：粗體 + 程式碼 + 一般文字', () => {
    const result = parseInline('**重要**：使用 `npm test` 執行測試');
    expect(result.length).toBeGreaterThanOrEqual(3);
    const hasBold = result.some((el) => el && el.type === 'b');
    const hasCode = result.some((el) => el && el.type === 'code');
    expect(hasBold).toBe(true);
    expect(hasCode).toBe(true);
  });

  it('空字串回傳空陣列', () => {
    const result = parseInline('');
    expect(Array.isArray(result)).toBe(true);
  });

  it('只有一般文字（無格式）回傳一個 span 元素', () => {
    const result = parseInline('plain text');
    const spanEl = result.find((el) => el && el.type === 'span');
    expect(spanEl).toBeTruthy();
  });

  it('粗體前後有一般文字', () => {
    const result = parseInline('before **bold** after');
    const spans = result.filter((el) => el && el.type === 'span');
    const bolds = result.filter((el) => el && el.type === 'b');
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(bolds.length).toBe(1);
  });
});
