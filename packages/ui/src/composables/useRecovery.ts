import { ref, watch } from 'vue';
import { bridge } from '../bridge';
import {
  lines,
  recordingIds,
  restoreRecordings,
  canUndoDelete,
  recoverySnapshot,
  recordingStartedAt,
  restoreLines,
  type RecoveredLine,
} from './useTranscription';

// 未归档内容的崩溃暂存：渲染进程或宿主被强退后，下次启动可以把字幕找回来。
// macOS 由宿主写 userData/recovery.json（saveRecovery 等可选桥接）；没有实现时回退 localStorage。

export const RECOVERY_KEY = 'rt.recovery.v1';
/** 两次写入的最小间隔；进入后台 / 关闭页面时不受此限，立即补写 */
export const RECOVERY_THROTTLE_MS = 10_000;

export interface RecoverySnapshot {
  version: 1;
  lines: RecoveredLine[];
  audioIds?: string[];
  /** 识别语言设置 */
  lang?: string;
  /** 录音开始时刻（epoch ms） */
  startedAt?: number;
  savedAt: number;
}

/** 启动时发现的上次未归档内容；用户选择恢复或丢弃前一直保留在暂存里 */
export const recoveryOffer = ref<RecoverySnapshot | null>(null);

function local(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function hostStore() {
  const b = bridge();
  return b.saveRecovery && b.loadRecovery && b.clearRecovery ? b : null;
}

async function writeStore(json: string): Promise<void> {
  const host = hostStore();
  if (host) {
    try {
      await host.saveRecovery!(json);
      return;
    } catch (error) {
      console.error('[recovery:save]', error);
    }
  }
  try {
    local()?.setItem(RECOVERY_KEY, json);
  } catch (error) {
    console.error('[recovery:save]', error);
  }
}

async function readStore(): Promise<string | null> {
  const host = hostStore();
  if (host) {
    try {
      const json = await host.loadRecovery!();
      if (json) return json;
    } catch (error) {
      console.error('[recovery:load]', error);
    }
  }
  // 宿主写失败时可能落在了 localStorage
  return local()?.getItem(RECOVERY_KEY) ?? null;
}

async function clearStore(): Promise<void> {
  try {
    local()?.removeItem(RECOVERY_KEY);
  } catch {
    /* 存储不可用：没有可清的 */
  }
  try {
    await hostStore()?.clearRecovery!();
  } catch (error) {
    console.error('[recovery:clear]', error);
  }
}

function parse(json: string | null): RecoverySnapshot | null {
  if (!json) return null;
  try {
    const data = JSON.parse(json) as Partial<RecoverySnapshot>;
    if (data?.version !== 1 || !Array.isArray(data.lines) || typeof data.savedAt !== 'number') return null;
    const valid = data.lines.filter((l): l is RecoveredLine =>
      !!l && typeof l.time === 'string' && typeof l.text === 'string' && typeof l.translation === 'string');
    const audioIds = Array.isArray(data.audioIds) ? data.audioIds.filter((id): id is string => typeof id === 'string') : [];
    return valid.length || audioIds.length ? { ...data, lines: valid, ...(audioIds.length ? { audioIds } : {}) } as RecoverySnapshot : null;
  } catch {
    return null;
  }
}

let initCalled = false;
// 读完上次暂存后才开始写入
let started = false;
let langOf: () => string | undefined = () => undefined;
let lastLinesJson = '';
let lastWriteAt = -Infinity;
let timer: ReturnType<typeof setTimeout> | undefined;

/** 按当前内容立即写入或清除暂存（跳过节流） */
export function persistRecoveryNow(): void {
  if (!started) return;
  clearTimeout(timer);
  timer = undefined;
  // 清空后的撤销窗口内保留上一份暂存：撤销期过后才真正清除
  if (!lines.length && !recordingIds.length && canUndoDelete.value) return;
  const all = [...(recoveryOffer.value?.lines ?? []), ...recoverySnapshot()];
  const audioIds = [...new Set([...(recoveryOffer.value?.audioIds ?? []), ...recordingIds])];
  const linesJson = all.length || audioIds.length ? JSON.stringify({ lines: all, audioIds }) : '';
  if (linesJson === lastLinesJson) return;
  lastLinesJson = linesJson;
  if (!all.length && !audioIds.length) {
    void clearStore();
    return;
  }
  lastWriteAt = Date.now();
  const snapshot: RecoverySnapshot = {
    version: 1,
    lines: all,
    ...(audioIds.length ? { audioIds } : {}),
    ...(langOf() ? { lang: langOf() } : {}),
    ...(recordingStartedAt() ? { startedAt: recordingStartedAt() } : {}),
    savedAt: lastWriteAt,
  };
  void writeStore(JSON.stringify(snapshot));
}

function schedule(): void {
  // 内容被清掉时立即清除；否则最多每 10 秒写一次
  if (!lines.length) {
    persistRecoveryNow();
    return;
  }
  if (timer) return;
  const wait = lastWriteAt + RECOVERY_THROTTLE_MS - Date.now();
  if (wait <= 0) persistRecoveryNow();
  else timer = setTimeout(persistRecoveryNow, wait);
}

/** 恢复上次未归档的内容（放在当前内容之前） */
export function restoreRecovery(): void {
  const offer = recoveryOffer.value;
  if (!offer) return;
  recoveryOffer.value = null;
  restoreLines(offer.lines);
  restoreRecordings(offer.audioIds ?? []);
  persistRecoveryNow();
}

/** 丢弃上次未归档的内容 */
export function discardRecovery(): void {
  const ids = recoveryOffer.value?.audioIds?.filter((id) => !recordingIds.includes(id)) ?? [];
  recoveryOffer.value = null;
  void bridge().discardRecordings?.(ids).catch((error) => console.error('[recovery:discard-audio]', error));
  persistRecoveryNow();
}

/**
 * 读取上次暂存并开始跟踪当前内容。由 mountApp 调用一次（悬浮窗不调用）。
 * 读取完成前不写入，避免启动时的空列表把上次的暂存清掉。
 */
export async function initRecovery(options: { lang?: () => string | undefined } = {}): Promise<void> {
  if (initCalled) return;
  initCalled = true;
  if (options.lang) langOf = options.lang;
  const persistedOffer = parse(await readStore());
  let offer = persistedOffer;
  // WAV files are independently discoverable if the renderer died before receiving its ID.
  try {
    const pending = await bridge().listUnarchivedRecordings?.() ?? [];
    if (pending.length) offer = {
      version: 1, lines: offer?.lines ?? [], savedAt: offer?.savedAt ?? Date.now(),
      ...offer, audioIds: [...new Set([...(offer?.audioIds ?? []), ...pending])],
    };
  } catch (error) { console.error('[recovery:audio]', error); }
  if (offer) {
    recoveryOffer.value = offer;
    lastLinesJson = persistedOffer
      ? JSON.stringify({ lines: persistedOffer.lines, audioIds: persistedOffer.audioIds ?? [] }) : '';
  } else {
    // 没有可用暂存（含损坏的）：清掉残留
    await clearStore();
  }
  started = true;
  watch(
    () => [lines.length, [...recordingIds], canUndoDelete.value, lines.map((l) => [l.translationPartial ? '' : l.translation, l.nativeTranslation?.completed, l.nativeTranslation?.failed])],
    schedule,
  );
  if (lines.length || recordingIds.length) schedule();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') persistRecoveryNow();
    });
  }
  if (typeof window !== 'undefined') window.addEventListener('pagehide', persistRecoveryNow);
}
