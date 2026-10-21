import { ref, watch, type Ref } from 'vue';
import type { TranscriptLine } from './useTranscription';

export interface Announcement {
  id: number;
  text: string;
  kind: 'source' | 'translation';
}

/** 读屏区域最多保留的条数（只追加，旧条目移出即可，不会被重读） */
const KEEP = 5;
/** 一次出现的新条目超过这个数（撤销清空、恢复暂存）就不播报，避免把历史整段读出来 */
const BULK = 3;

/**
 * 字幕读屏播报：只播报定稿原文和定稿译文，草稿与流式译文不进入。
 * 关闭期间也持续记录已出现的行，开启后不会补读旧内容。
 */
export function useCaptionAnnouncer(lines: () => TranscriptLine[], enabled: () => boolean | undefined) {
  const announcements = ref<Announcement[]>([]) as Ref<Announcement[]>;
  const seen = new Set<string>();
  let seq = 0;

  function scan(speak: boolean): void {
    const fresh: Announcement[] = [];
    for (const line of lines()) {
      const source = `${line.displayId}:s`;
      if (!seen.has(source)) {
        seen.add(source);
        fresh.push({ id: ++seq, text: line.text, kind: 'source' });
      }
      if (line.translation && !line.translationPartial && !line.translating) {
        const translation = `${line.displayId}:t`;
        if (!seen.has(translation)) {
          seen.add(translation);
          fresh.push({ id: ++seq, text: line.translation, kind: 'translation' });
        }
      }
    }
    if (!speak || !fresh.length || fresh.length > BULK) return;
    announcements.value = [...announcements.value, ...fresh].slice(-KEEP);
  }

  scan(false);
  watch(
    () => [enabled(), ...lines().map((l) => [l.displayId, l.translation, l.translationPartial, l.translating])],
    () => scan(!!enabled()),
  );
  return { announcements };
}
