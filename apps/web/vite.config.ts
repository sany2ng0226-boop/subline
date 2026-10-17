import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';
import { buildVersion } from '../../scripts/build-version';

// 以 index.html 为入口构建浏览器 PWA 产物到 dist/。
// @rt/ui 与 @rt/core 以 TS 源码消费，Vite 会把它们一起打进 bundle。
//
// base：默认 '/'，部署到 GitHub Pages（子路径）时用 BASE_PATH 注入，例如
//   BASE_PATH=/realtime-translator/ pnpm --filter @rt/web build
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  base,
  // 发布版本串（包版本+commit 短哈希），设置页经 bridge.appVersion 展示
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion(fileURLToPath(new URL('.', import.meta.url)))),
  },
  plugins: [
    vue(),
    tailwindcss(),
    VitePWA({
      // 自动注册并在新版本就绪后静默更新 Service Worker。
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Subline',
        short_name: 'Subline',
        description: 'Local, real-time speech transcription and translation in your browser',
        // 浅色应用底色；主题色与白底图标、浅色界面一致。
        background_color: '#ffffff',
        theme_color: '#FFFFFF',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 预缓存应用外壳 + sherpa .wasm（已安装 PWA 离线冷启动 ASR 依赖它随外壳一并预缓存）；
        // 翻译大模型不在此预缓存，Phase 2 用 runtime 缓存单独处理。
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2,wasm}'],
        // onnxruntime-web 的翻译运行时 .wasm（~24MB）不预缓存：仅本地翻译用户需要（iOS Web
        // 只有云端翻译），随翻译模型在首次启用时按需加载，避免所有安装都多拖二十多 MB。
        globIgnores: ['**/ort-*.wasm'],
        // 单文件上限需覆盖 sherpa .wasm（~13MB）；transformers.js / onnx 的 HF 远程模型仍不会
        // 被纳入预缓存（它们不是构建产物）。
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        navigateFallback: `${base}index.html`,
      },
      devOptions: {
        // 开发期不启用 SW，避免缓存干扰热更新（getUserMedia 在 localhost 下本就允许）。
        enabled: false,
      },
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
