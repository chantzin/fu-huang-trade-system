import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// 輔凰貿易系統 — 前端 Vite 配置（Level B：Vite + Preact）
//  - 根目錄：專案根（index.html 在根）
//  - 建置輸出：dist/（server.js 改為服務 dist/）
//  - 開發：npm run dev 開 Vite dev server（port 5173），反向代理 /api → :5200
export default defineConfig({
  plugins: [preact()],
  root: '.',
  base: '/',
  // public/ 內的靜態檔（如 vendor/chart.umd.js）會原樣複製進 dist/
  // 2026-09-10 健檢 P1-5：Chart.js 改本地引用，斷外網時圖表仍可用
  publicDir: 'public',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:5200',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        // 拆出 vendor（preact 框架），app 本身很小
        manualChunks: {
          preact: ['preact', 'preact/hooks', '@preact/signals'],
        },
      },
    },
  },
});
