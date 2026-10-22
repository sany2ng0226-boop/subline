// 由共享满版母版 assets/icon.svg 生成 macOS 应用图标资源：
//   assets/icon.png   1024×1024 主图（macOS 取景后：圆角内缩）
//   build/icon.icns   macOS 应用图标（electron-builder 的 app-builder 生成）
// 母版是满版出血；macOS 在此缩进 848 + 圆角 + 居中于透明画布，符合 Big Sur 图标网格。
// 用法：node scripts/gen-icon.mjs
import { execFileSync } from 'node:child_process';
import { renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const require = createRequire(import.meta.url);

// 相对脚本自身定位，不依赖 cwd。
const scriptDir = dirname(fileURLToPath(import.meta.url)); // apps/macos/scripts
const macosRoot = join(scriptDir, '..'); // apps/macos
const repoRoot = join(macosRoot, '..', '..'); // 仓库根
const assets = join(repoRoot, 'assets'); // 共享图标源

const svg = join(assets, 'icon.svg'); // 满版母版（共享）
const dev = process.argv.includes('--dev');
const pngMaster = dev ? join(macosRoot, 'build', 'icon-dev.png') : join(assets, 'icon.png'); // macOS 取景后的 1024 主图（圆角内缩）
const icns = join(macosRoot, 'build', dev ? 'icon-dev.icns' : 'icon.icns');
const iconOutput = join(macosRoot, 'build', '.icon-icns');

// macOS 取景：满版母版缩进 848 + 圆角(rx196) + 居中于 1024 透明画布（留 88 边，符合 Big Sur 网格）
const INNER = 848;
const RX = 196;
const MARGIN = (1024 - INNER) / 2;
const innerRounded = await sharp(svg, { density: 512 })
  .resize(INNER, INNER)
  .composite([
    {
      input: Buffer.from(
        `<svg width="${INNER}" height="${INNER}"><rect width="${INNER}" height="${INNER}" rx="${RX}" ry="${RX}"/></svg>`
      ),
      blend: 'dest-in', // 圆角裁切
    },
  ])
  .png()
  .toBuffer();
// 白底母版在浅色桌面/Dock 上会与背景融在一起：按 Big Sur 网格自带一层柔和投影 + 极淡描边勾出轮廓。
const shadow = await sharp(
  Buffer.from(
    `<svg width="1024" height="1024"><rect x="${MARGIN}" y="${MARGIN + 12}" width="${INNER}" height="${INNER}" rx="${RX}" ry="${RX}" fill="#000" fill-opacity="0.22"/></svg>`
  )
)
  .blur(18)
  .png()
  .toBuffer();
const outline = Buffer.from(
  `<svg width="1024" height="1024"><rect x="${MARGIN + 1}" y="${MARGIN + 1}" width="${INNER - 2}" height="${INNER - 2}" rx="${RX - 1}" ry="${RX - 1}" fill="none" stroke="#000" stroke-opacity="0.08" stroke-width="2"/></svg>`
);
let framed = await sharp({
  create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([
    { input: shadow, top: 0, left: 0 },
    { input: innerRounded, top: MARGIN, left: MARGIN },
    { input: outline, top: 0, left: 0 },
  ])
  .png()
  .toBuffer();

if (dev) {
  framed = await sharp(framed).composite([{ input: Buffer.from(
    '<svg width="1024" height="1024"><rect x="500" y="690" width="460" height="240" rx="55" fill="#d71920" stroke="white" stroke-width="12"/><text x="730" y="858" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="155" font-weight="900" fill="white">DEV</text></svg>'
  ) }]).png().toBuffer();
}

// 各尺寸从已取景的 1024 缩放（避免重复栅格化 SVG）
const render = (size, out) => sharp(framed).resize(size, size).png().toFile(out);

await render(1024, pngMaster);
console.log(`✓ ${pngMaster} (1024)`);

// macOS 26.2 的 iconutil 会把自己刚解出的标准 iconset 也误报为 Invalid Iconset。
// electron-builder 自带的 app-builder 使用独立转换器，产物同时兼容旧版 macOS。
const { appBuilderPath } = require('app-builder-bin');
rmSync(iconOutput, { recursive: true, force: true });
try {
  execFileSync(
    appBuilderPath,
    ['icon', '--format', 'icns', '--root', assets, '--out', iconOutput, '--input', pngMaster],
    { stdio: 'inherit' },
  );
  renameSync(join(iconOutput, 'icon.icns'), icns);
} finally {
  rmSync(iconOutput, { recursive: true, force: true });
}
console.log(`✓ ${icns}`);
