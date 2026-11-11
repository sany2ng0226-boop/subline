import { readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

// Requires Playwright with Chromium and ffmpeg; no app models or audio permissions are used.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'apps/web/public/start');
const frames = path.join(root, 'work/quick-start-video');
await mkdir(frames, { recursive: true });
const image = async (name) => `data:image/png;base64,${(await readFile(path.join(output, name))).toString('base64')}`;
const live = await image('live.png');
const settings = await image('settings.png');
const slides = [
  { title: 'Subline，从下载到第一行字幕', label: '01 / 先确认电脑', body: '<p class="large">Apple M1 或更新的 Mac<br>macOS 14.2 或更新版本</p><p>左上角  →「关于本机」，查看芯片与系统版本。</p><p>免费，不用注册，不用 API Key。<br>不用克隆代码，也不用输入命令。</p>', foot: '60 秒无声图解 · 当前安装包 v0.2.0-beta.8' },
  { title: '下载后，拖进「应用程序」', label: '02 / 安装', body: '<p>在下载页点击「下载 Mac 版」，双击下载的 .dmg 文件。</p><div class="install"><span>Subline.app</span><b>→</b><span>应用程序</span></div><p>拖进去后，从「应用程序」打开 Subline。<br>首次打开，按系统提示确认。</p>', foot: '步骤示意图，并非安装窗口实录 · 已签名并通过 Apple 公证' },
  { title: '选识别语言，需要时再开启翻译', label: '03 / 首次设置', body: `<div class="split"><div><p>听日语 → 识别语言选日语。</p><p>macOS 26+ 可选 Apple 识别；<br>其他支持的系统可用 SenseVoice。</p><p>需要中文译文：<br>下载并选中本地翻译模型，<br>翻译目标选中文。</p><p>8 / 16 GB Mac 先试只转写，<br>需要翻译时先试 M2M-100（轻量，418M）。</p></div><img src="${settings}" alt="设置页"></div>`, foot: 'beta.7 实际截图；beta.8 界面可能略有不同 · 其他内存容量的流畅程度尚未验证' },
  { title: '你想听的声音，来自哪里？', label: '04 / 选音源', body: '<div class="sources"><div><h2>身边的人说话</h2><p class="large">选「麦克风」</p><p>教室、面对面交流</p></div><div><h2>电脑正在播放</h2><p class="large">选「系统音频」</p><p>网课、视频、线上会议</p></div></div><p>按提示允许对应音频权限，然后点击开始录音。</p>', foot: '首次下载模型需联网 · 下载完成后确认已选中模型' },
  { title: '先试一小段，确认字幕出现', label: '05 / 开始使用', body: `<div class="split"><div><p>第一次使用，<br>要等待模型加载。</p><p>先确认看到原文；<br>需要翻译时，<br>再确认下方出现译文。</p><p>重要内容请核对原文与原音。</p></div><img src="${live}" alt="实时字幕"></div>`, foot: 'beta.7 实际截图，合成语音演示 · 识别和翻译都可能出错' },
  { title: '最后一步：记得归档保存', label: '06 / 留住内容', body: '<p class="large">停止录音 → 等译文完成<br>→ 点击顶栏「归档」→ 保存</p><p>停止录音不会自动保存。<br>未归档录音会在退出时清理。</p><p>保存后去归档页查看，beta.8 还能回放原音。<br>遇到问题，回下载页查看「常见问题」。</p>', foot: 'Subline · 本地转写与翻译 · 详细步骤见下载页' },
];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  for (const [index, slide] of slides.entries()) {
    await page.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;padding:48px 64px;background:#fff;color:#18181b;font-family:-apple-system,"PingFang SC",sans-serif;line-height:1.65}header{display:flex;justify-content:space-between;color:#3557d6;font-size:18px;font-weight:600;border-bottom:1px solid #e8e8e5;padding-bottom:16px}h1{font-size:40px;line-height:1.3;letter-spacing:-1px;margin:24px 0}h2{font-size:22px;margin:0 0 18px}p{font-size:24px;color:#3f3f46;margin:0 0 20px}.large{font-size:34px;font-weight:600;color:#18181b}.body{height:430px;overflow:hidden}.split{display:grid;grid-template-columns:1fr 1fr;gap:30px;height:430px}.split p{font-size:22px}.split img{max-width:100%;max-height:420px;object-fit:contain;justify-self:center;border:1px solid #e8e8e5;border-radius:10px}.install{display:flex;align-items:center;gap:38px;margin:32px 0;font-size:38px;color:#3557d6}.install span{padding:24px;border:1px solid #e8e8e5;border-radius:10px;background:#f6f6f4}.sources{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin:30px 0}footer{position:absolute;bottom:28px;left:64px;right:64px;border-top:1px solid #e8e8e5;padding-top:15px;font-size:16px;color:#55555f}
      </style><header><span>Subline · 一分钟快速开始</span><span>${slide.label}</span></header><h1>${slide.title}</h1><div class="body">${slide.body}</div><footer>${slide.foot}</footer></html>`);
    await page.evaluate(() => Promise.all([...document.images].map(img => img.decode())));
    await page.screenshot({ path: path.join(frames, `slide-${String(index + 1).padStart(2, '0')}.png`) });
  }
} finally {
  await browser.close();
}
execFileSync('ffmpeg', ['-y', '-framerate', '1/10', '-start_number', '1', '-i', path.join(frames, 'slide-%02d.png'), '-t', '60', '-r', '24', '-c:v', 'libx264', '-preset', 'medium', '-crf', '25', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(output, 'quick-start.mp4')], { stdio: 'inherit' });
