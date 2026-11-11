import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { DISK_HEADROOM_BYTES, assertDiskSpace } from './disk-space';

const volume = (freeBytes: number) => async () => ({ bavail: freeBytes / 4096, bsize: 4096 });

describe('assertDiskSpace', () => {
  const dir = os.tmpdir();
  it('可用空间容得下模型与余量时放行', async () => {
    await expect(assertDiskSpace(dir, 4e9, volume(4e9 + DISK_HEADROOM_BYTES))).resolves.toBeUndefined();
  });
  it('空间不足时在下载前报出所需与可用空间', async () => {
    await expect(assertDiskSpace(dir, 4_624_648_896, volume(2e9))).rejects.toThrow(/磁盘空间不足.*5\.7 GB.*2\.0 GB/);
  });
  it('只够模型本身、不够余量时同样拦下', async () => {
    await expect(assertDiskSpace(dir, 4e9, volume(4e9 + 1e6))).rejects.toThrow(/磁盘空间不足/);
  });
  it('接受 bigint 统计值', async () => {
    await expect(assertDiskSpace(dir, 1e9, async () => ({ bavail: 10n, bsize: 4096n }))).rejects.toThrow(/磁盘空间不足/);
  });
  it('查询失败或无需下载时不拦截', async () => {
    await expect(assertDiskSpace(dir, 1e9, async () => { throw new Error('ENOSYS'); })).resolves.toBeUndefined();
    await expect(assertDiskSpace(dir, 0, volume(0))).resolves.toBeUndefined();
  });
});
