// vitest 設定（前端單元測試 + 後端工具函式測試）
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },

  test: {
    setupFiles: ['./tests/frontend/setup.js'],
    include: [
      'tests/frontend/**/*.test.js',
      'tests/backend/**/*.test.js',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'lib/**/*.js',
        'src/ui/**/*.ts',
        'src/api.ts',
        'src/store.ts',
      ],
      exclude: [
        'lib/db.js',
        'lib/parity.js',
        'lib/mailer.js',
        'lib/pdf.js',
        'lib/backup.js',
        'lib/botfx.js',
        'lib/gc.js',
        'lib/logger.js',
        'lib/exportx.js',
      ],
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
    },
  },
});
