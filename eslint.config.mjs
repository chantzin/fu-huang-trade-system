// ESLint Flat Config（v1）— TypeScript 全量導入後支援 .js/.jsx/.ts/.tsx
// 用法：npm run lint
import js from '@eslint/js';
import react from 'eslint-plugin-react';
import tseslint from 'typescript-eslint';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        fetch: 'readonly', URL: 'readonly', Blob: 'readonly', FormData: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', console: 'readonly',
        location: 'readonly', history: 'readonly', FileReader: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        URLSearchParams: 'readonly', File: 'readonly', DataTransfer: 'readonly',
        getComputedStyle: 'readonly', matchMedia: 'readonly',
      },
    },
    plugins: { react },
    rules: {
      'react/no-danger': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // TS 檔的未定義檢查由 tsc 負責（no-undef 對 TS 型別語法會誤報）
      'no-undef': 'off',
    },
    settings: { react: { version: 'detect' } },
  },
  // 白名單：這些元件依設計使用 dangerouslySetInnerHTML（HTML 字串渲染）
  {
    files: ['src/ui/Table.tsx', 'src/ui/Modal.tsx', 'src/ui/EmailModal.tsx', 'src/ui/Tag.tsx', 'src/views/Admin.tsx', 'src/views/admin/**'],
    rules: { 'react/no-danger': 'off' },
  },
  { ignores: ['dist/**', 'dist-server/**', 'node_modules/**', 'tests/**', 'scripts/**'] },
];
