import fs from 'node:fs';
import crypto from 'node:crypto';

export async function verifyModelFile(file: string, spec: { expectedBytes?: number; sha256?: string }, signal?: AbortSignal): Promise<void> {
  if (spec.expectedBytes !== undefined && fs.statSync(file).size !== spec.expectedBytes) {
    fs.rmSync(file, { force: true });
    throw new Error('模型文件大小不符，请重试下载');
  }
  if (!spec.sha256) return;
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  if (hash.digest('hex') !== spec.sha256) {
    fs.rmSync(file, { force: true });
    throw new Error('模型文件校验失败，请重试下载');
  }
}

