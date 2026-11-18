#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const profiles = new Map([
  ['stable', 'Classroom Translator'],
  ['internal', 'Classroom Translator Internal'],
]);
const recordingName = /^audio-(\d{13})-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(-mic)?\.wav$/;
const usage = `Usage: node apps/macos/scripts/subline.mjs [--profile stable|internal] <command>

  status                     Report whether Subline has an open audio capture
  transcript [--minutes 10]  Read finalized lines from the current capture
  archives [--limit 20]      List recent archive IDs and names
  archive <id>               Read one archive's finalized lines

Commands return JSON on stdout. Use --data-dir /absolute/profile for a custom profile.
`;

function readJson(directory, name, fallback) {
  let raw;
  try {
    raw = readFileSync(path.join(directory, name), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${name}. The file was left intact.`);
  }
}

function profileDirectory(options) {
  if (!profiles.has(options.profile)) throw new Error('Choose --profile stable or internal.');
  if (options['data-dir'] !== undefined) {
    if (!path.isAbsolute(options['data-dir'])) throw new Error('--data-dir must be an absolute path.');
    return options['data-dir'];
  }
  return path.join(homedir(), 'Library', 'Application Support', profiles.get(options.profile));
}

function boundedInteger(value, fallback, flag, max) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new Error(`--${flag} must be an integer from 1 to ${max}.`);
  }
  return number;
}

function recordingFromOpenFiles(output, directory) {
  let writable = false;
  let regular = false;
  const recordings = new Map();
  for (const field of output.split('\0')) {
    const entry = field.trimStart();
    const tag = entry[0];
    const content = entry.slice(1);
    if (tag === 'f') {
      writable = false;
      regular = false;
    }
    if (tag === 'a') writable = content === 'w' || content === 'u';
    if (tag === 't') regular = content === 'REG';
    if (tag !== 'n' || !writable || !regular || path.dirname(content) !== directory) continue;
    const name = path.basename(content);
    const match = recordingName.exec(name);
    if (match) recordings.set(name, {
      id: name.slice(0, -4),
      startedAt: Number(match[1]),
      source: match[2] ? 'mic' : 'system',
    });
  }
  if (recordings.size > 1) throw new Error('More than one Subline audio capture is open for this profile.');
  return recordings.values().next().value ?? null;
}

function openRecording(directory) {
  let recordingsDirectory;
  try {
    recordingsDirectory = realpathSync(path.join(directory, 'recordings'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let result;
  try {
    // A stale recovery draft or incomplete WAV can outlive its process. Only an
    // open writable handle held by Subline identifies a current capture.
    result = execFileSync('/usr/sbin/lsof', [
      '-nP', '-a', '-u', String(process.getuid()), '+c', '0',
      '-c', '/^(Subline|Realtime Translator)( Internal| Dev)?$/',
      '+d', recordingsDirectory, '-F0fatn',
    ], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // macOS lsof returns 1 for unmatched directory entries even when it
    // successfully reports the open files in that directory.
    if (error.status !== 1 || error.stderr?.trim()) {
      throw new Error('Could not determine the current audio capture.');
    }
    result = error.stdout;
  }
  return recordingFromOpenFiles(result, recordingsDirectory);
}

function readSnapshot(directory) {
  const snapshot = readJson(directory, 'recovery.json', null);
  if (snapshot === null) return null;
  if (snapshot.version !== 1 || !Number.isFinite(snapshot.savedAt) || !Array.isArray(snapshot.lines)) {
    throw new Error('Unsupported Subline recovery snapshot.');
  }
  return snapshot;
}

function transcriptLine(line) {
  return {
    ...(typeof line.time === 'string' && line.time ? { time: line.time } : {}),
    ...(typeof line.lang === 'string' ? { lang: line.lang } : {}),
    text: line.text,
    translation: typeof line.translation === 'string' ? line.translation : '',
  };
}

function isTranscriptLine(line) {
  return line && typeof line.text === 'string';
}

function readTranscript(directory, minutes) {
  const recording = openRecording(directory);
  const observedAt = Date.now();
  if (!recording) {
    return { recording: null, observedAt, snapshotSavedAt: null, lines: [] };
  }
  const snapshot = readSnapshot(directory);
  const current = Array.isArray(snapshot?.audioIds) && snapshot.audioIds.includes(recording.id) ? snapshot : null;
  const earliestOffset = (observedAt - minutes * 60_000 - recording.startedAt) / 1000;
  const lines = current?.lines
    .filter((line) => isTranscriptLine(line) && line.audio?.recordingId === recording.id
      && Number.isFinite(line.audio.start) && line.audio.start >= earliestOffset)
    .map(transcriptLine) ?? [];
  return { recording, observedAt, snapshotSavedAt: current?.savedAt ?? null, lines };
}

function readArchives(directory) {
  const records = readJson(directory, 'archives.json', []);
  if (!Array.isArray(records) || records.some((item) => !item || typeof item.id !== 'string'
    || !Number.isFinite(item.createdAt) || !Array.isArray(item.lines))) {
    throw new Error('Unsupported Subline archive data.');
  }
  const library = readJson(directory, 'archive-library.json', null);
  return records.map((record) => ({
    ...record,
    name: library?.version === 1 && typeof library.records?.[record.id]?.name === 'string'
      ? library.records[record.id].name
      : record.name,
  }));
}

function archiveSummary(record) {
  return { id: record.id, name: record.name, createdAt: record.createdAt, lineCount: record.lines.length };
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: 'string', default: 'stable' },
      'data-dir': { type: 'string' },
      minutes: { type: 'string' },
      limit: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(usage);
    return;
  }
  const [command, id, ...extra] = positionals;
  if (!['status', 'transcript', 'archives', 'archive'].includes(command)
    || (command === 'archive') !== Boolean(id) || extra.length) {
    throw new Error('Choose status, transcript, archives, or archive <id>. See --help.');
  }
  if (values.minutes !== undefined && command !== 'transcript') throw new Error('--minutes applies to transcript.');
  if (values.limit !== undefined && command !== 'archives') throw new Error('--limit applies to archives.');
  if (process.platform !== 'darwin') throw new Error('This CLI supports Subline for macOS.');

  const directory = profileDirectory(values);
  let result;
  if (command === 'status') result = { recording: openRecording(directory) };
  if (command === 'transcript') result = readTranscript(directory, boundedInteger(values.minutes, 10, 'minutes', 1440));
  if (command === 'archives') {
    const limit = boundedInteger(values.limit, 20, 'limit', 500);
    result = { archives: readArchives(directory)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, limit)
      .map(archiveSummary) };
  }
  if (command === 'archive') {
    const record = readArchives(directory).find((item) => item.id === id);
    if (!record) throw new Error('Archive ID not found. Use archives to list IDs.');
    result = { ...archiveSummary(record), lines: record.lines.filter(isTranscriptLine).map(transcriptLine) };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`subline: ${error.message}\n`);
  process.exitCode = 1;
}
