// 把模型资产原样转存到 Subline 自己的 models-v1 release（一次性迁移，未来显式启用后才使用该镜像）。
// 每个文件从上游下载后按 SELF_HOSTED_PINS 核对字节数与 SHA-256，一致才上传；已存在且摘要一致的跳过。
//
// 用法（需 Node 22.18+ 直接加载 .ts、已登录且对目标仓库有写权限的 gh）：
//   node scripts/mirror-model-assets.mjs            # 演练：只列出将要上传的资产，不下载、不上传
//   node scripts/mirror-model-assets.mjs --upload   # 实际转存并上传，完成后逐个核对线上摘要
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SELF_HOSTED, SELF_HOSTED_PINS } = await import(path.join(root, 'packages/core/src/model-sources.ts'));
const UPSTREAM = 'https://github.com/baijunjie/realtime-translator/releases/download/models-v1';
const repo = `${SELF_HOSTED.owner}/${SELF_HOSTED.repo}`;
const tag = SELF_HOSTED.tag;
const notice = path.join(root, 'THIRD_PARTY_MODELS.md');
const upload = process.argv.includes('--upload');

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function remoteAssets() {
  try {
    return new Map(JSON.parse(gh('api', `repos/${repo}/releases/tags/${tag}`)).assets.map((a) => [a.name, a]));
  } catch {
    return null; // release 尚不存在
  }
}
const matches = (asset, pin) => asset && asset.size === pin.bytes && asset.digest === `sha256:${pin.sha256}`;

const entries = Object.entries(SELF_HOSTED_PINS);
const existing = upload ? remoteAssets() : null;
const pending = entries.filter(([name, pin]) => !matches(existing?.get(name), pin));
const totalBytes = pending.reduce((sum, [, pin]) => sum + pin.bytes, 0);
console.log(`目标：${repo} release ${tag}（${existing ? '已存在' : '未查询或尚未创建'}）`);
console.log(`待上传 ${pending.length}/${entries.length} 个资产，合计 ${(totalBytes / 2 ** 30).toFixed(2)} GiB，另附 THIRD_PARTY_MODELS.md`);
for (const [name, pin] of pending) console.log(`  ${name}  ${pin.bytes}  ${pin.sha256}`);
if (!upload) {
  console.log('\n演练结束：未下载、未上传。确认后加 --upload 执行。');
  process.exit(0);
}

if (!existing) {
  gh('release', 'create', tag, '--repo', repo, '--title', 'Model assets (models-v1)',
    '--notes', 'Runtime model files mirrored unchanged; sizes and SHA-256 are pinned in packages/core/src/model-sources.ts. See THIRD_PARTY_MODELS.md for authors and licenses.');
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'subline-models-'));
try {
  for (const [name, pin] of pending) {
    const file = path.join(work, name);
    const res = await fetch(`${UPSTREAM}/${name}`);
    if (!res.ok || !res.body) throw new Error(`上游下载失败 ${res.status}: ${name}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    const size = fs.statSync(file).size;
    if (size !== pin.bytes || hash.digest('hex') !== pin.sha256) throw new Error(`上游内容与登记指纹不符，已停止: ${name}`);
    gh('release', 'upload', tag, file, '--repo', repo, '--clobber');
    fs.rmSync(file);
    console.log(`✓ ${name}`);
  }
  gh('release', 'upload', tag, notice, '--repo', repo, '--clobber');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

const after = remoteAssets();
const bad = entries.filter(([name, pin]) => !matches(after?.get(name), pin)).map(([name]) => name);
if (bad.length) throw new Error(`线上核对失败：${bad.join(', ')}`);
console.log(`✓ ${entries.length} 个资产的线上字节数与 SHA-256 均与登记一致`);
