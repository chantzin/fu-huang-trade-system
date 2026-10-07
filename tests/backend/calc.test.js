// lib/calc.js 純函數單元測試（不依賴資料庫的部分）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let calcItem, calcOrderTotals, deriveAR, agingBucket, arTermsBasis, orderTermsBasis;
let testDbPath;
beforeAll(async () => {
  // calc.js 會載入 db.js；先指定 OS 暫存 DB，避免測試開啟或改寫 Source/LIVE 資料庫。
  testDbPath = path.join(os.tmpdir(), `mj-calc-test-${process.pid}-${Date.now()}.sqlite`);
  process.env.APP_DB = testDbPath;
  ({ calcItem, calcOrderTotals, deriveAR, agingBucket, arTermsBasis, orderTermsBasis } = await import('../../lib/calc.js'));
  require('../../lib/db.js').initSchema();
});
afterAll(() => {
  try { require('../../lib/db.js').db.close(); } catch { /* module may not have initialized */ }
  for (const suffix of ['', '-wal', '-shm']) try { fs.unlinkSync(testDbPath + suffix); } catch { /* already removed */ }
  delete process.env.APP_DB;
});

describe('calc.calcItem()', () => {
  it('基本計算：數量×單價=金額', () => {
    const r = calcItem({ qty: 10, unit_price: 100, tax_rate: 0.05 }, { exchange_rate: 1 });
    expect(r.amount).toBe(1000);
    expect(r.tax_amount).toBe(50);
    expect(r.total).toBe(1050);
    expect(r.total_base).toBe(1050);
  });

  it('含稅率 5%', () => {
    const r = calcItem({ qty: 2, unit_price: 500, tax_rate: 0.05 }, { exchange_rate: 1 });
    expect(r.amount).toBe(1000);
    expect(r.tax_amount).toBe(50);
    expect(r.total).toBe(1050);
  });

  it('匯率轉換：USD 30 → TWD', () => {
    const r = calcItem({ qty: 1, unit_price: 100, tax_rate: 0 }, { exchange_rate: 30 });
    expect(r.total).toBe(100);
    expect(r.total_base).toBe(3000);
  });

  it('成本與利潤計算', () => {
    const r = calcItem({ qty: 10, unit_price: 100, tax_rate: 0, cost_unit: 50, other_fee: 100, freight_cn: 50, freight_tw: 30 }, { exchange_rate: 1 });
    expect(r.cost_total).toBe(600);
    expect(r.freight).toBe(80);
    expect(r.profit).toBe(320);
    expect(r.margin).toBeCloseTo(0.32, 2);
  });

  it('空值處理：qty=null 回傳 0', () => {
    const r = calcItem({ qty: null, unit_price: 100 }, { exchange_rate: 1 });
    expect(r.qty).toBe(0);
    expect(r.amount).toBe(0);
  });

  it('total_base=0 時 margin=0', () => {
    const r = calcItem({ qty: 0, unit_price: 100 }, { exchange_rate: 1 });
    expect(r.margin).toBe(0);
    expect(r.freight_pct).toBe(0);
  });

  it('運費百分比計算', () => {
    const r = calcItem({ qty: 1, unit_price: 1000, tax_rate: 0, freight_cn: 100, freight_tw: 0 }, { exchange_rate: 1 });
    expect(r.freight_pct).toBe(10);
  });
});

describe('calc.calcOrderTotals()', () => {
  it('多筆明細合計', () => {
    const items = [
      { qty: 10, amount: 1000, tax_amount: 50, total: 1050, total_base: 1050, cost_total: 500, freight_cn: 30, freight_tw: 20, other_fee: 50, profit: 450 },
      { qty: 5, amount: 500, tax_amount: 25, total: 525, total_base: 525, cost_total: 250, freight_cn: 15, freight_tw: 10, other_fee: 25, profit: 225 },
    ];
    const t = calcOrderTotals(items);
    expect(t.qty).toBe(15);
    expect(t.amount).toBe(1500);
    expect(t.tax_amount).toBe(75);
    expect(t.total).toBe(1575);
    expect(t.total_base).toBe(1575);
    expect(t.cost_total).toBe(750);
    expect(t.freight).toBe(75);
    expect(t.profit).toBe(675);
  });

  it('空陣列回傳全 0', () => {
    const t = calcOrderTotals([]);
    expect(t.qty).toBe(0);
    expect(t.amount).toBe(0);
    expect(t.profit).toBe(0);
    expect(t.margin).toBe(0);
  });

  it('null 回傳全 0', () => {
    const t = calcOrderTotals(null);
    expect(t.qty).toBe(0);
  });

  it('margin 計算正確', () => {
    const items = [{ total_base: 1000, profit: 200, amount: 1000, freight_cn: 0, freight_tw: 0 }];
    const t = calcOrderTotals(items);
    expect(t.margin).toBeCloseTo(0.2, 2);
  });
});

describe('calc.deriveAR()', () => {
  it('month_end 模式：結帳月底+60天', () => {
    const r = deriveAR('2026-09-15', 60, { basis: 'month_end', days: 60 });
    expect(r.billing_month).toBe('2026-09');
    expect(r.due_date).toBe('2026-11-29');
    expect(r.basis).toBe('month_end');
    expect(r.terms_days).toBe(60);
  });

  it('next_month_start 模式：次月1日+(60-1)天', () => {
    const r = deriveAR('2026-09-15', 60, { basis: 'next_month_start', days: 60 });
    expect(r.due_date).toBe('2026-11-29');
  });

  it('cash 模式：兌現日=基準日', () => {
    const r = deriveAR('2026-09-15', 0, { basis: 'cash', days: 0 });
    expect(r.due_date).toBe('2026-09-15');
  });

  it('prepaid 模式：兌現日=基準日', () => {
    const r = deriveAR('2026-09-15', 0, { basis: 'prepaid', days: 0 });
    expect(r.due_date).toBe('2026-09-15');
  });

  it('receivable_month 為兌現日所屬月份', () => {
    const r = deriveAR('2026-09-15', 60, { basis: 'month_end', days: 60 });
    expect(r.receivable_month).toBe('2026-11');
  });

  // ==== 2026-09-10 健檢 N4 回歸保護 ====
  // 現金款／預付款若誤用全域 month_end，到期日會被算成「月底 + N 天」而整個錯掉。
  it('N4 回歸：現金款即使 terms_days 殘留 60，basis=cash 時到期日仍為基準日', () => {
    const r = deriveAR('2026-09-06', 60, { basis: 'cash' });
    expect(r.due_date).toBe('2026-09-06');
    expect(r.receivable_month).toBe('2026-09');
  });

  it('N4 回歸：預付款 basis=prepaid 時到期日為基準日', () => {
    const r = deriveAR('2026-09-07', 60, { basis: 'prepaid' });
    expect(r.due_date).toBe('2026-09-07');
  });

  it('N4 回歸：未帶 basis 時仍走全域設定（month_end），不改變既有行為', () => {
    const r = deriveAR('2026-09-06', 60);
    expect(r.due_date).toBe('2026-11-29');
  });
});

describe('calc.arTermsBasis() / orderTermsBasis()', () => {
  // 這兩個函式會查 DB（customers / ar_terms）；查不到時必須回傳 null / {} 而不能拋錯，
  // 否則訂單與應收的到期日推導會整條壞掉。
  it('查不到客戶時回傳 null，不拋錯', () => {
    const b = arTermsBasis(0);
    expect(b === null || typeof b === 'string').toBe(true);
  });

  it('orderTermsBasis 對空訂單回傳空物件', () => {
    expect(orderTermsBasis(null)).toEqual({});
    expect(orderTermsBasis(undefined)).toEqual({});
  });

  it('orderTermsBasis 回傳值只含 basis 或為空（不得帶 days，避免覆寫訂單帳期）', () => {
    const o = orderTermsBasis({ id: 1, customer_id: 999999 });
    expect(Object.keys(o).every((k) => k === 'basis')).toBe(true);
  });
});

describe('calc.agingBucket()', () => {
  it('未到期', () => { expect(agingBucket('2026-12-31', '2026-09-08')).toBe('未到期'); });
  it('逾期1-30天', () => { expect(agingBucket('2026-09-01', '2026-09-15')).toBe('逾期1-30天'); });
  it('逾期31-60天', () => { expect(agingBucket('2026-07-25', '2026-09-15')).toBe('逾期31-60天'); });
  it('逾期61-90天', () => { expect(agingBucket('2026-06-20', '2026-09-15')).toBe('逾期61-90天'); });
  it('逾期90天以上', () => { expect(agingBucket('2026-01-01', '2026-09-15')).toBe('逾期90天以上'); });
  it('null dueDate 回傳 unknown', () => { expect(agingBucket(null, '2026-09-08')).toBe('unknown'); });
  it('剛好到期日（diff=0）為逾期1-30天', () => { expect(agingBucket('2026-09-08', '2026-09-08')).toBe('逾期1-30天'); });
});
