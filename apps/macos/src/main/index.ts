import { createAlwaysOnTopController } from './always-on-top';
import { createDisplaySleepBlocker } from './display-sleep';
import { TranslationRequestQueue } from './translation/request-queue';
import { runCandidateSmoke } from './candidate-smoke';
import path from 'node:path';
import fs from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  desktopCapturer,
  dialog,
  ipcMain,
  powerSaveBlocker,
  session,
  shell,
  systemPreferences,
  utilityProcess,
  type IpcMainEvent,
  type UtilityProcess,
} from 'electron';
import {
  LOCAL_TRANSLATION_MODELS,
  DEFAULT_TRANSLATION_MODEL_ID,
  getTranslationModel,
  translateFinalizedSegment,
  createReverseTranslationContext,
  resetReverseTranslationContext,
  CloudTranslator,
  TranslationContext,
  ASR_MODELS,
  getAsrModel,
  requiredAsrFiles,
  type LocalModelSpec,
  type SegmentTranslateRequest,
  type AsrLang,
  type ModelInfo,
  type ModelKind,
  type CloseGuard,
} from '@rt/core';
import { localModelCached } from './translation/model-cache';
import { downloadTranslationModel } from './translation/model-downloader';
import { loadSettings, saveSettings } from './settings';
import { asrModelsReady, downloadAsrModels } from './model-downloader';
import { listArchives, getArchive, saveArchive, deleteArchive } from './archives';
import { ArchiveLibraryStore } from './archive-library';
import { listSummaries, suggestArchiveTitle } from '@rt/core';
import { systemAudioSupported } from '../shared/audio-source';
import asrWorkerPath from './asr-process?modulePath';
import translateWorkerPath from './translation/translate-process?modulePath';
import type {
  StartResult,
  AppSettings,
  CloudTranslationConfig,
  SegmentPayload,
  SetupStatus,
  AsrToMain,
  TranslateToMain,
  ArchiveLine,
  MicPermission,
} from '../shared/types';

// A development preview must not reuse a running installation's settings or archives.
const previewProfile = !app.isPackaged ? process.env['RT_PREVIEW_PROFILE'] : undefined;
if (previewProfile) {
  fs.mkdirSync(path.resolve(previewProfile), { recursive: true });
  app.setPath('userData', path.resolve(previewProfile));
  app.setName('Subline Preview');
}

// Keep each channel's profile (settings / archives / downloaded models) stable across the renames
// "Classroom Translator" → "Realtime Translator" → "Subline": the data folders keep their legacy names.
// Bundle IDs are unchanged too, so macOS microphone / system-audio grants carry over.
const LEGACY_PROFILE_DIRS: Record<string, string> = {
  'Subline Internal': 'Classroom Translator Internal',
  'Subline': 'Classroom Translator',
  'Realtime Translator Internal': 'Classroom Translator Internal',
  'Realtime Translator': 'Classroom Translator',
};
if (app.isPackaged && process.platform === 'win32') {
  app.setPath('userData', path.join(app.getPath('appData'), 'Subline Windows Candidate'));
} else if (app.isPackaged && LEGACY_PROFILE_DIRS[app.getName()]) {
  app.setPath('userData', path.join(app.getPath('appData'), LEGACY_PROFILE_DIRS[app.getName()]));
}
const smokeFlag = process.platform === 'win32' ? process.argv.indexOf('--candidate-smoke') : -1;
const smokeReport = smokeFlag >= 0 ? process.argv[smokeFlag + 1] : undefined;
if (smokeFlag >= 0) {
  if (!smokeReport || !path.isAbsolute(smokeReport)) throw new Error('Candidate smoke requires an absolute report path');
  app.setPath('userData', fs.mkdtempSync(path.join(app.getPath('temp'), 'subline-candidate-smoke-')));
}

// 模型存放目录：
// - 打包后 app.getAppPath() 指向只读的 app.asar，必须写到可写的 userData；
// - 开发时用仓库根目录的 models/，便于复用已下载的模型。
const MODELS_DIR = !app.isPackaged && process.env['RT_MODELS_DIR']
  ? path.resolve(process.env['RT_MODELS_DIR'])
  : app.isPackaged
  ? path.join(app.getPath('userData'), 'models')
  : path.join(app.getAppPath(), 'models');
const TRANSLATION_CACHE_DIR = path.join(MODELS_DIR, 'transformers');

let win: BrowserWindow | null = null;
// 渲染层在正在录音或有未归档内容时设置；关窗 / ⌘Q 前据此确认，避免一键丢掉整节课。
let closeGuard: CloseGuard | null = null;
// 用户已在确认框选择退出（或归档完成）：之后的 close / before-quit 直接放行，不再重复弹框。
let leaveConfirmed = false;
let leavePrompt: Promise<boolean> | null = null;
let archiveRequestId = 0;
// 停录需等 ASR 收尾最后一句，归档再写盘；超时视为失败，窗口保持打开。
const ARCHIVE_BEFORE_CLOSE_TIMEOUT_MS = 30_000;

function hasUnsavedContent(): boolean {
  return closeGuard !== null;
}

// 请渲染层停止录音并归档，等待其回执。
function archiveBeforeClose(target: BrowserWindow): Promise<boolean> {
  const id = ++archiveRequestId;
  return new Promise((resolve) => {
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      ipcMain.removeListener('window:archive-before-close:done', onDone);
      resolve(ok);
    };
    const onDone = (_event: IpcMainEvent, replyId: number, ok: boolean): void => {
      if (replyId === id) finish(ok);
    };
    const timer = setTimeout(() => finish(false), ARCHIVE_BEFORE_CLOSE_TIMEOUT_MS);
    ipcMain.on('window:archive-before-close:done', onDone);
    target.webContents.send('window:archive-before-close', id);
  });
}

// 关窗与 ⌘Q 共用的确认流程；对话框已开着时再次触发（如连按 ⌘Q）复用同一结果。
function confirmLeave(): Promise<boolean> {
  leavePrompt ??= (async () => {
    const guard = closeGuard;
    const target = win;
    if (!guard || !target || target.isDestroyed()) return true;
    const { response } = await dialog.showMessageBox(target, {
      type: 'warning',
      message: guard.message,
      detail: guard.detail,
      buttons: [guard.archive, guard.discard, guard.cancel],
      defaultId: 2,
      cancelId: 2,
      noLink: true,
    });
    if (response === 2) return false;
    if (response === 1) return true;
    return archiveBeforeClose(target);
  })().finally(() => {
    leavePrompt = null;
  });
  return leavePrompt;
}
// ASR 识别跑在独立的 utilityProcess 子进程，主进程只转发音频、不做推理
let asrChild: UtilityProcess | null = null;
let asrReady: Promise<void> | null = null;
// 当前存活的 ASR 子进程装载的模型/语言配置：设置保存时据此判断是否需要按新配置重建。
let asrChildConfig: { modelId: string; language: AsrLang } | null = null;
// 是否处于录音会话（start 进入 running 后为真、stop/子进程退出后为假）。
// prewarm 冷启动完成时据此判断：会话已由 start 接管（running）则不再发 stopped 覆盖。
let sessionActive = false;

// 渲染层的行 id：主进程单调递增，跨 ASR 子进程重启不归零。
// 子进程内部的段序号随进程生命周期从 0 计，直接透传会与既有行冲突、译文回填错行。
let nextLineId = 0;

// 反向翻译会话状态：识别语言为 auto 时，听到母语的段翻成上一次识别到的外语；每次开始录音清空（见 pipeline:start）。
const reverseCtx = createReverseTranslationContext();
const translationContext = new TranslationContext();

// 翻译跑在独立的纯 Node 子进程（child_process.fork + ELECTRON_RUN_AS_NODE）：隔离原生
// 崩溃与超大内存分配，翻译进程挂掉也不连累主窗口，仅丢一次翻译。必须脱离 utilityProcess
// ——后者挂着 Chromium 分配器，翻译模型推理的超大分配（约 870MB 及以上）会被其对巨型分配的
// abort 直接杀死；纯 Node 用系统 malloc 无此限制。ASR 子进程无此问题，仍用 utilityProcess。
// 句柄携带该进程专属的在途请求表，按进程隔离：进程退出时只 reject 发往它的请求。
interface TranslateChild {
  proc: ChildProcess;
  // 在途翻译请求：行 id → Promise 句柄。子进程 result/error 消息按 id 关联回 Promise，
  // 把消息协议封装成 async 引擎调用供 core 编排使用；进程退出时只 reject 发往它的请求，防悬挂。
  pending: Map<number, { resolve: (text: string) => void; reject: (e: Error) => void; onPartial?: (text: string) => void }>;
}
let translateChild: TranslateChild | null = null;

// 本地翻译模型下载的在途任务表（按 modelId 单飞）：同一模型的重复下载复用同一 promise，
// 避免并发写同一缓存目录。下载走自研链路（downloadTranslationModel），与翻译子进程无关。
const translationDownloads = new Map<string, Promise<{ ok: boolean; error?: string }>>();

// 各模型在途下载的中止句柄（后台并行下载 + 按模型取消用），键为 `${kind}:${id}`。
// models:cancel-download 只 abort 对应模型；下载结束时删除自身条目。
const downloadAborts = new Map<string, AbortController>();

// 当前选中的本地翻译模型 spec（引擎为 cloud 或未知本地 id 时无）。
function currentTranslationSpec(): LocalModelSpec | undefined {
  const engine = loadSettings().translation.engine;
  return engine === 'cloud' ? undefined : getTranslationModel(engine);
}

// 当前选中的本地翻译模型是否已完整缓存：仅用于设置保存/启动时门控自动预热（把磁盘模型载入内存）。
// 下载页的「是否已缓存」改由参数化的 translation:setup-status 按 modelId 回答，与当前引擎无关。
function translationModelCached(): boolean {
  const spec = currentTranslationSpec();
  return spec ? localModelCached(TRANSLATION_CACHE_DIR, spec) : false;
}

/** 本机是否支持系统音频采集（macOS 14.2+）。与 preload 的音源判定共用同一逻辑。 */
function systemAudioAvailable(): boolean {
  return systemAudioSupported(process.getSystemVersion(), process.platform);
}

/**
 * 对外暴露的设置：系统版本不支持系统音频时把 audioSource 收敛为 'mic'，
 * 与 preload 上报的 audioSources 保持一致（避免 UI 拿到本机不可用的 'system'）。
 */
function effectiveSettings(): AppSettings {
  const s = loadSettings();
  if (s.audioSource === 'system' && !systemAudioAvailable()) {
    return { ...s, audioSource: 'mic' };
  }
  return s;
}

/** 递归统计目录实际占用字节（目录不存在返回 0）。 */
function dirSize(dir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += dirSize(p);
    } else {
      try {
        total += fs.statSync(p).size;
      } catch {
        // 统计期文件被删/无权限：忽略该文件
      }
    }
  }
  return total;
}

// 应用图标：仅开发时手动设置（dev 下 Dock 默认显示 Electron 图标）；
const displaySleep = createDisplaySleepBlocker(powerSaveBlocker);

// 打包后图标由 electron-builder 写入 .app，无需也无法从 asar 取此路径。
// 图标源已唯一化到仓库根 assets/icon.png（见 scripts/gen-icon.mjs）；
// getAppPath() 在 dev 下为 apps/macos，故上溯两级到仓库根取共享 PNG。
const APP_ICON = path.join(app.getAppPath(), '..', '..', 'assets', 'icon.png');

const alwaysOnTop = createAlwaysOnTopController({
  load: loadSettings,
  save: saveSettings,
  window: () => win && !win.isDestroyed() ? win : null,
  notify: (on) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('always-on-top');
    if (item) item.checked = on;
    sendToRenderer('window:always-on-top-changed', on);
  },
});

function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu', submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      { type: 'separator' },
      {
        id: 'always-on-top', label: 'Always on Top', type: 'checkbox',
        checked: loadSettings().alwaysOnTop,
        click: (item) => alwaysOnTop.set(item.checked),
      },
      { type: 'separator' },
      { role: 'front' },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: !smokeReport,
    title: app.isPackaged ? app.getName() : previewProfile ? 'Subline Preview' : 'Subline',
    ...(app.isPackaged ? {} : { icon: APP_ICON }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
    },
  });
  alwaysOnTop.apply(loadSettings().alwaysOnTop);
  win.on('closed', () => displaySleep.stop());
  win.on('close', (event) => {
    if (leaveConfirmed || !hasUnsavedContent()) return;
    event.preventDefault();
    void confirmLeave().then((ok) => {
      if (!ok) return;
      leaveConfirmed = true;
      win?.close();
    });
  });
  win.on('page-title-updated', (event) => {
    if (app.isPackaged) event.preventDefault();
  });
  // 开发用 vite dev server，生产加载打包后的 HTML
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// Bound requests before IPC so the worker and local inference server cannot accumulate an unbounded backlog.
const translationQueue = new TranslationRequestQueue<SegmentTranslateRequest, string>(dispatchTranslate);

function requestTranslate(req: SegmentTranslateRequest): Promise<string> {
  return translationQueue.submit(req);
}

/** Only the active queue entry is registered in the child process pending map. */
function dispatchTranslate(req: SegmentTranslateRequest): Promise<string> {
  const child = ensureTranslateChild();
  return new Promise<string>((resolve, reject) => {
    child.pending.set(req.id, { resolve, reject, onPartial: req.onPartial });
    child.proc.send({
      type: 'translate',
      id: req.id,
      text: req.text,
      source: req.source,
      target: req.targetLang,
      context: req.context,
    }, (error) => {
      if (!error) return;
      child.pending.get(req.id)?.reject(error);
      child.pending.delete(req.id);
    });
  });
}

/** 启动翻译子进程并按当前设置初始化 */
function startTranslateChild(): TranslateChild {
  // 以纯 Node 运行翻译子进程：fork 用 process.execPath（Electron 二进制），配合
  // ELECTRON_RUN_AS_NODE=1 使其以 Node 运行时启动、脱离 Chromium 分配器。env 需先展开
  // process.env（fork 传 env 会整体替换而非合并），再覆盖该标志。
  // 打包态：纯 Node 无 asar 补丁，读不了 app.asar 内的文件，故 fork 目标改指 app.asar.unpacked
  // （out/main 已在 asarUnpack 之列）。dev 态产物在真实文件系统，无需替换。
  const workerPath = app.isPackaged
    ? translateWorkerPath.replace('app.asar', 'app.asar.unpacked')
    : translateWorkerPath;
  const proc = fork(workerPath, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const pending: TranslateChild['pending'] = new Map();
  const handle: TranslateChild = { proc, pending };
  translateChild = handle;
  proc.on('message', (m: TranslateToMain) => {
    if (m.type === 'status') {
      sendToRenderer('translation:status', m.payload);
    } else if (m.type === 'partial') {
      pending.get(m.id)?.onPartial?.(m.text);
    } else if (m.type === 'result') {
      pending.get(m.id)?.resolve(m.text);
      pending.delete(m.id);
    } else if (m.type === 'error') {
      pending.get(m.id)?.reject(new Error(m.message));
      pending.delete(m.id);
    }
  });
  proc.on('exit', (code, signal) => {
    // 仅当全局引用仍指向本进程时才清空：reconfigure 已 fork 新进程时，旧进程的异步 exit
    // 不能误清新引用（否则新进程成孤儿、发往它的在途翻译被误判失败）。
    const isCurrent = translateChild === handle;
    if (isCurrent) {
      translateChild = null;
    }
    // 只 reject 发往本进程的在途请求（core 编排据此结束对应行的等待动画），不波及其它进程。
    for (const p of pending.values()) {
      p.reject(new Error(`翻译进程退出 (${signal ?? code})`));
    }
    pending.clear();
    // 仅在「引用仍指向本进程」（即非主动 kill 重建）且非正常退出时报错：reconfigure/删除模型/
    // 关窗等主动 kill 已同步置空引用，isCurrent 为假，不误报；被信号杀死的崩溃 code 为 null、
    // signal 携带信号名，故以 code!==0 判定异常退出（兼容 null）。
    if (isCurrent && code !== 0) {
      // 翻译进程异常退出（如模型内存过大崩溃）：主进程存活，提示失败，下次翻译自动重启
      sendToRenderer('translation:status', { state: 'error', error: `翻译进程异常退出 (${signal ?? code})` });
    }
  });
  const t = loadSettings().translation;
  proc.send({
    type: 'configure',
    engine: t.engine,
    cloud: t.cloud,
    cacheDir: TRANSLATION_CACHE_DIR,
  });
  return handle;
}

/** 确保翻译子进程已就绪（懒启动 + 复用） */
function ensureTranslateChild(): TranslateChild {
  return translateChild ?? startTranslateChild();
}

/** 设置变更后让翻译子进程按新配置重建（kill 后下次按需重启） */
function reconfigureTranslate(): void {
  translationQueue.cancelWaiting();
  translationContext.reset();
  // 同步置空引用；旧进程的 exit 只 reject 发往它的在途请求，不影响之后按需 fork 的新进程
  translateChild?.proc.kill();
  translateChild = null;
}

/** 对一条定稿段做翻译（fire-and-forget），失败不影响转写。目标恒为母语。
 *  编排（是否翻 / pending / 字形归一化 / 错误上报）统一在 @rt/core.translateFinalizedSegment，
 *  与 web/iOS 一致；这里注入的引擎是翻译子进程消息协议的 Promise 封装。 */
function translateSegment(segment: SegmentPayload): void {
  const settings = loadSettings();
  // 规划用 spec 按当前引擎查表；云端/未知引擎回落默认本地模型（planTranslation 的 skip/script/toScript
  // 判定与本地模型无关，云端路径只用 targetLang 而非 targetCode，故回落不影响云端译文）。
  const spec =
    getTranslationModel(settings.translation.engine) ??
    getTranslationModel(DEFAULT_TRANSLATION_MODEL_ID)!;
  void translateFinalizedSegment({
    spec,
    segment,
    enabled: settings.translation.enabled,
    nativeLang: settings.nativeLang,
    asrLanguage: settings.asr.language,
    reverse: reverseCtx,
    context: ['cloud', 'hy-mt2-7b'].includes(settings.translation.engine) ? translationContext : undefined,
    translate: requestTranslate,
    emitTranslation: (p) => sendToRenderer('pipeline:translation', p),
  });
}

/** 启动 ASR 子进程并完成初始化（含模型加载 + 预热），resolve 表示就绪 */
function startAsrChild(): Promise<void> {
  const child = utilityProcess.fork(asrWorkerPath);
  asrChild = child;
  // 按当前设置装载模型/语言，并记录本子进程所用配置（设置变更时据此判断是否需重建）。
  const asr = loadSettings().asr;
  asrChildConfig = { modelId: asr.model, language: asr.language };

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    child.on('message', (m: AsrToMain) => {
      switch (m.type) {
        case 'ready':
          settled = true;
          resolve();
          break;
        case 'segment': {
          // 行 id 改写为主进程计数器的值：UI 上屏与译文回填都以它对应
          const payload: SegmentPayload = { ...m.payload, id: nextLineId++ };
          sendToRenderer('pipeline:segment', payload); // 原文立即上屏
          translateSegment(payload); // 译文异步回填
          break;
        }
        case 'partial':
          sendToRenderer('pipeline:partial', m.payload);
          break;
        case 'error':
          sendToRenderer('pipeline:status', { state: 'error', error: m.message, code: 'asr-init-failed' });
          if (!settled) {
            // 初始化阶段就出错：销毁子进程，让 exit 清空引用，下次 start 可重新 fork 恢复
            settled = true;
            reject(new Error(m.message));
            child.kill();
          }
          break;
      }
    });
    child.on('exit', (code) => {
      // 仅当全局引用仍指向本进程时才清空并上报：设置变更/删除模型主动 kill 时已同步置空引用，
      // 其异步 exit 不应误报「识别进程异常退出」，也不应清掉随后新建的子进程引用。
      const isCurrent = asrChild === child;
      if (isCurrent) {
        displaySleep.stop();
        asrChild = null;
        asrReady = null;
        asrChildConfig = null;
        sessionActive = false;
        if (code !== 0) {
          sendToRenderer('pipeline:status', { state: 'error', error: `识别进程异常退出 (${code})`, code: 'asr-crashed' });
        }
      }
      // 初始化未完成即退出（含 reconfigure/删模型在冷加载途中主动 kill 的 code 0）：
      // 必须 settle，否则 ensureAsr 的等待者（prewarm/start）永久悬挂，
      // prewarm 的 finally 不再发 stopped 终态、录音按钮一直停在加载中。
      if (!settled) {
        settled = true;
        reject(new Error(`识别进程退出 (${code})`));
      }
    });
    child.postMessage({ type: 'init', modelsDir: MODELS_DIR, modelId: asr.model, language: asr.language });
  });
}

/** 让当前 ASR 子进程按新配置重建：同步置空引用，下次 start/prewarm 时以最新设置重新 fork。 */
function reconfigureAsr(): void {
  displaySleep.stop();
  asrChild?.kill();
  asrChild = null;
  asrReady = null;
  asrChildConfig = null;
}

/** 确保 ASR 子进程已就绪（懒启动 + 复用） */
function ensureAsr(): Promise<void> {
  if (!asrChild) {
    asrReady = startAsrChild();
  }
  return asrReady ?? Promise.resolve();
}

ipcMain.handle('pipeline:start', async (): Promise<StartResult> => {
  // 系统音频 + 开发模式提示：CoreAudio Tap 的 TCC 责任进程是「启动 Electron 的父程序」——
  // 从终端/IDE 跑 dev 时责任落在终端/IDE，它们的 Info.plist 没有 NSAudioCaptureUsageDescription，
  // macOS 会给一条不弹窗、无报错的**静音流**。解法：给终端/IDE 手动授予「仅录制系统音频」权限，
  // 或用打包产物验证（应用自身 Info.plist 已带该 key，不受影响）。
  if (!app.isPackaged && effectiveSettings().audioSource === 'system') {
    console.warn(
      '[system-audio] dev 模式下若采集到的系统音频为静音：请在 系统设置 → 隐私与安全性 → ' +
        '屏幕与系统音频录制 → 仅录制系统音频 中加入你的终端/IDE，或用打包应用验证'
    );
  }
  // 仅麦克风音源需申请麦克风权限；系统音频音源不触碰麦克风权限
  // （系统音频的录制授权在渲染层 getDisplayMedia 时由系统弹出，见 mac-bridge）。
  if (effectiveSettings().audioSource === 'mic' && process.platform === 'darwin') {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (!granted) {
      return { ok: false, error: '未获得麦克风权限，请在系统设置中授权', code: 'mic-permission' };
    }
  }

  try {
    // 仅真冷启动（fork 子进程装模型）才报 loading：预热后复用路径瞬时完成，
    // 报 loading 会让每次开始录音都闪一次「识别模型加载中」的误导提示。
    if (!asrChild) {
      sendToRenderer('pipeline:status', { state: 'loading' });
    }
    await ensureAsr();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  // 子进程跨会话复用：每次开始录音都重置计时基线，segment.start 相对本次会话起点
  asrChild?.postMessage({ type: 'reset' });
  resetReverseTranslationContext(reverseCtx); // 外语历史只在本次会话内有效
  translationContext.reset();
  sendToRenderer('pipeline:status', { state: 'running' });
  sessionActive = true;
  displaySleep.start();
  return { ok: true };
});

// 预热 ASR 管线：把识别模型装载进内存，绝不触碰麦克风、不申请权限；模型未下载时静默跳过。
// 幂等——UI 在调用前先行禁用录音按钮，故除会话已由 start 接管（sessionActive，完成时不发
// stopped 覆盖 running）外，任何路径（模型缺失的跳过 / 子进程已就绪 / 冷启动成败）都必须以
// pipeline:status 的 stopped 终态收尾解禁。与并发的 pipeline:start 共用 ensureAsr 单飞天然合流。
// 冷启动失败时子进程的 error 状态会照常上报（用户未操作也能看到提示），随后仍以 stopped 收尾。
ipcMain.on('pipeline:prewarm', () => {
  if (!asrModelsReady(MODELS_DIR, loadSettings().asr.model)) {
    sendToRenderer('pipeline:status', { state: 'stopped' });
    return;
  }
  if (!asrChild) {
    sendToRenderer('pipeline:status', { state: 'loading' });
  }
  ensureAsr()
    .catch((err) => {
      console.error('[prewarm] ASR 预热失败', err);
    })
    .finally(() => {
      if (!sessionActive) sendToRenderer('pipeline:status', { state: 'stopped' });
    });
});

// 麦克风权限：渲染层在请求权限前先查状态，自行决定是否弹说明弹窗
ipcMain.handle('mic:get-status', (): MicPermission =>
  process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted'
);

ipcMain.on('mic:open-settings', () => {
  if (process.platform === 'darwin') {
    void shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    );
  } else if (process.platform === 'win32') {
    void shell.openExternal('ms-settings:privacy-microphone');
  }
});

ipcMain.on('window:close-guard', (_event, guard: CloseGuard | null) => {
  closeGuard = guard;
});

// 系统音频录制权限被拒后的引导：打开「屏幕与系统音频录制」隐私页
// （ScreenCapture 锚点即该合并页，含「仅录制系统音频」分栏）。
ipcMain.on('system-audio:open-settings', () => {
  if (process.platform === 'darwin') {
    void shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    );
  } else if (process.platform === 'win32') {
    void shell.openExternal('ms-settings:sound');
  }
});

ipcMain.handle('setup:get-status', (_event, modelId: string): SetupStatus => ({
  asrReady: asrModelsReady(MODELS_DIR, modelId),
}));

ipcMain.handle(
  'setup:download-asr',
  async (_event, modelId: string): Promise<{ ok: boolean; error?: string }> => {
    // 挂 AbortController 支持后台取消（models:cancel-download），按模型键索引以支持并行。
    const key = `asr:${modelId}`;
    const abort = new AbortController();
    downloadAborts.set(key, abort);
    try {
      await downloadAsrModels(
        MODELS_DIR,
        modelId,
        (p) => sendToRenderer('setup:progress', { kind: 'asr', id: modelId, ...p }),
        abort.signal
      );
      return { ok: true };
    } catch (err) {
      if (abort.signal.aborted) return { ok: false, error: 'cancelled' };
      return { ok: false, error: (err as Error).message };
    } finally {
      if (downloadAborts.get(key) === abort) downloadAborts.delete(key);
    }
  }
);

// 模型管理页：列出各模型（ASR + 翻译）的占用与状态
ipcMain.handle('models:list', (): ModelInfo[] => {
  const settings = loadSettings();
  const models: ModelInfo[] = [];
  for (const spec of ASR_MODELS) {
    if (!spec.platforms.includes(process.platform === 'win32' ? 'windows' : 'macos')) continue;
    // sizeBytes 为该模型自身文件的实际字节和（不含公共依赖 VAD）
    let sizeBytes = 0;
    for (const f of spec.files) {
      try {
        sizeBytes += fs.statSync(path.join(MODELS_DIR, f.dir, f.filename)).size;
      } catch {
        // 未下载/缺文件：不计入
      }
    }
    models.push({
      kind: 'asr',
      id: spec.id,
      sizeBytes,
      downloaded: asrModelsReady(MODELS_DIR, spec.id),
      inUse: settings.asr.model === spec.id,
    });
  }
  // 翻译模型：注册表驱动（platforms 含 macos）。每模型占用/齐全按其在 transformers 缓存中的
  // 子目录（<cacheDir>/<modelId>）判断；modelId 形如 Xenova/xxx，path.join 拼出该模型独立目录。
  for (const spec of LOCAL_TRANSLATION_MODELS) {
    if (!spec.platforms.includes(process.platform === 'win32' ? 'windows' : 'macos')) continue;
    models.push({
      kind: 'translation',
      id: spec.id,
      sizeBytes: dirSize(path.join(TRANSLATION_CACHE_DIR, spec.modelId)),
      downloaded: localModelCached(TRANSLATION_CACHE_DIR, spec),
      inUse: settings.translation.engine === spec.id,
    });
  }
  return models;
});

// 删除某模型的全部已下文件（ASR：models/<dir>，公共依赖 VAD 在根目录不受影响；翻译：<cacheDir>/<modelId>）。
// 在用则先 kill 对应子进程释放文件句柄（下次 start/translate 按新设置重建）。models:delete 与
// models:cancel-download 共用；未知 id 抛错。
function deleteModelFiles(kind: ModelKind, id: string): void {
  if (kind === 'asr') {
    const spec = getAsrModel(id);
    if (!spec) throw new Error('未知的识别模型');
    fs.rmSync(path.join(MODELS_DIR, spec.dir), { recursive: true, force: true });
    if (asrChildConfig?.modelId === id) {
      reconfigureAsr();
    }
  } else {
    const spec = getTranslationModel(id);
    if (!spec) throw new Error('未知的翻译模型');
    if (loadSettings().translation.engine === id) {
      reconfigureTranslate();
    }
    fs.rmSync(path.join(TRANSLATION_CACHE_DIR, spec.modelId), { recursive: true, force: true });
  }
}

// 模型管理页：删除某个已下载模型（录音会话中拒绝）
ipcMain.handle(
  'models:delete',
  (_event, kind: ModelKind, id: string): { ok: boolean; error?: string } => {
    if (sessionActive) {
      return { ok: false, error: '录音进行中，无法删除模型' };
    }
    try {
      deleteModelFiles(kind, id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
);

// 后台下载的取消入口：只中止该模型的在途下载（并行下载互不影响）并删除其全部残留（回未下载态）。
// abort 是同步信号、deleteModelFiles 同步执行，先删目录再让在途下载在下次 I/O 续期时失败，故不残留。
ipcMain.handle('models:cancel-download', (_event, kind: ModelKind, id: string): { ok: boolean } => {
  downloadAborts.get(`${kind}:${id}`)?.abort();
  try {
    deleteModelFiles(kind, id);
  } catch {
    /* 未知 id / 未下载：忽略，尽力清理；listModels 刷新会反映真实状态 */
  }
  return { ok: true };
});

// 下载页/录音前检查：指定本地翻译模型（按 id，与当前引擎无关）是否已完整缓存。
ipcMain.handle('translation:setup-status', (_event, modelId: string): { ready: boolean } => {
  const spec = getTranslationModel(modelId);
  return { ready: spec ? localModelCached(TRANSLATION_CACHE_DIR, spec) : false };
});

// 下载页：显式下载指定本地翻译模型（自研链路，与翻译子进程无关）。进度经 setup:progress 上报，
// 与 ASR 完全一致；按 modelId 单飞（在途同模型复用 promise）。
ipcMain.handle(
  'translation:download',
  (_event, modelId: string): Promise<{ ok: boolean; error?: string }> => {
    const inflight = translationDownloads.get(modelId);
    if (inflight) return inflight;
    const key = `translation:${modelId}`;
    const abort = new AbortController();
    downloadAborts.set(key, abort);
    const promise = downloadTranslationModel(
      TRANSLATION_CACHE_DIR,
      modelId,
      (p) => sendToRenderer('setup:progress', { kind: 'translation', id: modelId, ...p }),
      abort.signal
    )
      .then(() => ({ ok: true }))
      .catch((err: unknown) =>
        abort.signal.aborted ? { ok: false, error: 'cancelled' } : { ok: false, error: (err as Error).message }
      )
      .finally(() => {
        translationDownloads.delete(modelId);
        if (downloadAborts.get(key) === abort) downloadAborts.delete(key);
      });
    translationDownloads.set(modelId, promise);
    return promise;
  }
);

ipcMain.on('pipeline:audio', (_event, samples: Float32Array) => {
  if (!asrChild) return;
  // IPC 过来的其实是字节视图，必须还原成 Float32Array 再转发，否则子进程会把
  // 8192 字节当成 8192 个浮点（值为 0-255）→ 音频变噪声、识别全错
  const f = new Float32Array(
    samples.buffer as ArrayBuffer,
    samples.byteOffset,
    samples.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  // 主进程只转发音频给识别子进程，不做推理
  asrChild.postMessage({ type: 'audio', samples: f });
});

const internalArchives = process.platform === 'win32' || app.getName().endsWith('Internal') || !!previewProfile;
const archiveLibrary = new ArchiveLibraryStore(path.join(app.getPath('userData'), 'archive-library.json'));
function requireArchiveLibrary(): void {
  if (!internalArchives) throw new Error('Archive library is only available in Internal');
}
async function archiveSummaries() {
  if (!internalArchives) return listArchives();
  const records = listArchives().map((item) => getArchive(item.id)!);
  return listSummaries(await archiveLibrary.decorate(records));
}
ipcMain.handle('archive:list', () => archiveSummaries());
ipcMain.handle('archive:get', async (_event, id: string) => {
  const record = getArchive(id);
  return record && internalArchives ? (await archiveLibrary.decorate([record]))[0] : record;
});
ipcMain.handle('archive:save', async (_event, name: string, lines: ArchiveLine[], folderId?: string | null) => {
  if (internalArchives) {
    const library = await archiveLibrary.library();
    const destination = folderId === undefined ? library.lastFolderId : folderId;
    if (destination !== null && !library.folders.some((folder) => folder.id === destination)) throw new Error('Folder not found');
    await saveArchive(name.trim() || suggestArchiveTitle(lines, new Date().toLocaleString()), lines, Date.now(), destination);
    // The archive is already durable; an optional preference write must not invite a duplicate save.
    try { await archiveLibrary.remember(destination); }
    catch (error) { console.error('保存归档默认文件夹失败:', error); }
    return archiveSummaries();
  }
  return saveArchive(name, lines, Date.now());
});
ipcMain.handle('archive:delete', async (_event, id: string) => {
  await deleteArchive(id);
  return archiveSummaries();
});
ipcMain.handle('archive:library', () => { requireArchiveLibrary(); return archiveLibrary.library(); });
ipcMain.handle('archive:folder-create', (_event, name: string) => {
  requireArchiveLibrary(); return archiveLibrary.createFolder(name);
});
ipcMain.handle('archive:folder-rename', (_event, id: string, name: string) => {
  requireArchiveLibrary(); return archiveLibrary.renameFolder(id, name);
});
ipcMain.handle('archive:update', async (_event, id: string, patch: { name?: string; folderId?: string | null }) => {
  requireArchiveLibrary();
  if (!getArchive(id)) throw new Error('Archive not found');
  await archiveLibrary.update(id, patch);
  return archiveSummaries();
});

ipcMain.handle('window:set-always-on-top', (_event, on: unknown): void => {
  if (typeof on !== 'boolean') throw new TypeError('alwaysOnTop must be a boolean');
  alwaysOnTop.set(on);
});

ipcMain.handle('settings:get', (): AppSettings => effectiveSettings());

ipcMain.handle('settings:save', (_event, next: AppSettings): AppSettings => {
  const prev = loadSettings().translation;
  const cur = next.translation;
  // 只有翻译引擎/云端配置变了才需要重建翻译器；
  // 改主题/字体/母语不应触动翻译器（否则会误触发模型重新加载）
  const engineChanged =
    prev.engine !== cur.engine ||
    prev.cloud.baseURL !== cur.cloud.baseURL ||
    prev.cloud.apiKey !== cur.cloud.apiKey ||
    prev.cloud.model !== cur.cloud.model;

  // 主页已无翻译开关，开启改由保存触发：翻译刚从关变开也要预热（引擎未变时也是）。
  const enabledTurnedOn = !prev.enabled && cur.enabled;

  const saved = saveSettings(next);
  alwaysOnTop.apply(saved.alwaysOnTop);
  if (engineChanged) {
    reconfigureTranslate();
  }
  // 识别模型/语言变了：kill 当前 ASR 子进程，下次 start/prewarm 按新配置重建
  // （与翻译器的 reconfigure 同风格；比对存活子进程实际装载的配置，无子进程时无需处理）。
  if (
    asrChildConfig &&
    (asrChildConfig.modelId !== saved.asr.model || asrChildConfig.language !== saved.asr.language)
  ) {
    reconfigureAsr();
  }
  // 保存后自动预热（降低首句翻译延迟）：
  // - cloud：无本地模型，直接预热（发起云端引擎的懒初始化，开销小）；
  // - 本地：仅当模型已缓存时预热（把磁盘模型载入内存）；未缓存则不在此下载，
  //   改由下载页显式调用 downloadTranslationModel 驱动，避免保存设置时静默触发大文件下载。
  if (saved.translation.enabled && (engineChanged || enabledTurnedOn)) {
    const canPreheat = saved.translation.engine === 'cloud' || translationModelCached();
    if (canPreheat) {
      ensureTranslateChild().proc.send({ type: 'preheat' });
    }
  }
  // 返回收敛后的设置（与 settings:get 一致），保证 UI 拿到本机实际生效的音源。
  return effectiveSettings();
});

// 云端配置连通性测试：主进程用 Node fetch 打一次最小翻译请求（无浏览器 CORS 限制，与实际云翻译
// 同环境）。供设置页「测试连接」，与 Web/iOS 的 testCloud 行为一致。source≠target 避免被短路。
ipcMain.handle(
  'translation:test-cloud',
  async (_event, cfg: CloudTranslationConfig): Promise<{ ok: boolean; error?: string }> => {
    try {
      await new CloudTranslator(cfg).translate('hello', { source: 'en', target: 'ja' });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
);

ipcMain.handle('pipeline:stop', () => {
  displaySleep.stop();
  asrChild?.postMessage({ type: 'flush' });
  sessionActive = false;
  sendToRenderer('pipeline:status', { state: 'stopped' });
  return { ok: true };
});

app.whenReady().then(() => {
  // macOS dev：Dock 默认显示 Electron 图标，手动替换；打包后用 .app 内置图标
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(APP_ICON);
  }
  // macOS keeps its frame-only CoreAudio path. Windows loopback needs a desktop source;
  // the renderer immediately stops its video track and never renders or saves screen content.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const frame = request.frame;
    if (!frame || !win || win.isDestroyed() || frame !== win.webContents.mainFrame
      || !request.audioRequested || effectiveSettings().audioSource !== 'system' || !systemAudioAvailable()) {
      callback({});
      return;
    }
    if (process.platform !== 'win32') {
      callback({ video: frame, audio: 'loopback' });
      return;
    }
    void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
      .then((sources) => {
        if (!win || win.isDestroyed() || frame.isDestroyed() || frame !== win.webContents.mainFrame || !sources[0]) {
          callback({});
          return;
        }
        callback({ video: sources[0], audio: 'loopback' });
      })
      .catch(() => callback({}));
  });
  installMenu();
  createWindow();
  if (smokeReport && win) {
    void runCandidateSmoke(win, app.getPath('userData'), smokeReport)
      .then((ok) => app.exit(ok ? 0 : 1))
      .catch((error) => { console.error(error); app.exit(1); });
    return;
  }
  // 启动即按「翻译已开 + 本地引擎 + 模型已缓存」预热本地翻译模型，降低首句翻译延迟；
  // 未缓存则不在此下载（首次下载交给翻译模型下载页）。cloud 引擎的预热仍只在设置保存时触发。
  const t = loadSettings().translation;
  if (t.enabled && t.engine !== 'cloud' && translationModelCached()) {
    ensureTranslateChild().proc.send({ type: 'preheat' });
  }
});

// ⌘Q / 菜单退出 / Dock 退出：有未归档内容时先确认，确认后再走正常退出。
app.on('before-quit', (event) => {
  if (leaveConfirmed || !hasUnsavedContent()) return;
  event.preventDefault();
  void confirmLeave().then((ok) => {
    if (!ok) return;
    leaveConfirmed = true;
    app.quit();
  });
});

app.on('will-quit', () => displaySleep.stop());

app.on('window-all-closed', () => {
  asrChild?.kill();
  translateChild?.proc.kill();
  app.quit();
});
