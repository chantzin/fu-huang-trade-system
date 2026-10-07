// lib/util.js 單元測試
import { describe, it, expect } from 'vitest';
import { num, str, round, toDateStr, toMonthStr, parseDate, endOfMonth, addDays, addMonths, parseTermsDays } from '../../lib/util.js';

describe('util.num()', () => {
  it('數字字串轉數字', () => { expect(num('123')).toBe(123); });
  it('含逗號數字轉數字', () => { expect(num('1,234.56')).toBe(1234.56); });
  it('null 回傳預設 0', () => { expect(num(null)).toBe(0); });
  it('undefined 回傳預設 0', () => { expect(num(undefined)).toBe(0); });
  it('空字串回傳預設 0', () => { expect(num('')).toBe(0); });
  it('自訂預設值', () => { expect(num(null, 5)).toBe(5); });
  it('非數字回傳預設', () => { expect(num('abc', 99)).toBe(99); });
  it('負數', () => { expect(num('-45.67')).toBe(-45.67); });
});

describe('util.str()', () => {
  it('字串去空白', () => { expect(str('  hello  ')).toBe('hello'); });
  it('null 回傳空字串', () => { expect(str(null)).toBe(''); });
  it('undefined 回傳空字串', () => { expect(str(undefined)).toBe(''); });
  it('自訂預設值', () => { expect(str(null, 'N/A')).toBe('N/A'); });
  it('數字轉字串', () => { expect(str(123)).toBe('123'); });
});

describe('util.round()', () => {
  it('預設四捨五入到小數第2位', () => { expect(round(3.14159)).toBe(3.14); });
  it('四捨五入到小數第0位', () => { expect(round(3.6, 0)).toBe(4); });
  it('四捨五入到小數第4位', () => { expect(round(3.14159, 4)).toBe(3.1416); });
  it('負數四捨五入', () => { expect(round(-3.14159)).toBe(-3.14); });
  it('null 回傳 0', () => { expect(round(null)).toBe(0); });
});

describe('util.toDateStr()', () => {
  it('Date 物件轉 YYYY-MM-DD', () => { expect(toDateStr(new Date(2026, 8, 8))).toBe('2026-09-08'); });
  it('null 回傳空字串', () => { expect(toDateStr(null)).toBe(''); });
  it('無效日期回傳空字串', () => { expect(toDateStr('invalid')).toBe(''); });
});

describe('util.toMonthStr()', () => {
  it('Date 轉 YYYY-MM', () => { expect(toMonthStr(new Date(2026, 8, 8))).toBe('2026-09'); });
  it('null 回傳空字串', () => { expect(toMonthStr(null)).toBe(''); });
});

describe('util.parseDate()', () => {
  it('解析 YYYY-MM-DD', () => { const d = parseDate('2026-09-08'); expect(d.getFullYear()).toBe(2026); expect(d.getMonth()).toBe(8); expect(d.getDate()).toBe(8); });
  it('null 回傳 null', () => { expect(parseDate(null)).toBeNull(); });
  it('空字串回傳 null', () => { expect(parseDate('')).toBeNull(); });
});

describe('util.endOfMonth()', () => {
  it('取得該月最後一天', () => { const d = endOfMonth('2026-02-01'); expect(d.getDate()).toBe(28); });
  it('閏年二月', () => { const d = endOfMonth('2024-02-15'); expect(d.getDate()).toBe(29); });
  it('null 回傳 null', () => { expect(endOfMonth(null)).toBeNull(); });
});

describe('util.addDays()', () => {
  it('加 1 天', () => { const d = addDays(new Date(2026, 8, 8), 1); expect(d.getDate()).toBe(9); });
  it('減 1 天', () => { const d = addDays(new Date(2026, 8, 1), -1); expect(d.getDate()).toBe(31); expect(d.getMonth()).toBe(7); });
  it('加 0 天不變', () => { const d = addDays(new Date(2026, 8, 8), 0); expect(d.getDate()).toBe(8); });
});

describe('util.addMonths()', () => {
  it('加 1 個月', () => { const d = addMonths(new Date(2026, 8, 8), 1); expect(d.getMonth()).toBe(9); });
  it('減 1 個月', () => { const d = addMonths(new Date(2026, 0, 15), -1); expect(d.getMonth()).toBe(11); expect(d.getFullYear()).toBe(2025); });
});

describe('util.parseTermsDays()', () => {
  it('解析「月結60天」', () => { expect(parseTermsDays('月結60天')).toBe(60); });
  it('解析「T/T 30」', () => { expect(parseTermsDays('T/T 30')).toBe(30); });
  it('解析純數字「90」', () => { expect(parseTermsDays('90')).toBe(90); });
  it('無數字回傳預設 60', () => { expect(parseTermsDays('現金款')).toBe(60); });
  it('自訂預設值', () => { expect(parseTermsDays('現金款', 30)).toBe(30); });
  it('null 回傳預設', () => { expect(parseTermsDays(null)).toBe(60); });
});
