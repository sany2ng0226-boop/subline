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
    preview: previewLine(r.lines),
    ...(r.audio?.length ? { audioCount: r.audio.length } : {}),
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

const LEADING_FILLER = /^(?:嗯+|啊+|那个|就是说|那么|えーと|あのう?|えっと)[，,、\s]*/u;
const GREETING = /^(?:谢谢|感谢|大家好|こんにちは|Thank you|Hello)[，,、\s]*$/iu;
const isSubstantive = (text: string): boolean => [...text].length >= 8 && !GREETING.test(text);

/** 列表预览：课堂结尾多是「うん。」这类收尾话，取第一条有内容的原文；都太短时退回第一条非空原文。 */
function previewLine(lines: ArchiveLine[]): string {
  const texts = lines.map((line) => line.text.trim()).filter(Boolean);
  return texts.find((text) => isSubstantive(text.replace(LEADING_FILLER, ''))) ?? texts[0] ?? '';
}

/** Extract a bounded title locally; incomplete translations and short greetings are ignored. */
export function suggestArchiveTitle(lines: ArchiveLine[], fallback: string): string {
  const sentences = lines.flatMap((line) => (line.translation.trim() || line.text.trim())
    .split(/[。！？!?\n]+/u))
    .map((text) => text.trim().replace(LEADING_FILLER, ''))
    .filter(isSubstantive);
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
