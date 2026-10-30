import type { ArchiveLine, ArchiveRecord } from '@rt/core';

/** Never infer a recording offset from the formatted wall-clock label. */
export function lineSeek(line: ArchiveLine, record: Pick<ArchiveRecord, 'audio'>): { recordingId: string; start: number } | null {
  const audio = line.audio;
  if (!audio || !Number.isFinite(audio.start) || audio.start < 0) return null;
  const attachment = record.audio?.find((entry) => entry.id === audio.recordingId);
  if (!attachment || !Number.isFinite(attachment.durationMs) || audio.start >= attachment.durationMs / 1000) return null;
  return { recordingId: audio.recordingId, start: audio.start };
}

export function activeLineIndex(lines: ArchiveLine[], recordingId: string, time: number): number {
  return lines.findIndex(({ audio }) => audio?.recordingId === recordingId
    && Number.isFinite(audio.start) && Number.isFinite(audio.duration) && audio.duration > 0
    && time >= audio.start && time < audio.start + audio.duration);
}
