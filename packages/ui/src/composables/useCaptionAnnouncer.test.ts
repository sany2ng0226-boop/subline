import { expect, it } from 'vitest';
import { nextTick, reactive, ref } from 'vue';
import type { TranscriptLine } from './useTranscription';
import { useCaptionAnnouncer } from './useCaptionAnnouncer';

let displayId = 0;
function line(text: string, extra: Partial<TranscriptLine> = {}): TranscriptLine {
  return { displayId: ++displayId, id: displayId, time: '', text, translation: '', translating: false, failed: false, ...extra };
}

it('announces finalized source and final translations only', async () => {
  const lines = reactive<TranscriptLine[]>([line('old')]);
  const on = ref(true);
  const { announcements } = useCaptionAnnouncer(() => lines, () => on.value);
  lines.push(line('hello'));
  await nextTick();
  expect(announcements.value.map((a) => a.text)).toEqual(['hello']);
  Object.assign(lines[1], { translation: 'hal', translationPartial: true, translating: true });
  await nextTick();
  expect(announcements.value).toHaveLength(1);
  Object.assign(lines[1], { translation: 'hallo', translationPartial: false, translating: false });
  await nextTick();
  expect(announcements.value.map((a) => [a.text, a.kind])).toEqual([['hello', 'source'], ['hallo', 'translation']]);
});

it('stays silent while off and does not replay history when turned on', async () => {
  const lines = reactive<TranscriptLine[]>([]);
  const on = ref(false);
  const { announcements } = useCaptionAnnouncer(() => lines, () => on.value);
  lines.push(line('a'));
  await nextTick();
  on.value = true;
  await nextTick();
  expect(announcements.value).toEqual([]);
  lines.push(line('b'));
  await nextTick();
  expect(announcements.value.map((a) => a.text)).toEqual(['b']);
});

it('skips bulk inserts such as undo or recovery', async () => {
  const lines = reactive<TranscriptLine[]>([]);
  const { announcements } = useCaptionAnnouncer(() => lines, () => true);
  lines.push(line('1'), line('2'), line('3'), line('4'));
  await nextTick();
  expect(announcements.value).toEqual([]);
});
