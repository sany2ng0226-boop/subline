// macOS 打包：解决 pnpm workspace 下 electron-builder 找不到 node_modules 的问题。
// 流程：electron-vite 构建 → pnpm deploy 导出自包含副本（带真实 node_modules + out/）
// → 在副本里跑 electron-builder → 产物回写到 apps/macos/release。
// 不签名构建：CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @rt/macos dist
import { execSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..'); // apps/macos
const root = path.resolve(appDir, '..', '..'); // 工作区根
const deployDir = path.join(root, '.deploy-macos'); // 自包含副本（已 gitignore）
const releaseDir = process.env.RT_RELEASE_DIR
  ? path.resolve(process.env.RT_RELEASE_DIR)
  : path.join(appDir, process.argv.includes('--preview') ? 'release-preview' : 'release');
const dirOnly = process.argv.includes('--dir');
const preview = process.argv.includes('--preview');
// CI notarizes and staples the app before constructing the DMG.
const manualNotarize = process.argv.includes('--manual-notarize');

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

console.log('▶ 1/4 构建 (electron-vite)');
run(preview ? 'RT_INTERNAL_BUILD=1 pnpm run build' : 'pnpm run build', appDir);

console.log('▶ 2/4 生成应用图标 (从共享 assets/ 重建 build/icon.icns)');
run('pnpm run icons', appDir);

console.log('▶ 3/4 导出自包含副本 (pnpm deploy)');
rmSync(deployDir, { recursive: true, force: true });
// --prod=false 以带上 electron / electron-builder（构建期需要）；electron-builder 只把生产依赖打进 .app
// The deploy lockfile must preserve the dependency versions checked in the workspace.
run(`pnpm --filter @rt/macos deploy --prod=false "${deployDir}"`, root);

console.log('▶ 4/4 打包 (electron-builder)');
const target = dirOnly ? '--dir' : '';
// 打包版本来自根 package.json；发布 CI 要求它与 macOS 包版本和标签一致。
// extraMetadata.version 决定 dmg 文件名与 App 的 CFBundleShortVersionString。
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
run(
  `./node_modules/.bin/electron-builder --mac --arm64 ${target} -c.extraMetadata.version="${version}" ` +
  (manualNotarize ? '-c.mac.notarize=false -c.forceCodeSigning=true --publish never ' : '') +
  (preview ? '-c.appId=io.github.sany2ng0226.classroomtranslator.preview -c.productName="Subline Internal" -c.extraMetadata.name=realtime-translator-internal -c.extraMetadata.productName="Subline Internal" ' : '-c.extraMetadata.name=realtime-translator -c.extraMetadata.productName="Subline" ') +
  `-c.directories.output="${releaseDir}"`,
  deployDir
);

console.log(`✓ 完成，产物在 ${releaseDir}`);
