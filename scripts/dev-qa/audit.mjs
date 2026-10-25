import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, '');
const omitted = value => !!value && typeof value === 'object'
  && (value.omitted === true || value.truncated === true || Object.values(value).some(omitted));

export function auditTrace(records, phrase = '') {
  const events = new Map();
  const gaps = [];
  const snapshots = [];
  for (const record of records) {
    if (record.type === 'events') {
      if (record.data.dropped) gaps.push({ oldestSeq: record.data.oldestSeq, capturedAt: record.capturedAt });
      for (const event of record.data.events ?? []) events.set(event.seq, event);
    }
    if (record.type === 'snapshot') snapshots.push(record.data);
  }
  const ordered = [...events.values()].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].seq !== ordered[i - 1].seq + 1) gaps.push({ after: ordered[i - 1].seq, before: ordered[i].seq });
  }
  const sessions = [...new Set(ordered.map(e => e.session).filter(Boolean))].map(session => {
    const own = ordered.filter(e => e.session === session);
    const at = stage => own.filter(e => e.stage === stage);
    const fragments = at('asr.asr-fragment');
    const assembled = at('asr.sentence');
    const sent = at('main.pipeline:segment');
    const rendered = at('renderer.ui:segment');
    const joinSegments = list => normalize(list.map(e => e.payload.segment?.text ?? e.payload.text ?? '').join(''));
    const missingOrChanged = sent.filter(e => !rendered.some(r => r.payload.id === e.payload.id && r.payload.text === e.payload.text));
    const extra = rendered.filter(e => !sent.some(s => s.payload.id === e.payload.id && s.payload.text === e.payload.text));
    const duplicateUiIds = rendered.map(e => e.payload.id).filter((id, i, ids) => ids.indexOf(id) !== i);
    const stopped = at('main.pipeline:status').some(e => e.payload.state === 'stopped');
    const payloadLoss = own.some(e => omitted(e.payload));
    const complete = gaps.length === 0 && !payloadLoss && at('session.start').length === 1 && stopped;
    const countText = (list, text) => {
      const needle = normalize(text);
      return needle ? joinSegments(list).split(needle).length - 1 : 0;
    };
    const checkpoints = at('asr.stall-checkpoint').map(e => ({
      seq: e.seq, ...e.payload,
      savedTextInFragments: complete ? countText(fragments, e.payload.savedText) : null,
      savedTextInUi: complete ? countText(rendered, e.payload.savedText) : null,
    }));
    return {
      session, complete, stopped, payloadLoss, audioBlocks: at('audio.input').length,
      maxAudioRms: Math.max(0, ...at('audio.input').map(e => e.payload.rms ?? 0)),
      rawDecodes: at('asr.raw-result').filter(e => !e.payload.warmup).length,
      checkpoints, checkpointCount: checkpoints.length,
      ordinarySlides: at('asr.ordinary-slide').length, stallFallbacks: at('asr.stall-fallback').length,
      fragments: fragments.length, assembled: assembled.length, sent: sent.length, uiFinals: rendered.length,
      fragmentToAssemblyTextEqual: complete && fragments.length > 0 && assembled.length > 0 ? joinSegments(fragments) === joinSegments(assembled) : null,
      mainToUiTextEqual: complete && sent.length > 0 ? missingOrChanged.length === 0 && extra.length === 0 && duplicateUiIds.length === 0 : null,
      missingOrChanged: missingOrChanged.map(e => ({ seq: e.seq, id: e.payload.id, text: e.payload.text })),
      extra: extra.map(e => ({ seq: e.seq, id: e.payload.id, text: e.payload.text })), duplicateUiIds,
      ...(phrase ? { phrase, occurrences: own.filter(e => normalize(JSON.stringify(e.payload)).includes(normalize(phrase)))
        .map(e => ({ seq: e.seq, stage: e.stage, at: e.at, payload: e.payload })) } : {}),
    };
  });
  const latest = snapshots.at(-1);
  return { eventCount: ordered.length, cursorGaps: gaps, sessions,
    latestRenderer: latest?.renderer ? { available: latest.renderer.available, stale: latest.renderer.stale, ageMs: latest.renderer.ageMs } : null,
    boundary: 'Text conservation between instrumented stages only; not an independent speech accuracy or audio completeness score.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const records = (await readFile(process.argv[2], 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    console.log(JSON.stringify(auditTrace(records, process.argv[3] ?? ''), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
