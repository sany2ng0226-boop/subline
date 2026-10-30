import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { AppBridge, ArchiveRecord } from '@rt/core';
import { i18n } from '../i18n';
import { setBridge } from '../bridge';
import ArchivePlayback from './ArchivePlayback.vue';

const getArchiveAudioUrl = vi.fn(async () => 'subline-audio://archive/a');
const base: ArchiveRecord = { id: 'archive', name: 'lesson', createdAt: 0,
  lines: [{ time: '10:00:02', text: 'original transcript', translation: 'translation' }] };
const render = (record: ArchiveRecord) => renderToString(createSSRApp(ArchivePlayback, { record }).use(i18n));

beforeEach(() => {
  i18n.global.locale.value = 'zh';
  getArchiveAudioUrl.mockClear();
  setBridge({ getArchiveAudioUrl } as unknown as AppBridge);
});

describe('archive playback details', () => {
  it('clearly describes a legacy archive without claiming audio is recoverable', async () => {
    const html = await render(base);
    expect(html).toContain('此归档未保存原音。');
    expect(html).toContain('original transcript');
    expect(html).not.toContain('<audio');
    expect(html).not.toContain('line-seek');
    expect(getArchiveAudioUrl).not.toHaveBeenCalled();
  });
  it('labels interrupted recordings individually in a multi-recording archive', async () => {
    const attachment = { source: 'mic' as const, format: 'wav' as const, sampleRate: 16000,
      channels: 1, startedAt: 0, durationMs: 10000, bytes: 320044 };
    const html = await render({ ...base, audio: [
      { ...attachment, id: 'first', incomplete: true }, { ...attachment, id: 'second' },
    ] });
    expect(html.match(/录音或保存曾中断，此段原音可能不完整。/g)).toHaveLength(1);
    expect(getArchiveAudioUrl).toHaveBeenCalledWith('archive', 'first');
    expect(getArchiveAudioUrl).toHaveBeenCalledWith('archive', 'second');
    expect(html).toContain('录音 1');
    expect(html).toContain('录音 2');
  });

  it('offers exact-offset replay while never autoplaying or preloading audio content', async () => {
    const html = await render({ ...base, audio: [{ id: 'a', source: 'mic', format: 'wav', sampleRate: 16000,
      channels: 1, startedAt: 0, durationMs: 10000, bytes: 320044 }],
      lines: [{ ...base.lines[0], audio: { recordingId: 'a', start: 2, duration: 1 } }] });
    expect(html).toContain('line-seek');
    expect(html).not.toContain('autoplay');
    expect(html).not.toContain('preload="auto"');
    expect(getArchiveAudioUrl).toHaveBeenCalledWith('archive', 'a');
  });

  it('shows recordings an hour or longer as h:mm:ss', async () => {
    const attachment = { source: 'system' as const, format: 'wav' as const, sampleRate: 16000, channels: 1, startedAt: 0, bytes: 0 };
    const html = await render({ ...base, audio: [
      { ...attachment, id: 'long', durationMs: (4 * 3600 + 31 * 60 + 26) * 1000 },
      { ...attachment, id: 'short', durationMs: (9 * 60 + 5) * 1000 },
    ] });
    expect(html).toContain('4:31:26');
    expect(html).not.toContain('271:26');
    expect(html).toContain('9:05');
  });
});
