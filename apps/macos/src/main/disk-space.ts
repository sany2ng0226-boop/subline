// 下载前的磁盘空间检查：空间不够时在开始前就给出明确原因，而不是下到一半才以写入错误失败。
import fs from 'node:fs';

/** 下载所需字节之外保留的余量：临时文件、文件系统开销，以及避免把系统盘写满。 */
export const DISK_HEADROOM_BYTES = 1024 ** 3;

type StatFs = (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;

const gb = (bytes: number): string => (bytes / 1e9).toFixed(1);

/**
 * dir 所在卷的可用空间不足以容纳 requiredBytes + 余量时抛错。
 * 查询失败（目录所在卷不支持 statfs 等）时放行：不能因为查不到空间就拦住下载。
 */
export async function assertDiskSpace(
  dir: string,
  requiredBytes: number,
  statfs: StatFs = (target) => fs.promises.statfs(target),
): Promise<void> {
  if (!(requiredBytes > 0)) return;
  let free: number;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const stat = await statfs(dir);
    free = Number(stat.bavail) * Number(stat.bsize);
  } catch { return; }
  if (!Number.isFinite(free)) return;
  const needed = requiredBytes + DISK_HEADROOM_BYTES;
  if (free < needed) {
    throw new Error(`磁盘空间不足：需要约 ${gb(needed)} GB，目前可用 ${gb(free)} GB。请清理空间后重试。`);
  }
}
