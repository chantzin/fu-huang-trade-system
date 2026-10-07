// vitest setup：在 node 環境 mock 瀏覽器全域（B2）
import { vi } from 'vitest';

vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
});
vi.stubGlobal('sessionStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
});
vi.stubGlobal('location', { hash: '#/dashboard', href: 'http://localhost/', pathname: '/' });
vi.stubGlobal('window', { location: { hash: '#/dashboard' }, addEventListener: () => {} });
