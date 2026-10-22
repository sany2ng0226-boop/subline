import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVersion } from '../../scripts/build-version';

// 以配置文件自身所在目录为根，确保无论从哪个 cwd（如 monorepo 根 `pnpm --filter`）
// 调用，别名都解析到 apps/macos/src/...。
const root = fileURLToPath(new URL('.', import.meta.url));

// 默认布局：main = src/main/index.ts，preload = src/preload/index.ts，
// renderer root = src/renderer（index.html）。v5 默认外部化依赖，
// 因此 sherpa-onnx-node / onnxruntime-node 等原生模块在主进程保持 require、不被打包。
// 例外：@rt/core 以 TS 源码消费，必须打进 main/preload 产物（不能外部化），
// 否则 out 里会留下 require("@rt/core") 在运行时找不到而崩溃。
export default defineConfig({
  main: {
    define: { __SUBLINE_VARIANT__: JSON.stringify(process.env['SUBLINE_VARIANT'] === 'dev' ? 'dev' : 'release') },
    plugins: [externalizeDepsPlugin({ exclude: ['@rt/core'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@rt/core'] })],
  },
  renderer: {
    // 发布版本串（包版本+commit 短哈希），mac-bridge 经 appVersion 暴露给设置页
    define: {
      __APP_VERSION__: JSON.stringify(buildVersion(root)),
      __INTERNAL_BUILD__: JSON.stringify(process.env['RT_INTERNAL_BUILD'] === '1'),
    },
    resolve: {
      alias: {
        // UI has no build step; injected workspace copies can lag behind its source.
        '@rt/ui/styles': resolve(root, '../../packages/ui/src/styles.css'),
        '@rt/ui': resolve(root, '../../packages/ui/src/index.ts'),
        '@': resolve(root, 'src/renderer/src'),
        '@shared': resolve(root, 'src/shared'),
      },
    },
    plugins: [vue(), tailwindcss()],
  },
});
