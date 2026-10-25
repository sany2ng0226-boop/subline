import { nextTick } from 'vue';
import type { DevQaBridge } from '@rt/core';

type SnapshotProvider = () => unknown;
const providers = new Map<string, SnapshotProvider>();
let channel: DevQaBridge | undefined;
let unsubscribe: (() => void) | undefined;
let generation = 0;

export function configureDevQa(next?: DevQaBridge): void {
  unsubscribe?.();
  unsubscribe = undefined;
  channel = next;
  const current = ++generation;
  if (!next) return;
  unsubscribe = next.onSnapshotRequest(async ({ requestId }) => {
    await nextTick();
    if (current !== generation) return;
    const sections: Record<string, unknown> = {};
    for (const [name, read] of providers) {
      try { sections[name] = read(); }
      catch { sections[name] = { unavailable: true }; }
    }
    try { next.reportSnapshot(requestId, { capturedAt: Date.now(), sections }); }
    catch { /* A disconnected diagnostics host must not affect the application. */ }
  });
}

export function registerDevQaProvider(name: string, read: SnapshotProvider): () => void {
  if (!channel) return () => {};
  providers.set(name, read);
  return () => { if (providers.get(name) === read) providers.delete(name); };
}

export function traceDevQa(kind: string, payload: () => unknown): void {
  if (!channel) return;
  try { channel.event(kind, payload()); } catch { /* QA must not interrupt transcription. */ }
}

export function boundedQaText(text: string, limit = 2000): { text: string; truncated: boolean } {
  return { text: text.slice(0, limit), truncated: text.length > limit };
}

type QaLine = {
  id: number; displayId: number; text: string; translation: string; time: string;
  lang?: string; translating: boolean; failed: boolean;
};
export function transcriptQaSnapshot(state: {
  lines: readonly QaLine[]; draft: QaLine | null; partial: string; stablePartial?: string;
  recording: boolean; recordBusy: boolean; modelLoading: boolean;
}): unknown {
  let remaining = 40_000;
  const takeText = (text: string) => {
    const result = boundedQaText(text, Math.min(2000, remaining));
    remaining -= result.text.length;
    return result;
  };
  const readLine = (line: QaLine) => ({
    id: line.id, displayId: line.displayId, time: line.time, lang: line.lang,
    source: takeText(line.text), translation: takeText(line.translation),
    translating: line.translating, failed: line.failed,
  });
  return {
    recording: state.recording, recordBusy: state.recordBusy, modelLoading: state.modelLoading,
    lineCount: state.lines.length,
    lineIds: state.lines.slice(-1000).map(line => ({ id: line.id, displayId: line.displayId })),
    omittedIds: Math.max(0, state.lines.length - 1000),
    omittedRows: Math.max(0, state.lines.length - 100),
    draft: state.draft ? readLine(state.draft) : null,
    partial: takeText(state.partial), stablePartial: takeText(state.stablePartial ?? ''),
    lines: state.lines.slice(-100).map(readLine),
  };
}
