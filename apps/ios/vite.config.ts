import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { buildVersion } from '../../scripts/build-version';

// 以 index.html 为入口构建 WebView 产物到 dist/。
// @rt/ui 与 @rt/core 以 TS 源码消费，Vite 会把它们一起打进 bundle（浏览器目标，自动）。
// base 用相对路径：Capacitor 在原生壳里以 capacitor://localhost 加载本地文件，
// 资源引用必须相对，绝对路径 `/assets/...` 会 404。
export default defineConfig({
  base: './',
  // 发布版本串（包版本+commit 短哈希），设置页经 bridge.appVersion 展示
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion(fileURLToPath(new URL('.', import.meta.url)))),
  },
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      // Injected workspace copies can lag behind source-only UI modules.
      '@rt/ui/styles': fileURLToPath(new URL('../../packages/ui/src/styles.css', import.meta.url)),
      '@rt/ui': fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
