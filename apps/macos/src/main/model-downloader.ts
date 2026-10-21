// 运行时下载 ASR 模型（方案 B：不打包，首次启动/按需联网下载）。
// 每个模型只下其注册表登记的文件（多为 int8 量化版），另加所有模型共用的 Silero VAD 依赖。
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { SILERO_VAD, getAsrModel, requiredAsrFiles, type AsrModelFile } from '@rt/core';
import { verifyModelFile } from './model-integrity';
import type { SetupProgress } from '../shared/types';

/** 指定模型（含公共依赖 VAD）是否齐全（清单来自 @rt/core 的共享登记表）。 */
export function asrModelsReady(modelsDir: string, modelId: string): boolean {
  // 未知 id 必须判「未就绪」：requiredAsrFiles 对未知 id 只返回公共依赖 VAD，
  // 仅按文件存在性判断会误报就绪，随后识别管线构造时才以「未知的识别模型」崩溃。
  if (!getAsrModel(modelId)) return false;
  return requiredAsrFiles(modelId).every((f) => fs.existsSync(path.join(modelsDir, f)));
}

// 无进展看门狗超时：连续这么久没收到任何新字节即判定连接停滞并中止本次下载。
// 「无进展超时」而非「总时长超时」——大文件慢速下载合法，只在字节流真正停滞时触发。
const STALL_TIMEOUT_MS = 30_000;

type Integrity = { expectedBytes?: number; sha256?: string };
type Progress = (loaded: number, total: number, bytesPerSec?: number) => void;
type Sidecar = { expectedBytes: number | null; sha256: string | null; url: string; etag: string | null; lastModified: string | null };
const sharedDownloads = new Map<string, { promise: Promise<void>; listeners: Set<Progress> }>();

/** One writer per destination, including shared dependencies and mirror fallback. */
export function downloadFile(
  urls: string[], dest: string, onBytes?: Progress, signal?: AbortSignal, spec: Integrity = {}
): Promise<void> {
  dest = path.resolve(dest);
  const active = sharedDownloads.get(dest);
  if (active) {
    if (onBytes) active.listeners.add(onBytes);
    return active.promise;
  }
  const listeners = new Set<Progress>(onBytes ? [onBytes] : []);
  const promise = (async () => {
    if (!urls.length) throw new Error(`无可用下载源: ${dest}`);
    const errors: string[] = [];
    for (const url of urls) {
      try {
        await downloadFromUrl(url, dest, (loaded, total, speed) => {
          for (const listener of listeners) listener(loaded, total, speed);
        }, signal, spec);
        return;
      } catch (err) {
        if (signal?.aborted) throw err;
        errors.push(`${url} → ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`全部下载源均失败:\n${errors.join('\n')}`);
  })().finally(() => { sharedDownloads.delete(dest); });
  sharedDownloads.set(dest, { promise, listeners });
  return promise;
}

async function downloadFromUrl(
  url: string, dest: string, onBytes: Progress, signal: AbortSignal | undefined, spec: Integrity
): Promise<void> {
  const part = `${dest}.part`;
  const metadata = `${part}.json`;
  let previous: Sidecar | undefined;
  try { previous = JSON.parse(fs.readFileSync(metadata, 'utf8')); } catch { /* Missing metadata cannot authorize resume. */ }
  let offset = 0;
  if (previous && (previous.sha256 ?? undefined) === spec.sha256 && (previous.expectedBytes ?? undefined) === spec.expectedBytes
    && (previous.url === url || !!spec.sha256)) {
    try { offset = fs.statSync(part).size; } catch { /* New download. */ }
  }
  const controller = new AbortController();
  let stalled = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { stalled = true; controller.abort(); }, STALL_TIMEOUT_MS);
  };
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  armWatchdog();
  try {
    const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
    if (offset) {
      headers.Range = `bytes=${offset}-`;
      const validator = previous?.etag || previous?.lastModified;
      if (validator) headers['If-Range'] = validator;
    }
    let res = await fetch(url, { headers, signal: controller.signal });
    const start = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get('content-range') || '');
    const etag = res.headers.get('etag');
    const validatorChanged = !!offset && !!etag && etag !== previous?.etag;
    if (res.status !== 416 && ((res.status === 206 && (!offset || !start || Number(start[1]) !== offset))
      || (res.status === 206 && validatorChanged))) {
      await res.body?.cancel();
      offset = 0;
      res = await fetch(url, { headers: { 'Accept-Encoding': 'identity' }, signal: controller.signal });
    }
    if (res.status === 416 && offset) {
      const completeSize = /^bytes \*\/(\d+)$/.exec(res.headers.get('content-range') || '');
      await res.body?.cancel();
      if (completeSize && Number(completeSize[1]) !== offset) {
        await verifyModelFile(part, { ...spec, expectedBytes: Number(completeSize[1]) }, signal);
      }
      clearTimeout(watchdog);
      await verifyModelFile(part, spec, signal);
      onBytes(offset, spec.expectedBytes ?? offset, 0);
    } else {
      if (!res.ok || !res.body || (res.status !== 200 && res.status !== 206)) throw new Error(`下载失败 ${res.status}: ${url}`);
      if (res.status === 200) offset = 0;
      else if (!offset) { await res.body.cancel(); throw new Error('无效的 Content-Range'); }
      if (!offset) fs.writeFileSync(part, '');
      const sidecar: Sidecar = { url, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'),
        expectedBytes: spec.expectedBytes ?? null, sha256: spec.sha256 ?? null };
      fs.writeFileSync(metadata, JSON.stringify(sidecar));
      const length = Number(res.headers.get('content-length')) || 0;
      const total = spec.expectedBytes ?? (length ? offset + length : 0);
      let loaded = offset;
      let tick = performance.now();
      let pending = 0;
      let speed = 0;
      onBytes(loaded, total, speed);
      const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      body.on('data', (chunk: Buffer) => {
        loaded += chunk.length;
        pending += chunk.length;
        const now = performance.now();
        const elapsed = now - tick;
        if (elapsed > 0) {
          const alpha = 1 - Math.exp(-elapsed / 3000);
          speed += alpha * (pending * 1000 / elapsed - speed);
          tick = now;
          pending = 0;
        }
        armWatchdog();
        onBytes(loaded, total, speed);
      });
      await streamPipeline(body, fs.createWriteStream(part, { flags: offset ? 'a' : 'w' }), { signal: controller.signal });
      if (length && loaded - offset < length) throw new Error('下载不完整');
      clearTimeout(watchdog);
      await verifyModelFile(part, spec, signal);
    }
    fs.renameSync(part, dest);
    fs.rmSync(metadata, { force: true });
  } catch (err) {
    if (!fs.existsSync(part)) fs.rmSync(metadata, { force: true });
    if (stalled && !signal?.aborted) throw new Error('下载停滞，请检查网络后重试');
    throw err;
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * 下载并安装指定 ASR 模型：公共依赖 Silero VAD（缺失才下）+ 该模型全部文件。
 * 进度按本次全部待下载文件的合计字节聚合上报：total 取注册表 approxBytes 之和，
 * loaded 跨文件累计（已完成文件的实收字节 + 当前文件的实时字节）。小文件在前、大文件在后。
 */
export async function downloadAsrModels(
  modelsDir: string,
  modelId: string,
  onProgress: (p: SetupProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const spec = getAsrModel(modelId);
  if (!spec) throw new Error(`未知的识别模型: ${modelId}`);

  const localPath = (f: AsrModelFile) => path.join(modelsDir, f.dir, f.filename);
  // 公共依赖 VAD + 该模型全部文件；已存在的跳过（只补缺）。按近似大小升序：小文件先下。
  const toDownload = [SILERO_VAD, ...spec.files]
    .filter((f) => !fs.existsSync(localPath(f)))
    .sort((a, b) => a.approxBytes - b.approxBytes);

  const total = toDownload.reduce((sum, f) => sum + f.approxBytes, 0);
  for (const f of toDownload) {
    fs.mkdirSync(path.dirname(localPath(f)), { recursive: true });
  }

  let base = 0; // 已完成文件的累计实收字节
  for (const f of toDownload) {
    // 用户取消：不再开始下一个文件（在途文件由 downloadFile 中止并保留部分文件，已完成文件由 cancel 整体删除）。
    if (signal?.aborted) throw new Error('下载已取消');
    const dest = localPath(f);
    let last = 0;
    const p = downloadFile(
      f.nativeUrls,
      dest,
      (loaded, _total, bytesPerSec) => {
        last = loaded;
        onProgress({ loaded: base + loaded, total, bytesPerSec });
      },
      signal,
      f
    );
    await p;
    base += last;
  }

  if (!asrModelsReady(modelsDir, modelId)) {
    throw new Error('ASR 模型安装后校验失败');
  }
}
