// 归档详情的纯逻辑：录后转写可选项（仅已下载的本机模型）、默认值、行与原音的对应。
// 组件只负责展示；这里不碰 bridge，便于离线测试。
import {
  asrModelsFor,
  getTranslationModel,
  translationModelsFor,
  type AppBridge,
  type AppSettings,
  type ArchiveLine,
  type ArchiveProofreadOptions,
  type ArchiveRecord,
  type ArchiveRefineOptions,
  type ArchiveRevision,
  type CodexStatus,
  type AsrLang,
  type AsrModelSpec,
  type LocalEngine,
  type LocalModelSpec,
  type ModelInfo,
  type Platform,
  type UiLang,
} from '@rt/core';

export interface RefineHost {
  platform: Platform;
  /** false=本端不支持本地翻译（如 iOS Web），只能转写不翻译。 */
  localTranslationAvailable?: boolean;
}

function ready(models: ModelInfo[], kind: ModelInfo['kind'], id: string): boolean {
  return models.some((m) => m.kind === kind && m.id === id && m.downloaded);
}

/** 本平台支持该识别语言、且已下载的识别模型；从不建议下载。 */
export function readyAsrModels(host: RefineHost, models: ModelInfo[], language: AsrLang): AsrModelSpec[] {
  return asrModelsFor(language, host.platform).filter((m) => ready(models, 'asr', m.id));
}

/** 本平台可用、支持目标语言、且已下载的本地翻译模型；云端永不出现在这里。 */
export function readyTranslationModels(host: RefineHost, models: ModelInfo[], target: UiLang): LocalModelSpec[] {
  if (host.localTranslationAvailable === false) return [];
  return translationModelsFor(host.platform).filter((m) => m.langs[target] && ready(models, 'translation', m.id));
}

/** 选中的识别模型不再适用时回落到第一个可用的；没有可用的返回空串。 */
export function pickAsrModel(host: RefineHost, models: ModelInfo[], language: AsrLang, preferred: string): string {
  const list = readyAsrModels(host, models, language);
  return (list.find((m) => m.id === preferred) ?? list[0])?.id ?? '';
}

/** 选中的翻译模型不再适用时改为不翻译（不偷偷换成别的模型）。 */
export function pickTranslationModel(
  host: RefineHost, models: ModelInfo[], target: UiLang, preferred: LocalEngine | undefined,
): LocalEngine | undefined {
  if (!preferred) return undefined;
  return readyTranslationModels(host, models, target).some((m) => m.id === preferred) ? preferred : undefined;
}

/**
 * 默认值：识别语言/模型取设置；设置里的模型未下载则用第一个已下载的兼容模型。
 * 目标语言取翻译设置（旧设置回退界面语言）；翻译开着且当前本地模型已下载才默认翻译，否则不翻译。
 */
export function defaultRefineOptions(settings: AppSettings, host: RefineHost, models: ModelInfo[]): ArchiveRefineOptions {
  const language = settings.asr.language;
  const targetLang = settings.translation.targetLang ?? settings.nativeLang;
  const engine = settings.translation.enabled && settings.translation.engine !== 'cloud'
    ? settings.translation.engine : undefined;
  const options: ArchiveRefineOptions = {
    asrModel: pickAsrModel(host, models, language, settings.asr.model),
    language,
    targetLang,
  };
  const translationModel = pickTranslationModel(host, models, targetLang, engine);
  if (translationModel) options.translationModel = translationModel;
  return options;
}

/** 只提交已下载、彼此兼容的组合；不完整返回 null。 */
export function validRefineOptions(options: ArchiveRefineOptions, host: RefineHost, models: ModelInfo[]): ArchiveRefineOptions | null {
  if (!readyAsrModels(host, models, options.language).some((m) => m.id === options.asrModel)) return null;
  const out: ArchiveRefineOptions = { asrModel: options.asrModel, language: options.language, targetLang: options.targetLang };
  if (options.translationModel) {
    if (!getTranslationModel(options.translationModel)) return null;
    if (pickTranslationModel(host, models, options.targetLang, options.translationModel) !== options.translationModel) return null;
    out.translationModel = options.translationModel;
  }
  return out;
}

/** 录后转写需要宿主能力和至少一段原音。 */
export function canRefine(record: Pick<ArchiveRecord, 'audio'>, hostSupports: boolean): 'yes' | 'no-audio' | 'unsupported' {
  if (!hostSupports) return 'unsupported';
  return record.audio?.length ? 'yes' : 'no-audio';
}

/** 行能否跳转：必须带有指向本归档某段原音的精确偏移，不根据时间文字推算。 */
export function lineSeek(line: ArchiveLine, record: Pick<ArchiveRecord, 'audio'>): { recordingId: string; start: number } | null {
  const audio = line.audio;
  if (!audio || !Number.isFinite(audio.start) || audio.start < 0) return null;
  if (!record.audio?.some((a) => a.id === audio.recordingId)) return null;
  return { recordingId: audio.recordingId, start: audio.start };
}

/** 播放位置落在哪一行（同一段录音内，start ≤ t < start+duration）；没有返回 -1。 */
export function activeLineIndex(lines: ArchiveLine[], recordingId: string, time: number): number {
  return lines.findIndex((line) => {
    const a = line.audio;
    if (!a || a.recordingId !== recordingId || !Number.isFinite(a.start)) return false;
    const end = a.start + (Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0);
    return time >= a.start && time < end;
  });
}

// —— Codex 校对（仅 Dev 宿主提供）——
// 只发送字幕文字、不重听音频；结果另存为版本，行的 audio/time/lang 由宿主原样保留。

/** 版本参数是 Codex 校对还是本地重新转写（旧的本地参数没有 kind）。 */
export function isProofreadOptions(o: ArchiveRefineOptions | ArchiveProofreadOptions): o is ArchiveProofreadOptions {
  return 'kind' in o && o.kind === 'codex';
}

/** 宿主同时提供校对与状态检查才显示入口；非 Dev 宿主两者都没有。 */
export function canProofread(host: Pick<AppBridge, 'proofreadArchive' | 'getCodexStatus'>): boolean {
  return !!host.proofreadArchive && !!host.getCodexStatus;
}

/** 校对当前选中的版本：实时原文省略 sourceRevisionId。 */
export function proofreadOptions(version: string, targetLang: UiLang): ArchiveProofreadOptions {
  return version === 'live' ? { kind: 'codex', targetLang } : { kind: 'codex', targetLang, sourceRevisionId: version };
}

/** 本机 Codex 是否可用；不可用时给出可操作的原因，绝不改走 API Key 或本地模型。 */
export function codexIssue(status: CodexStatus): 'missing' | 'login' | null {
  if (!status.available) return 'missing';
  if (!status.authenticated) return 'login';
  return null;
}

/** 版本在列表里的序号：本地重新转写与 Codex 校对各自从 1 计数。 */
export function revisionOrdinal(revisions: ArchiveRevision[], id: string): { kind: 'local' | 'codex'; n: number } | null {
  const target = revisions.find((r) => r.id === id);
  if (!target) return null;
  const kind = isProofreadOptions(target.options) ? 'codex' : 'local';
  const same = revisions.filter((r) => (isProofreadOptions(r.options) ? 'codex' : 'local') === kind);
  return { kind, n: same.indexOf(target) + 1 };
}

export type RevisionSummary =
  | { kind: 'local'; asrModel: string; language: AsrLang; translationModel?: LocalEngine; targetLang: UiLang }
  /** source：'live' 为实时原文、'unknown' 为找不到的来源，否则为来源版本 id。 */
  | { kind: 'codex'; model?: string; targetLang: UiLang; source: string; needsReview: number };

/** 版本的来源说明（两种参数格式都兼容）。 */
export function describeRevision(revision: ArchiveRevision, revisions: ArchiveRevision[]): RevisionSummary {
  const o = revision.options;
  if (!isProofreadOptions(o)) {
    const out: RevisionSummary = { kind: 'local', asrModel: o.asrModel, language: o.language, targetLang: o.targetLang };
    if (o.translationModel) out.translationModel = o.translationModel;
    return out;
  }
  const id = o.sourceRevisionId;
  const source = id === undefined ? 'live' : revisions.some((r) => r.id === id) ? id : 'unknown';
  return {
    kind: 'codex',
    model: revision.codex?.model || undefined,
    targetLang: o.targetLang,
    source,
    needsReview: revision.lines.filter((line) => line.review?.needsReview).length,
  };
}

/** 秒 → m:ss / h:mm:ss，用于没有本地时间的行。 */
export function formatOffset(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
