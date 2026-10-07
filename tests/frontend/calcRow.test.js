// calcRow 單元測試（B2：前端計算核心回歸防護網）
import { describe, it, expect } from 'vitest';
import { calcRow } from '../../src/views/Orders.tsx';

const base = (over = {}) => ({
  qty: 10, unit_price: 100, tax_rate: 0.05,
  cost_unit: 50, other_fee: 0, freight_cn: 0, freight_tw: 0,
  ...over,
});

describe('calcRow — 訂單明細計算引擎', () => {
  it('基本：應收貨款＝數量×單價', () => {
    const c = calcRow(base(), 1);
    expect(c.amount).toBe(1000);
  });

  it('稅額＝應收×稅率', () => {
    const c = calcRow(base(), 1);
    expect(c.tax).toBe(50);
  });

  it('應收總額＝應收＋稅', () => {
    const c = calcRow(base(), 1);
    expect(c.total).toBe(1050);
  });

  it('本位幣＝應收總額×匯率', () => {
    const c = calcRow(base(), 32);
    expect(c.totalBase).toBe(33600);
  });

  it('成本總額＝台幣單價成本×數量＋其他費用', () => {
    const c = calcRow(base({ other_fee: 100 }), 1);
    expect(c.costTotal).toBe(600); // 50*10 + 100
  });

  it('運費＝大陸＋台灣', () => {
    const c = calcRow(base({ freight_cn: 30, freight_tw: 20 }), 1);
    expect(c.freight).toBe(50);
  });

  it('利潤＝本位幣應收總額−成本總額−運費', () => {
    const c = calcRow(base({ freight_cn: 0, freight_tw: 0 }), 1);
    // totalBase=1050, costTotal=500, freight=0 → profit=550
    expect(c.profit).toBe(550);
  });

  it('負數利潤（成本高於售價）', () => {
    const c = calcRow(base({ unit_price: 10, cost_unit: 50 }), 1);
    expect(c.profit).toBeLessThan(0);
  });

  it('零數量 → 金額為 0', () => {
    const c = calcRow(base({ qty: 0 }), 1);
    expect(c.amount).toBe(0);
    expect(c.total).toBe(0);
  });

  it('零稅率 → 稅額為 0', () => {
    const c = calcRow(base({ tax_rate: 0 }), 1);
    expect(c.tax).toBe(0);
    expect(c.total).toBe(1000);
  });

  it('margin＝利潤÷本位幣應收總額（totalBase>0）', () => {
    const c = calcRow(base(), 1);
    expect(c.margin).toBeCloseTo(550 / 1050, 5);
  });

  it('totalBase=0 時 margin=0（防除以零）', () => {
    const c = calcRow(base({ qty: 0, unit_price: 0 }), 1);
    expect(c.margin).toBe(0);
  });

  it('空值/undefined 安全（不丟異常）', () => {
    expect(() => calcRow({}, 1)).not.toThrow();
    const c = calcRow({}, 1);
    expect(c.amount).toBe(0);
    expect(c.profit).toBe(0);
  });
});
