// 构建手动冒烟脚本（test/*.ts）为可直接 node 运行的 CJS 单文件。
// 用 esbuild 把 @rt/core 的 TS 源码内联打进来（与生产构建一致：core 以源码消费、不外部化），
// 原生模块（onnxruntime / sherpa / transformers）保持 external（运行时 require）。
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

const entry = process.argv[2];
if (!entry) {
  console.error('用法: node scripts/build-test.mjs test/<name>.ts');
  process.exit(1);
}

const entryPath = resolve(appRoot, entry);
const outfile = resolve(appRoot, 'dist-test/test', basename(entry).replace(/\.ts$/, '.js'));

await build({
  entryPoints: [entryPath],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // 原生模块保持外部化（运行时 require），与生产 main 构建一致。
  // @rt/core / chinese-conv 等纯 JS 依赖会被打进产物，使单文件可直接 node 运行。
  external: ['node-llama-cpp', '@huggingface/transformers', 'onnxruntime-node', 'sherpa-onnx-node'],
  logLevel: 'info',
});
