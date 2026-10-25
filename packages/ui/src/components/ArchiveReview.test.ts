import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { AppBridge, ArchiveRecord } from '@rt/core';
import { setBridge } from '../bridge';
import { i18n } from '../i18n';
import ArchiveReview from './ArchiveReview.vue';

vi.mock('../composables/useSettings', async () => {
  const { ref } = await import('vue');
  const { makeDefaults } = await import('@rt/core');
  return { settings: ref(makeDefaults([])) };
});
// NSelect mounts its popup styles on document; render it as an inert value holder under SSR.
// Dialogs can't be opened under SSR, so tests that inspect dialog copy render their content inline.
const view = vi.hoisted(() => ({ dialogs: false }));
vi.mock('naive-ui', async (importOriginal) => {
  const { defineComponent, h } = await import('vue');
  return {
    ...(await importOriginal<typeof import('naive-ui')>()),
    NSelect: defineComponent({ props: { value: String }, setup: (p) => () => h('span', { 'data-select': p.value }) }),
    NModal: defineComponent({ props: { title: String }, setup: (p, { slots }) => () =>
      view.dialogs ? h('div', { role: 'dialog', 'aria-label': p.title }, [slots.default?.(), slots.footer?.()]) : null }),
    NFormItem: defineComponent({ props: { label: String }, setup: (p, { slots }) => () => h('label', [p.label, slots.default?.()]) }),
  };
});
vi.mock('../composables/useModels', async () => {
  const { ref } = await import('vue');
  return { useModels: () => ({ models: ref([]), error: ref(''), refreshModels: async () => undefined }) };
});

const audio = [{ id: 'rec-1', source: 'mic', format: 'wav', sampleRate: 16000, channels: 1, startedAt: 0, durationMs: 5000 }] as ArchiveRecord['audio'];
function record(patch: Partial<ArchiveRecord> = {}): ArchiveRecord {
  return {
    id: 'arc', name: 'Lecture', createdAt: 0,
    lines: [
      { text: 'mapped', translation: '', audio: { recordingId: 'rec-1', start: 5, duration: 2 } },
      { text: 'clock only', translation: '', time: '10:00:00' },
      { text: 'stale link', translation: '', audio: { recordingId: 'missing', start: 1, duration: 1 } },
    ],
    ...patch,
  } as ArchiveRecord;
}
function render(r: ArchiveRecord) {
  return renderToString(createSSRApp(ArchiveReview, { record: r }).use(i18n));
}

beforeEach(() => { i18n.global.locale.value = 'en'; view.dialogs = false; });

describe('codex proofreading entry', () => {
  const devHost = () => ({ platform: 'macos', proofreadArchive: vi.fn(), getCodexStatus: vi.fn(), cancelArchiveRefinement: vi.fn() });

  it('is absent on non-Dev hosts, even with local re-transcription', async () => {
    setBridge({ platform: 'macos', refineArchive: vi.fn() } as unknown as AppBridge);
    view.dialogs = true;
    const html = await render(record({ audio }));
    expect(html).toContain('Re-transcribe');
    expect(html).not.toContain('Codex proofread');
    expect(html).not.toContain('OpenAI');
  });

  it('works for text-only archives without pretending lines can seek', async () => {
    setBridge(devHost() as unknown as AppBridge);
    const html = await render(record({ lines: [{ text: 'old line', translation: '', time: '09:00:00' }] }));
    expect(html).toContain('Codex proofread');
    expect(html).not.toContain('>Re-transcribe<');
    expect(html).not.toContain('line-seek');
  });

  it('states what is sent, quota use and limits before sending, with the source version named', async () => {
    setBridge(devHost() as unknown as AppBridge);
    view.dialogs = true;
    const html = await render(record({ audio }));
    expect(html).toContain('Source: Live transcript');
    expect(html).toContain('Caption text is sent to OpenAI. Audio is not uploaded.');
    expect(html).toContain('Uses your own Codex subscription quota. No API key needed.');
    expect(html).toContain('Codex doesn’t listen to the recording.');
    expect(html).toContain('The live transcript and existing versions stay unchanged.');
    expect(html).not.toMatch(/accura/i);
    // Sending stays disabled until the local Codex check succeeds.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Send and proofread/s);
  });

  it('shows progress of a running proofread and blocks starting another task', async () => {
    setBridge({ ...devHost(), refineArchive: vi.fn(),
      onArchiveRefineProgress: (cb: (p: unknown) => void) => { cb({ archiveId: 'arc', state: 'proofreading', completed: 2, total: 8 }); return () => {}; },
    } as unknown as AppBridge);
    const html = await render(record({ audio }));
    expect(html).toContain('Codex is proofreading · 25%');
    expect(html.match(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*(Re-transcribe|Codex proofread)</gs)).toHaveLength(2);
  });

  it('explains that retrying an observed Codex failure sends text again only when the request is known', async () => {
    setBridge({ ...devHost(),
      onArchiveRefineProgress: (cb: (p: unknown) => void) => {
        cb({ archiveId: 'arc', state: 'proofreading', completed: 0, total: 1 });
        cb({ archiveId: 'arc', state: 'error', completed: 0, total: 1, error: 'Codex usage limit reached' });
        return () => {};
      },
    } as unknown as AppBridge);
    const html = await render(record({ audio }));
    expect(html).toContain('Codex proofreading didn’t finish. Nothing was changed.');
    expect(html).toContain('Codex usage limit reached');
    // This page didn't start the run, so it can't resend it.
    expect(html).not.toContain('Send again');
  });
});

describe('archive review', () => {
  it('makes only precisely mapped lines seekable and keeps clock-only lines static', async () => {
    setBridge({ platform: 'macos', refineArchive: vi.fn(), getArchiveAudioUrl: vi.fn(() => new Promise(() => {})) } as unknown as AppBridge);
    const html = await render(record({ audio }));
    expect(html.match(/class="timeline-time line-seek"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Play from 0:05"');
    expect(html).toMatch(/<time class="timeline-time"[^>]*>10:00:00<\/time>/);
    expect(html).toContain('Re-transcribe');
    expect(html).toContain('Microphone');
    expect(html).toContain('The live transcript was saved while recording and is always kept.');
  });

  it('keeps legacy archives readable and explains that refinement needs saved audio', async () => {
    setBridge({ platform: 'macos', refineArchive: vi.fn() } as unknown as AppBridge);
    const html = await render(record({ lines: [{ text: 'old line', translation: 'traduction' }] }));
    expect(html).toContain('old line');
    expect(html).toContain('No original audio was saved for this archive.');
    expect(html).toContain('No original audio was saved, so this archive can’t be re-transcribed.');
    expect(html).not.toContain('line-seek');
    expect(html).not.toContain('>Re-transcribe<');
  });

  it('shows recognition progress as a percentage, never raw audio milliseconds', async () => {
    setBridge({
      platform: 'macos', refineArchive: vi.fn(), cancelArchiveRefinement: vi.fn(),
      onArchiveRefineProgress: (cb: (p: unknown) => void) => { cb({ archiveId: 'arc', state: 'transcribing', completed: 90000, total: 180000 }); return () => {}; },
    } as unknown as AppBridge);
    const html = await render(record({ audio }));
    expect(html).toContain('Recognizing · 50%');
    expect(html).not.toContain('90000');
    expect(html).not.toContain('180000');
  });

  it('hides the refinement entry on hosts without the capability', async () => {
    setBridge({ platform: 'web' } as unknown as AppBridge);
    const html = await render(record({ audio }));
    expect(html).not.toContain('Re-transcribe');
    expect(html).not.toContain('review-bar');
    expect(html).toContain('mapped');
  });

  it('still lets hosts without refinement switch between saved versions, starting on the live transcript', async () => {
    setBridge({ platform: 'web' } as unknown as AppBridge);
    const revisions = [{ id: 'r1', createdAt: 0, options: { asrModel: 'sense-voice', language: 'auto', targetLang: 'en' }, lines: [{ text: 'refined', translation: '' }] }];
    const html = await render(record({ audio, revisions } as Partial<ArchiveRecord>));
    expect(html).toContain('data-select="live"');
    expect(html).toContain('mapped');
    expect(html).not.toContain('refined');
    expect(html).not.toContain('Re-transcribe');
  });
});
