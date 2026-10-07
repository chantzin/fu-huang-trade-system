// lib/rbac.js 單元測試
import { describe, it, expect } from 'vitest';
import { ROLES, PERMISSIONS, getRoleLevel, hasPermission } from '../../lib/rbac.js';

describe('rbac.ROLES', () => {
  it('包含 4 個角色', () => { expect(Object.keys(ROLES).length).toBe(4); });
  it('admin 等級 100', () => { expect(ROLES.admin.level).toBe(100); });
  it('manager 等級 80', () => { expect(ROLES.manager.level).toBe(80); });
  it('accounting 等級 60', () => { expect(ROLES.accounting.level).toBe(60); });
  it('sales 等級 40', () => { expect(ROLES.sales.level).toBe(40); });
});

describe('rbac.PERMISSIONS', () => {
  it('包含系統管理權限', () => { expect(PERMISSIONS['system:manage']).toBeDefined(); });
  it('包含交易寫入權限', () => { expect(PERMISSIONS['transaction:write']).toBeDefined(); });
  it('包含財務寫入權限', () => { expect(PERMISSIONS['finance:write']).toBeDefined(); });
  it('包含報表讀取權限', () => { expect(PERMISSIONS['report:read']).toBeDefined(); });
});

describe('rbac.getRoleLevel()', () => {
  it('admin 回傳 100', () => { expect(getRoleLevel('admin')).toBe(100); });
  it('manager 回傳 80', () => { expect(getRoleLevel('manager')).toBe(80); });
  it('未知角色回傳 0', () => { expect(getRoleLevel('unknown')).toBe(0); });
  it('null 回傳 0', () => { expect(getRoleLevel(null)).toBe(0); });
});

describe('rbac.hasPermission()', () => {
  it('admin 擁有所有權限', () => {
    for (const perm of Object.keys(PERMISSIONS)) {
      expect(hasPermission('admin', perm)).toBe(true);
    }
  });
  it('manager 擁有 system:manage 權限', () => { expect(hasPermission('manager', 'system:manage')).toBe(true); });
  it('manager 不擁有 system:admin 權限', () => { expect(hasPermission('manager', 'system:admin')).toBe(false); });
  it('accounting 擁有 finance:write 權限', () => { expect(hasPermission('accounting', 'finance:write')).toBe(true); });
  it('accounting 不擁有 system:manage 權限', () => { expect(hasPermission('accounting', 'system:manage')).toBe(false); });
  it('sales 擁有 transaction:read 權限', () => { expect(hasPermission('sales', 'transaction:read')).toBe(true); });
  it('sales 不擁有 transaction:write 權限', () => { expect(hasPermission('sales', 'transaction:write')).toBe(false); });
  it('未知權限回傳 false', () => { expect(hasPermission('admin', 'unknown:perm')).toBe(false); });
  it('未知角色回傳 false', () => { expect(hasPermission('unknown', 'system:manage')).toBe(false); });
});
