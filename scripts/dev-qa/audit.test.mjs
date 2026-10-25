import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditTrace } from './audit.mjs';

function fixture(change = {}) {
  const raw = [
    ['session.start', {}],
    ['asr.raw-result', { text: '挨拶が出来る。', warmup: false }],
    ['asr.asr-fragment', { segment: { text: '挨拶が' } }],
    ['asr.asr-fragment', { segment: { text: '出来る。' } }],
    ['asr.sentence', { segment: { text: '挨拶が出来る。' } }],
    ['main.pipeline:segment', { id: 2, text: '挨拶が出来る。' }],
    ['renderer.ui:segment', { id: 2, text: '挨拶が出来る。' }],
    ['main.pipeline:status', { state: 'stopped' }],
  ];
  return [{ type: 'events', data: { events: raw.map(([stage, payload], i) => ({ seq: i + 1, session: 's', stage, payload })), dropped: false, ...change } }];
}
test('compares concatenated fragments across changed sentence boundaries without calling them duplicate', () => {
  const result = auditTrace(fixture(), '挨拶');
  assert.equal(result.sessions[0].fragmentToAssemblyTextEqual, true);
  assert.equal(result.sessions[0].mainToUiTextEqual, true);
  assert.equal(result.sessions[0].rawDecodes, 1);
  assert.ok(result.sessions[0].occurrences.some(e => e.stage === 'asr.raw-result'));
});
test('detects lost text between assembler and UI and repeated UI IDs', () => {
  const records = fixture();
  records[0].data.events[6].payload.text = '出来る。';
  records[0].data.events.push({ seq: 9, session: 's', stage: 'renderer.ui:segment', payload: { id: 2, text: '出来る。' } });
  const result = auditTrace(records).sessions[0];
  assert.equal(result.mainToUiTextEqual, false);
  assert.equal(result.missingOrChanged.length, 1);
  assert.deepEqual(result.duplicateUiIds, [2]);
});
test('cursor loss and unfinished recording cannot be reported as a completeness pass', () => {
  assert.equal(auditTrace(fixture({ dropped: true })).sessions[0].mainToUiTextEqual, null);
  const records = fixture(); records[0].data.events.pop();
  assert.equal(auditTrace(records).sessions[0].fragmentToAssemblyTextEqual, null);
  const truncated = fixture(); truncated[0].data.events[6].payload.truncated = true;
  assert.equal(auditTrace(truncated).sessions[0].mainToUiTextEqual, null);
});
