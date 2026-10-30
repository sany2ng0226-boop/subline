// iOS（Capacitor）平台桥接：实现 @rt/core 的 AppBridge，注入给 @rt/ui。
//
// 各能力来源：
//  - 设置 / 归档持久化：@capacitor/preferences（异步 KV），纯逻辑复用 @rt/core
//    （makeDefaults / withDefaults / listSummaries / makeArchiveId / toSummary）。
//  - ASR：原生 Capacitor 插件 RealtimeAsr（sherpa-onnx 端上识别 + AVAudioEngine 采集），
//    通过 'partial' / 'segment' / 'status' 事件回吐；startPipeline/stopPipeline 即启停整个会话
//    （含原生采麦），无需 JS 侧送音频。
//  - 翻译：segment 到达且开启翻译时翻成母语并触发 onTranslation，两种引擎：
//    · engine==='cloud'  → JS 侧 @rt/core CloudTranslator（WebView 内 fetch）。
//    · 否则（设备端）     → 原生插件 RealtimeTranslate（Apple Translation 框架，iOS 18+，离线）。
//      不可用（iOS<18 / 不支持语言对 / 语言包缺失）时发 translation:status error 提示改用云翻译。
//    繁體等目标脚本后处理沿用 M2M100_SPEC.toScript（两条路径一致）。
//
// 实现 vs 桩：
//  - 已实现（纯 JS，可在此环境验证类型 + 打包）：设置、归档、云翻译、事件转发、回调注册。
//  - 依赖原生插件（此环境无 iOS 工具链，未编译/未运行）：startPipeline / stopPipeline /
//    getMicStatus / openMicSettings / getSetupStatus / downloadAsrModels / listModels /
//    deleteModel。无原生壳时（如纯浏览器预览）这些调用会 reject，桥接已做兜底，不会崩 UI。

import { Preferences } from '@capacitor/preferences';
import {
  makeDefaults,
  withDefaults,
  mergeSettings,
  listSummaries,
  makeArchiveId,
  CloudTranslator,
  M2M100_SPEC,
  translateFinalizedSegment,
  createReverseTranslationContext,
  resetReverseTranslationContext,
  createCallbackHub,
  DEFAULT_ASR_MODEL_ID,
  getAsrModel,
  SentenceAssembler,
  TranslationContext,
} from '@rt/core';
import type {
  AppBridge,
  AppSettings,
  SettingsPatch,
  ArchiveLine,
  ArchiveRecord,
  ArchiveSummary,
  CloudTranslationConfig,
  StartResult,
  MicPermission,
  ModelInfo,
  ModelKind,
  SetupStatus,
  SetupProgress,
  SegmentPayload,
  PartialPayload,
  TranslationPayload,
  StatusPayload,
  TranslationStatusPayload,
} from '@rt/core';
import { RealtimeAsr, RealtimeTranslate } from '../native-plugin';
import type { NativeSegmentPayload, NativeRecordingStatus } from '../native-plugin/definitions';

const SETTINGS_KEY = 'realtime-translator.settings';
const ARCHIVES_KEY = 'realtime-translator.archives';
const RECOVERY_KEY = 'realtime-translator.recovery';

// iOS 平台收敛：不支持系统音频（音源恒为麦克风）；asr.model 若不在 iOS 支持列表内则回落默认模型
// （registry 里 platforms 不含 'ios' 的模型在本端不可用）。所有产出 settings 的路径（读/写）统一
// 经此收口，保证 getSettings 与启动/预热热路径看到的音源与模型一致。
function applyPlatformConstraints(s: AppSettings): AppSettings {
  s.audioSource = 'mic';
  if (!getAsrModel(s.asr.model)?.platforms.includes('ios')) {
    s.asr.model = DEFAULT_ASR_MODEL_ID;
  }
  return s;
}

export function createIosBridge(): AppBridge {
  // —— UI 注册的回调（mountApp → registerTranscriptionListeners 时注入） ——
  const segmentCb = createCallbackHub<SegmentPayload>();
  const partialCb = createCallbackHub<PartialPayload>();
  const translationCb = createCallbackHub<TranslationPayload>();
  const statusCb = createCallbackHub<StatusPayload>();
  const translationStatusCb = createCallbackHub<TranslationStatusPayload>();
  const setupProgressCb = createCallbackHub<SetupProgress>();

  // —— 缓存设置：翻译热路径（segment 到达）同步读开关/引擎/母语，免得每段都 await KV。
  //    翻译开关就是 cachedSettings.translation.enabled，改后即时生效并落盘，不再另存一份布尔。 ——
  let cachedSettings: AppSettings | null = null;

  // ---- 持久化：设置 ----
  async function readSettings(): Promise<AppSettings> {
    const defaults = makeDefaults(navigator.languages ? [...navigator.languages] : []);
    const { value } = await Preferences.get({ key: SETTINGS_KEY });
    let raw: unknown = null;
    if (value) {
      try {
        raw = JSON.parse(value);
      } catch {
        raw = null;
      }
    }
    cachedSettings = applyPlatformConstraints(withDefaults(raw, defaults));
    return cachedSettings;
  }

  let settingsSaveQueue: Promise<unknown> = Promise.resolve();
  function writeSettings(patch: SettingsPatch): Promise<AppSettings> {
    const queuedPatch: SettingsPatch = JSON.parse(JSON.stringify(patch));
    const operation = settingsSaveQueue.then(async () => {
      const current = await readSettingsOnce();
      const saved = applyPlatformConstraints(mergeSettings(current, queuedPatch));
      await Preferences.set({ key: SETTINGS_KEY, value: JSON.stringify(saved) });
      if (JSON.stringify([current.asr, current.nativeLang, current.translation]) !==
          JSON.stringify([saved.asr, saved.nativeLang, saved.translation])) {
        sentences.flush();
        invalidateTranslation();
        resetReverseTranslationContext(reverseCtx);
      }
      cachedSettings = saved;
      return saved;
    });
    settingsSaveQueue = operation.catch(() => undefined);
    return operation;
  }

  // Keep the initialized cache authoritative so an overlapping read cannot restore stale disk state.
  let readInFlight: Promise<AppSettings> | null = null;
  function readSettingsOnce(): Promise<AppSettings> {
    if (cachedSettings) return Promise.resolve(cachedSettings);
    if (!readInFlight) {
      readInFlight = readSettings().finally(() => {
        readInFlight = null;
      });
    }
    return readInFlight;
  }

  // ---- 持久化：归档 ----
  async function readArchives(): Promise<ArchiveRecord[]> {
    const { value } = await Preferences.get({ key: ARCHIVES_KEY });
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as ArchiveRecord[]) : [];
    } catch {
      return [];
    }
  }

  async function writeArchives(records: ArchiveRecord[]): Promise<void> {
    await Preferences.set({ key: ARCHIVES_KEY, value: JSON.stringify(records) });
  }

  // 反向翻译会话状态：识别语言为 auto 时，听到母语的段翻成上一次识别到的外语；每次开始录音清空（见 startPipeline）。
  const reverseCtx = createReverseTranslationContext();
  const translationContext = new TranslationContext();
  let translationEpoch = 0;
  let translationQueue: Promise<unknown> = Promise.resolve();
  const pendingTranslations = new Set<number>();
  const deferredTranslations: { segment: SegmentPayload; epoch: number }[] = [];
  const foregroundWaiters = new Set<() => void>();
  let nativeAppActive = true;
  const isForeground = (): boolean => nativeAppActive && (typeof document === 'undefined' || document.visibilityState !== 'hidden');

  function translateWhenVisible(segment: SegmentPayload): void {
    if (!isForeground()) { deferredTranslations.push({ segment, epoch: translationEpoch }); return; }
    void translateSegment(segment);
  }

  function translateDeferred(): void {
    if (!isForeground()) return;
    for (const item of deferredTranslations.splice(0)) {
      if (item.epoch === translationEpoch) void translateSegment(item.segment);
    }
  }

  function invalidateTranslation(): void {
    for (const id of pendingTranslations) {
      translationCb.emit({ id, text: '', failed: true, error: 'Translation configuration or recording session changed' });
    }
    pendingTranslations.clear();
    deferredTranslations.splice(0);
    translationEpoch++;
    for (const wake of foregroundWaiters) wake();
    foregroundWaiters.clear();
    translationContext.reset();
  }

  // ---- 翻译：segment 到达时按当前设置翻成母语（识别语言为 auto 时母语段反向翻成上一次的外语）。
  //      编排（是否翻 / pending / 字形归一化 / 错误上报）统一在 @rt/core.translateFinalizedSegment，
  //      三端一致；这里只注入引擎调用：设备端 Apple Translation（iOS 18+）或云端 CloudTranslator。 ----
  async function translateSegment(seg: SegmentPayload): Promise<void> {
    const epoch = translationEpoch;
    const current = cachedSettings ?? (await readSettingsOnce());
    if (epoch !== translationEpoch) return;
    const s: AppSettings = JSON.parse(JSON.stringify(current));
    await translateFinalizedSegment({
      ...(s.translation.engine !== 'cloud' ? { context: translationContext } : {}),
      spec: M2M100_SPEC,
      segment: seg,
      enabled: s.translation.enabled,
      nativeLang: s.nativeLang,
      targetLang: s.translation.targetLang ?? s.nativeLang,
      asrLanguage: s.asr.language,
      reverse: reverseCtx,
      translate: async (req) => {
        if (s.translation.engine !== 'cloud') {
          // 设备端翻译：原生框架只认模型短码；不可用/空结果按失败抛出（提示改用云翻译），
          // 繁體等字形归一化由编排层的 toScript 兜底。
          // Capture settings and source-only context before queueing; the native session is serial.
          const operation = translationQueue.then(async () => {
            if (epoch !== translationEpoch) throw new Error('Translation request invalidated');
            // A queued request may reach the native SwiftUI session after the app was hidden.
            while (!isForeground()) {
              await new Promise<void>((wake) => foregroundWaiters.add(wake));
              if (epoch !== translationEpoch) throw new Error('Translation request invalidated');
            }
            return RealtimeTranslate.translate({
              text: req.text,
              source: req.source,
              target: req.targetCode,
              context: req.context,
            });
          });
          translationQueue = operation.catch(() => undefined);
          const r = await operation;
          if (r.unavailable || !r.text) {
            throw new Error(
              `On-device translation unavailable (${r.reason ?? 'unknown'}); switch to cloud translation in settings.`,
            );
          }
          return r.text;
        }
        // 云端传母语 app 语言键（en/ja/ko/zh），让 LLM 直接产出母语文本。
        return new CloudTranslator(s.translation.cloud).translate(req.text, {
          source: req.source,
          target: req.targetLang,
        });
      },
      emitTranslation: (p) => {
        if (epoch !== translationEpoch) return;
        if (p.pending) pendingTranslations.add(p.id);
        else pendingTranslations.delete(p.id);
        translationCb.emit(p);
      },
    });
  }

  // ---- 订阅原生 ASR 插件事件，转发给 UI 注册的回调 ----
  // 纯浏览器预览（无原生壳）下 addListener 会 reject，吞掉即可，不影响 UI 挂载。
  // 行 id 由桥接层统一分配，跨录音会话单调递增：原生每次 start 都把 segmentId 归零、其 id 从 0 计数，
  // 而 UI 的行与译文回填都按 id 对应，必须全局唯一，故在此改写后再上抛。翻译编排（translateSegment
  // → translateFinalizedSegment）也用改写后的 id，保证译文/等待动画事件回填到当前会话的正确行。
  let nextLineId = 0;
  let acceptingNative = false;
  let startInFlight: Promise<StartResult> | null = null;
  let livePartial: PartialPayload = { text: '' };
  const publishPartial = (): void => {
    const stableText = sentences.text + (livePartial.stableText ?? '');
    partialCb.emit({ text: sentences.text + livePartial.text,
      ...(stableText || livePartial.stableText !== undefined ? { stableText } : {}) });
  };
  const sentences = new SentenceAssembler((segment) => {
    const line: SegmentPayload = { ...segment, id: nextLineId++ };
    markNativeRendered(segment);
    segmentCb.emit(line);
    translateWhenVisible(line);
    publishPartial();
    queueMicrotask(markRenderable);
  });
  function finishPendingSpeech(): void {
    sentences.flush();
    livePartial = { text: '' };
    publishPartial();
    acceptingNative = false;
  }
  const hasJournal = typeof RealtimeAsr.drainPendingSegments === 'function';
  let processedSequence = 0;
  let renderableSequence = 0;
  let durableSequence = 0;
  const unrenderedNative = new Map<number, NativeSegmentPayload>();
  const renderedNative = new Set<number>();
  let nativeSessionId: string | null = null;
  let nativeStatus: NativeRecordingStatus | null = null;
  let recoveryLoaded: Promise<string | null> | null = null;
  let recoveryWrites: Promise<unknown> = Promise.resolve();
  let nativeEvents: Promise<unknown> = Promise.resolve();
  let draining: Promise<void> | null = null;

  function markRenderable(): void {
    while (renderedNative.has(renderableSequence + 1)) {
      renderedNative.delete(++renderableSequence);
    }
  }

  function markNativeRendered(segment: SegmentPayload): void {
    const first = segment as NativeSegmentPayload;
    if (!Number.isSafeInteger(first.sequence)) return;
    let text = '';
    const covered: number[] = [];
    for (const [sequence, source] of unrenderedNative) {
      if (sequence < first.sequence) continue;
      if (source.sessionId !== first.sessionId) break;
      const separator = /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(source.text) ? ' ' : '';
      text += separator + source.text;
      covered.push(sequence);
      if (text === segment.text) {
        for (const sequence of covered) { renderedNative.add(sequence); unrenderedNative.delete(sequence); }
        markRenderable();
        return;
      }
      if (!segment.text.startsWith(text)) return;
    }
  }

  function readDurableRecovery(): Promise<string | null> {
    if (!recoveryLoaded) recoveryLoaded = Preferences.get({ key: RECOVERY_KEY }).then(({ value }) => {
      if (!value) return null;
      try {
        const record = JSON.parse(value);
        if (typeof record.through === 'number' && Number.isSafeInteger(record.through) && record.through >= 0) {
          durableSequence = record.through;
          processedSequence = Math.max(processedSequence, durableSequence);
          renderableSequence = Math.max(renderableSequence, durableSequence);
        }
        return typeof record.json === 'string' ? record.json : null;
      } catch { return null; }
    });
    return recoveryLoaded;
  }

  async function acknowledgeDurable(): Promise<void> {
    if (!hasJournal || !durableSequence) return;
    try { await RealtimeAsr.ackPendingSegments({ through: durableSequence }); }
    catch { /* The durable cursor suppresses replay even when this acknowledgement must be retried. */ }
  }

  function persistRecovery(json: string | null): Promise<void> {
    const through = renderableSequence;
    const write = recoveryWrites.then(async () => {
      await readDurableRecovery();
      const savedThrough = Math.max(durableSequence, through);
      await Preferences.set({ key: RECOVERY_KEY, value: JSON.stringify({ json, through: savedThrough }) });
      durableSequence = savedThrough;
      recoveryLoaded = Promise.resolve(json);
      await acknowledgeDurable();
    });
    recoveryWrites = write.catch(() => undefined);
    return write;
  }

  function adoptNativeSession(sessionId: string, startedAt?: number): void {
    if (nativeSessionId !== sessionId) {
      sentences.flush();
      livePartial = { text: '' };
      invalidateTranslation();
      resetReverseTranslationContext(reverseCtx);
      nativeSessionId = sessionId;
    }
    if (nativeStatus?.state === 'running' && Number.isFinite(startedAt) && startedAt! > 0) {
      statusCb.emit({ state: 'running', sessionId, startedAt, resumed: true } as StatusPayload);
    }
  }

  function consumeJournalSegment(segment: NativeSegmentPayload): void {
    if (!Number.isSafeInteger(segment.sequence) || segment.sequence <= processedSequence) return;
    adoptNativeSession(segment.sessionId, segment.startedAt);
    processedSequence = segment.sequence;
    unrenderedNative.set(segment.sequence, segment);
    livePartial = { text: '' };
    sentences.push(segment);
    markRenderable();
    publishPartial();
  }

  function enqueueNative(operation: () => void | Promise<void>): Promise<void> {
    const next = nativeEvents.then(async () => { await readDurableRecovery(); await operation(); });
    nativeEvents = next.catch(() => undefined);
    return next;
  }

  function reportNativeStatus(status: NativeRecordingStatus | StatusPayload): void {
    if ('sessionId' in status) nativeStatus = status;
    if (status.state === 'stopped' || status.state === 'error') {
      finishPendingSpeech();
      markRenderable();
    } else if (status.state === 'running') acceptingNative = true;
    statusCb.emit('sessionId' in status ? { ...status, resumed: true } as StatusPayload : status);
  }

  async function consumeSnapshot(snapshot: Awaited<ReturnType<typeof RealtimeAsr.drainPendingSegments>>): Promise<void> {
    nativeStatus = snapshot.status;
    if (snapshot.status.sessionId) adoptNativeSession(snapshot.status.sessionId, snapshot.status.startedAt);
    for (const segment of [...snapshot.segments].sort((a, b) => a.sequence - b.sequence)) consumeJournalSegment(segment);
    if (snapshot.status.sessionId) adoptNativeSession(snapshot.status.sessionId, snapshot.status.startedAt);
    reportNativeStatus(snapshot.journalError
      ? { ...snapshot.status, state: 'error', error: snapshot.journalError, code: 'asr-crashed' }
      : snapshot.status);
    await acknowledgeDurable();
    translateDeferred();
  }

  function drainNative(): Promise<void> {
    if (!hasJournal) return Promise.resolve();
    if (draining) return draining;
    const operation = enqueueNative(async () => { await consumeSnapshot(await RealtimeAsr.drainPendingSegments()); });
    draining = operation.finally(() => { draining = null; });
    return draining;
  }

  function resumeNative(): void {
    if (!isForeground()) return;
    for (const wake of foregroundWaiters) wake();
    foregroundWaiters.clear();
    void drainNative().catch(() => undefined);
  }

  function subscribeNative(): void {
    void RealtimeAsr.addListener('partial', (p) => {
      const consume = () => {
        if (!acceptingNative) return;
        livePartial = p;
        if (p.text) sentences.touch();
        publishPartial();
      };
      if (hasJournal) void enqueueNative(consume).catch(() => undefined);
      else consume();
    }).catch(() => undefined);
    void RealtimeAsr.addListener('segment', (segment) => {
      if (hasJournal && Number.isSafeInteger(segment.sequence)) {
        void enqueueNative(async () => {
          // A new live event can overtake finals that were journaled while JS was suspended.
          if (segment.sequence > processedSequence + 1) await consumeSnapshot(await RealtimeAsr.drainPendingSegments());
          consumeJournalSegment(segment);
        }).catch(() => undefined);
      } else {
        if (!acceptingNative) return;
        livePartial = { text: '' };
        sentences.push(segment);
        publishPartial();
      }
    }).catch(() => undefined);
    void RealtimeAsr.addListener('status', (status) => {
      if (hasJournal && (status.state === 'stopped' || status.state === 'error')) {
        void drainNative().catch(() => reportNativeStatus(status));
      } else if (hasJournal) void enqueueNative(() => reportNativeStatus(status)).catch(() => undefined);
      else reportNativeStatus(status);
    }).catch(() => undefined);
    void RealtimeAsr.addListener('setupProgress', (p) => setupProgressCb.emit(p)).catch(() => undefined);
    if (hasJournal) {
      void RealtimeAsr.addListener('appActive', ({ active }) => {
        nativeAppActive = active;
        if (active) resumeNative();
      }).catch(() => undefined);
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resumeNative);
      if (typeof window !== 'undefined') window.addEventListener('pageshow', resumeNative);
    }
  }
  subscribeNative();

  // ---- MicPermission 归一化（原生返回的字符串 → @rt/core 联合类型） ----
  function asMicPermission(v: string): MicPermission {
    return v === 'granted' ||
      v === 'denied' ||
      v === 'restricted' ||
      v === 'not-determined'
      ? v
      : 'unknown';
  }

  // 取当前 ASR 设置（模型 + 识别语言），供启动/预热透传给原生。缓存未就绪时读盘一次。
  async function currentAsrOptions(): Promise<{ modelId: string; language: string }> {
    const s = cachedSettings ?? (await readSettingsOnce());
    return { modelId: s.asr.model, language: s.asr.language };
  }

  const api: AppBridge = {
    // iOS 平台标识：UI 据此按平台过滤可用模型、决定音源开关等。
    platform: 'ios',
    // 不声明 audioSources → UI 视为仅 ['mic']（iOS 不支持系统音频），不渲染音源开关。
    // 构建期注入的发布版本串；define 缺失的环境（如单测导入）下不暴露
    appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined,

    // ===== ASR 管线（原生）=====
    async startPipeline(): Promise<StartResult> {
      if (startInFlight) return startInFlight;
      await drainNative();
      if (startInFlight) return startInFlight;
      if (acceptingNative) return { ok: true };
      // A repeated start must not erase an open utterance; a new session begins only after stop.
      sentences.flush();
      livePartial = { text: '' };
      invalidateTranslation();
      resetReverseTranslationContext(reverseCtx);
      nativeSessionId = null;
      acceptingNative = true;
      const operation = (async (): Promise<StartResult> => {
        try {
          await settingsSaveQueue;
          await nativeEvents;
          const r = await RealtimeAsr.start(await currentAsrOptions());
          if (!r.ok) finishPendingSpeech();
          return { ok: r.ok, error: r.error };
        } catch (e) {
          finishPendingSpeech();
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })();
      startInFlight = operation;
      try { return await operation; }
      finally { if (startInFlight === operation) startInFlight = null; }
    },
    prewarmPipeline(): void {
      // 进主界面即后台装载当前 ASR 模型（不采麦、不申请权限）：fire-and-forget。
      // UI 在调用前先行禁用录音按钮、等终态 status 解禁；原生侧保证一切路径以终态收尾，
      // 调用本身 reject（纯浏览器预览无原生壳）时由这里补发 stopped，避免按钮永久禁用。
      void drainNative().then(async () => {
        if (!acceptingNative) await RealtimeAsr.prewarm(await currentAsrOptions());
      })
        .catch(() => statusCb.emit({ state: 'stopped' }));
    },
    async stopPipeline(): Promise<{ ok: boolean }> {
      try {
        const result = await RealtimeAsr.stop();
        await nativeEvents;
        await drainNative();
        if (result.ok) { finishPendingSpeech(); markRenderable(); }
        return result;
      } catch {
        return { ok: false };
      }
    },
    // ===== 麦克风权限（原生）=====
    async getMicStatus(): Promise<MicPermission> {
      try {
        const r = await RealtimeAsr.getMicStatus();
        return asMicPermission(r.status);
      } catch {
        return 'unknown';
      }
    },
    openMicSettings(): void {
      void RealtimeAsr.openMicSettings().catch(() => undefined);
    },

    async saveRecovery(json: string): Promise<void> { await persistRecovery(json); },
    async loadRecovery(): Promise<string | null> {
      await recoveryWrites;
      const json = await readDurableRecovery();
      queueMicrotask(resumeNative);
      return json;
    },
    async clearRecovery(): Promise<void> { await persistRecovery(null); },

    // ===== 设置（Preferences）=====
    getSettings(): Promise<AppSettings> {
      return settingsSaveQueue.then(() => readSettingsOnce());
    },
    saveSettings(settings: SettingsPatch): Promise<AppSettings> {
      return writeSettings(settings);
    },
    async testCloud(cfg: CloudTranslationConfig): Promise<{ ok: boolean; error?: string }> {
      // 真打一次最小翻译请求验证端点/密钥/模型；source≠target 避免被同语言短路直接返回原文。
      try {
        await new CloudTranslator(cfg).translate('hello', { source: 'en', target: 'ja' });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    // ===== 首次安装 / 模型下载（原生）=====
    async getSetupStatus(modelId: string): Promise<SetupStatus> {
      try {
        const s = await readSettingsOnce();
        return await RealtimeAsr.getSetupStatus({ modelId, language: s.asr.language });
      } catch {
        // 无原生壳（纯浏览器预览）：当作就绪，避免卡在首启引导。
        return { asrReady: true };
      }
    },
    async downloadAsrModels(modelId: string): Promise<{ ok: boolean; error?: string }> {
      try {
        const s = await readSettingsOnce();
        return await RealtimeAsr.downloadModels({ modelId, language: s.asr.language });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    // ===== 模型管理（原生）=====
    // iOS 只有 ASR 模型可自行下载/删除；翻译走 Apple Translation（语言包由系统管理），故不返回翻译条目
    //（模型管理页翻译分组为空则不渲染）。inUse 由此处按当前设置的 asr.model 判定，原生只给磁盘状态。
    async listModels(): Promise<ModelInfo[]> {
      const s = cachedSettings ?? (await readSettingsOnce());
      try {
        const { models } = await RealtimeAsr.listModels();
        return models.map((m) => ({
          kind: 'asr' as ModelKind,
          id: m.id,
          sizeBytes: m.sizeBytes,
          downloaded: m.downloaded,
          inUse: m.id === s.asr.model,
        }));
      } catch {
        // 无原生壳（纯浏览器预览）：无本地模型信息可列。
        return [];
      }
    },
    async deleteModel(kind: ModelKind, id: string): Promise<{ ok: boolean; error?: string }> {
      // 翻译语言包由系统管理，iOS 无可删的翻译模型（listModels 也不会返回翻译条目）。
      if (kind !== 'asr') {
        return { ok: false, error: 'no deletable translation models on iOS' };
      }
      try {
        return await RealtimeAsr.deleteModel({ id });
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async cancelModelDownload(kind: ModelKind, id: string): Promise<void> {
      // iOS 仅 ASR 有自研下载可取消（翻译走系统翻译，无下载）。中止在途 + 删除该模型残留。
      if (kind !== 'asr') return;
      try {
        await RealtimeAsr.cancelDownload({ id });
      } catch {
        /* 无原生壳/未在途：忽略 */
      }
    },

    // ===== 归档（Preferences）=====
    async saveArchive(name: string, lines: ArchiveLine[]): Promise<ArchiveSummary[]> {
      const records = await readArchives();
      const createdAt = Date.now();
      const record: ArchiveRecord = {
        id: makeArchiveId(createdAt),
        name,
        createdAt,
        lines,
      };
      records.push(record);
      await writeArchives(records);
      return listSummaries(records);
    },
    async listArchives(): Promise<ArchiveSummary[]> {
      return listSummaries(await readArchives());
    },
    async getArchive(id: string): Promise<ArchiveRecord | null> {
      const records = await readArchives();
      return records.find((r) => r.id === id) ?? null;
    },
    async deleteArchive(id: string): Promise<ArchiveSummary[]> {
      const records = (await readArchives()).filter((r) => r.id !== id);
      await writeArchives(records);
      return listSummaries(records);
    },

    // ===== 回调注册（与 macOS preload 的 on* 语义一致：仅记录，事件由 subscribeNative 转发）=====
    onSetupProgress(cb: (progress: SetupProgress) => void): (() => void) {
      return setupProgressCb.on(cb);
    },
    onSegment(cb: (segment: SegmentPayload) => void): (() => void) {
      const off = segmentCb.on(cb);
      if (hasJournal) queueMicrotask(resumeNative);
      return off;
    },
    onPartial(cb: (partial: PartialPayload) => void): (() => void) {
      return partialCb.on(cb);
    },
    onTranslation(cb: (translation: TranslationPayload) => void): (() => void) {
      return translationCb.on(cb);
    },
    onStatus(cb: (status: StatusPayload) => void): (() => void) {
      return statusCb.on(cb);
    },
    onTranslationStatus(cb: (status: TranslationStatusPayload) => void): (() => void) {
      return translationStatusCb.on(cb);
    },
  };

  // 预读一次设置，填充缓存（异步，不阻塞返回）。与 UI 首次 getSettings() 共享同一次读。
  void readSettingsOnce();

  return api;
}
