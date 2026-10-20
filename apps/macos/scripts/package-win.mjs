import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const appDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = path.resolve(appDir, '..', '..');
const deployDir = path.join(root, '.deploy-windows');
const releaseDir = process.env.RT_RELEASE_DIR
  ? path.resolve(process.env.RT_RELEASE_DIR)
  : path.join(appDir, 'release-windows');
const dirOnly = process.argv.includes('--dir');
const pnpmCli = process.env.npm_execpath;

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Build the Windows x64 candidate on Windows x64 so its native dependencies match the target.');
}
if (!pnpmCli || !/pnpm[^\\/]*\.(?:c?js)$/i.test(pnpmCli) || !existsSync(pnpmCli)) {
  throw new Error('Run this script through pnpm: pnpm --filter @rt/macos dist:win');
}

const env = {
  ...process.env,
  RT_INTERNAL_BUILD: '1',
  NODE_LLAMA_CPP_SKIP_DOWNLOAD: 'true',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};
function run(executable, args, cwd = appDir) {
  const result = spawnSync(executable, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(executable)} failed (${result.status ?? result.signal})`);
}
const pnpm = (args, cwd) => run(process.execPath, [pnpmCli, ...args], cwd);

console.log('1/4 Build the shared desktop host');
pnpm(['run', 'build']);

console.log('2/4 Generate the Windows icon');
const buildDir = path.join(appDir, 'build');
const iconPng = path.join(buildDir, 'icon-windows.png');
const iconDir = path.join(buildDir, '.icon-ico');
mkdirSync(buildDir, { recursive: true });
await sharp(path.join(root, 'assets', 'icon.svg'), { density: 256 })
  .resize(256, 256).png().toFile(iconPng);
rmSync(iconDir, { recursive: true, force: true });
try {
  const { appBuilderPath } = require('app-builder-bin');
  run(appBuilderPath, ['icon', '--format', 'ico', '--root', buildDir, '--out', iconDir, '--input', iconPng]);
  renameSync(path.join(iconDir, 'icon.ico'), path.join(buildDir, 'icon.ico'));
} finally {
  rmSync(iconDir, { recursive: true, force: true });
}

console.log('3/4 Export the locked, self-contained dependency graph');
rmSync(deployDir, { recursive: true, force: true });
pnpm(['--filter', '@rt/macos', 'deploy', '--prod=false', deployDir], root);
// Generated icons may be excluded by pnpm's pack rules; copy only the build resources explicitly.
mkdirSync(path.join(deployDir, 'build'), { recursive: true });
copyFileSync(path.join(buildDir, 'icon.ico'), path.join(deployDir, 'build', 'icon.ico'));
copyFileSync(path.join(buildDir, 'HY-MT2-LICENSE.txt'), path.join(deployDir, 'build', 'HY-MT2-LICENSE.txt'));
copyFileSync(path.join(appDir, 'electron-builder.windows.yml'), path.join(deployDir, 'electron-builder.windows.yml'));
for (const dependency of [
  '@node-llama-cpp/win-x64', '@node-llama-cpp/win-x64-cuda',
  '@node-llama-cpp/win-x64-cuda-ext', 'sherpa-onnx-win-x64',
]) {
  if (!existsSync(path.join(deployDir, 'node_modules', dependency, 'package.json'))) {
    throw new Error(`Missing locked Windows runtime ${dependency}; install optional dependencies on Windows before packaging.`);
  }
}

console.log('4/4 Build the unsigned Windows candidate (publishing disabled)');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const deployRequire = createRequire(path.join(deployDir, 'package.json'));
const builderCli = path.join(path.dirname(deployRequire.resolve('electron-builder/package.json')), 'cli.js');
run(process.execPath, [
  builderCli, '--config', 'electron-builder.windows.yml', '--win', '--x64',
  ...(dirOnly ? ['--dir'] : []), '--publish', 'never',
  `-c.extraMetadata.version=${version}`,
  '-c.extraMetadata.name=subline-windows-candidate',
  '-c.extraMetadata.productName=Subline',
  `-c.directories.output=${releaseDir}`,
], deployDir);
console.log(`Windows candidate: ${releaseDir}`);
