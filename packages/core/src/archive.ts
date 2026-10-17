// 对话归档的纯逻辑：摘要生成、id 生成、列表排序。
// 不依赖任何平台 API——持久化（fs 等）留在各端实现。
import type { ArchiveLine, ArchiveRecord, ArchiveSummary } from './types';

/** 由完整记录生成列表摘要（不含对话内容） */
export function toSummary(r: ArchiveRecord): ArchiveSummary {
  return {
    id: r.id,
    name: r.name,
    ...(r.folderId !== undefined ? { folderId: r.folderId } : {}),
    createdAt: r.createdAt,
    lastLine: r.lines.length > 0 ? r.lines[r.lines.length - 1].text : '',
  };
}

/** 生成归档记录 id（基于创建时间 + 随机串） */
export function makeArchiveId(createdAt: number): string {
  return `a${createdAt.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 列表按时间倒序（最新在前）并转为摘要 */
export function listSummaries(records: ArchiveRecord[]): ArchiveSummary[] {
  return [...records].sort((a, b) => b.createdAt - a.createdAt).map(toSummary);
}

/** Extract a bounded title locally; incomplete translations and short greetings are ignored. */
export function suggestArchiveTitle(lines: ArchiveLine[], fallback: string): string {
  const sentences = lines.flatMap((line) => (line.translation.trim() || line.text.trim())
    .split(/[。！？!?\n]+/u))
    .map((text) => text.trim().replace(/^(?:嗯+|啊+|那个|就是说|那么|えーと|あのう?|えっと)[，,、\s]*/u, ''))
    .filter((text) => [...text].length >= 8 && !/^(?:谢谢|感谢|大家好|こんにちは|Thank you|Hello)[，,、\s]*$/iu.test(text));
  if (!sentences.length) return fallback;
  // Prefer substantive clauses over greetings, without running another inference beside live ASR.
  const title = sentences.slice(0, 120).reduce((best, text) => {
    const score = (s: string): number => Math.min([...s].length, 36)
      + (/について|とは|介绍|讨论|设计|影响|方法|原理|发展|如何|について|concept|design|how to/iu.test(s) ? 12 : 0);
    return score(text) > score(best) ? text : best;
  });
  const chars = [...title];
  return chars.length > 30 ? chars.slice(0, 30).join('').replace(/[，,、：:；;\s]+$/u, '') + '…' : title;
}
