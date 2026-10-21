<script setup lang="ts">
import { computed, ref, h, watch, onUnmounted } from 'vue';
import { NButton, NModal, NInput, NDropdown, NTooltip, NProgress, NSelect } from 'naive-ui';
import type { DropdownMixedOption } from 'naive-ui/es/dropdown/src/interface';
import { Settings, Trash2, Archive, Library, Eraser, LoaderCircle, TriangleAlert, MoreHorizontal, Mic, MonitorSpeaker, Square, RefreshCw, X } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import { getAsrModel, getTranslationModel, UI_LANGS, asrModelsFor, DEFAULT_ASR_MODEL_ID, type AsrLang, suggestArchiveTitle, type ArchiveLibrary } from '@rt/core';
import { LANG_LABELS } from '../components/settings/form';
import { settings, saveSettings } from '../composables/useSettings';
import {
  lines, archiveSnapshot,
  partial,
  stablePartial,
  draftLine,
  recording,
  modelLoading,
  errorText,
  errorCode,
  recordBusy,
  toggleRecording,
  clearTranscript,
  deleteTranscript,
  undoDelete,
  dismissUndo,
  canUndoDelete,
  translationLoading,
  translationError,
  translationErrorDetail,
  translationBackend,
  translationNotice,
} from '../composables/useTranscription';
import AudioLevelMeter from '../components/AudioLevelMeter.vue';
import TranscriptList from '../components/TranscriptList.vue';
import ModelDownloadModal from '../components/ModelDownloadModal.vue';
import {
  type DownloadTask,
  startDownloads,
  onDownloadDone,
  isDownloading,
  percentOf,
  downloadEntry,
} from '../composables/useModelDownloads';
import { fmtDateTime } from '../utils/datetime';
import { bridge } from '../bridge';

const { t } = useI18n();
const emit = defineEmits<{ 'open-settings': []; 'open-archive': [] }>();

declare const __INTERNAL_BUILD__: boolean;
const internalBuild = typeof __INTERNAL_BUILD__ !== 'undefined' && __INTERNAL_BUILD__;
const languageSaving = ref(false);
const primaryLanguageOptions = computed(() => [
  { label: t('settings.asrLanguageAuto'), value: 'auto' },
  ...UI_LANGS.map((lang) => ({ label: LANG_LABELS[lang], value: lang })),
]);
async function selectPrimaryLanguage(language: AsrLang): Promise<void> {
  const current = settings.value;
  if (!current || headerLocked.value || current.asr.language === language) return;
  languageSaving.value = true;
  try {
    const compatible = asrModelsFor(language, bridge().platform).some((model) => model.id === current.asr.model);
    await saveSettings({ ...current, asr: { language, model: compatible ? current.asr.model : DEFAULT_ASR_MODEL_ID } });
  } catch (error) {
    console.error('[settings:primary-language]', error);
  } finally {
    languageSaving.value = false;
  }
}

// 仅已定稿记录才算"有内容可清"：实时 partial 是瞬时的，清它没意义（归档也只存 lines）
const hasContent = computed(() => lines.length > 0);

// 清屏按钮：点击弹下拉，选择归档或删除
const clearOptions = computed(() => [
  { key: 'archive', label: t('main.archive'), icon: () => h(Archive, { size: 16 }) },
  { key: 'delete', label: t('archive.delete'), icon: () => h(Trash2, { size: 16 }) },
]);

function onClearSelect(key: string): void {
  if (key === 'delete') {
    deleteTranscript();
  } else {
    void openArchiveModal();
  }
}

const archiveModalOpen = ref(false);
const archiveName = ref('');
const archiveSaving = ref(false);
const archiveError = ref('');
const archiveFolder = ref<string | null>(null);
const archiveLibrary = ref<ArchiveLibrary>({ folders: [], lastFolderId: null });
const foldersEnabled = internalBuild && !!bridge().getArchiveLibrary;
const archiveFolderOptions = computed(() => [{ label: t('archive.unfiled'), value: '' }, ...archiveLibrary.value.folders.map((f) => ({ label: f.name, value: f.id }))]);

function defaultArchiveName(): string {
  return fmtDateTime(Date.now());
}

async function openArchiveModal(): Promise<void> {
  // 生成不与现有重复的默认名
  archiveError.value = '';
  if (foldersEnabled) {
    try {
      archiveLibrary.value = await bridge().getArchiveLibrary!();
      archiveFolder.value = archiveLibrary.value.lastFolderId;
    } catch (error) {
      errorText.value = t('archive.operationFailed');
      console.error('[archive:library]', error);
      return;
    }
  }
  let name = foldersEnabled ? suggestArchiveTitle(archiveSnapshot(), defaultArchiveName()) : defaultArchiveName();
  try {
    const names = new Set((await bridge().listArchives()).map((a) => a.name));
    if (names.has(name)) {
      let i = 2;
      while (names.has(`${name} (${i})`)) i += 1;
      name = `${name} (${i})`;
    }
  } catch {
    /* 取不到列表就用默认名 */
  }
  archiveName.value = name;
  archiveModalOpen.value = true;
}

async function confirmArchive(): Promise<void> {
  if (archiveSaving.value) return;
  archiveSaving.value = true;
  archiveError.value = '';
  try {
    const snapshot = archiveSnapshot();
    await bridge().saveArchive(archiveName.value.trim() || defaultArchiveName(), snapshot, foldersEnabled ? archiveFolder.value : undefined);
    clearTranscript();
    archiveModalOpen.value = false;
  } catch (error) {
    archiveError.value = t('archive.operationFailed');
    console.error('[archive:save]', error);
  } finally {
    archiveSaving.value = false;
  }
}

// 未归档提示：停止后主页仍有定稿行即视为未保存（归档成功会清空主页），录音中不打扰。
const showUnsaved = computed(() => hasContent.value && !recording.value && !recordBusy.value);

// 关闭保护：正在录音或有未归档内容时，关窗 / 退出 / 离开页面前要求确认。
watch(
  () => [recording.value || recordBusy.value, hasContent.value, t('main.closeConfirm')] as const,
  ([live, content]) => {
    bridge().setCloseGuard?.(live || content ? {
      message: t(live ? 'main.closeRecording' : 'main.closeUnsaved'),
      detail: t('main.closeDetail'),
      confirm: t('main.closeConfirm'),
      cancel: t('main.closeCancel'),
    } : null);
  },
  { immediate: true },
);

// 是否开启翻译：现由设置里的「翻译方式」决定（选了模型即启用），主页不再有独立开关。
// 仍需此值让转写列表决定是否显示「翻译中」等待动画。
const translateOn = computed<boolean>(() => settings.value?.translation.enabled ?? false);
const windowsHost = bridge().platform === 'windows';

// 错误显示：有稳定错误码时用本地化文案，无码回退宿主原文（自由文本，可能非界面语言）
const errorDisplay = computed(() =>
  errorCode.value ? t(`errors.${errorCode.value}`) : errorText.value,
);

// 强制更新入口仅在桥接提供该能力时显示（目前只有 Web PWA 实现，原生端无此项）。
// setup 时 bridge 已由 mountApp 注入，可同步判定。
const canForceUpdate = typeof bridge().forceUpdateApp === 'function';

// 顶栏内联的模型加载状态：识别/翻译的加载收敛到同一处（不插入内容行、零布局位移）。
// 多项同时加载时顶栏只显示合并文案，具体项放 tooltip。
const loadingItems = computed<string[]>(() => {
  const items: string[] = [];
  if (modelLoading.value) items.push(t('status.loadingModel'));
  // 翻译引擎装载中（下载进度另在下载弹窗展示，此处只表达装载入内存）。
  if (translateOn.value && translationLoading.value) items.push(t('status.transLoading'));
  return items;
});
const loadingSummary = computed(() =>
  loadingItems.value.length > 1 ? t('status.preparing') : (loadingItems.value[0] ?? ''),
);

// 录音进行中（含启停在途）：顶栏除录音按钮外全部禁用，避免录音过程中误操作打断会话
const headerLocked = computed(() => recording.value || recordBusy.value || languageSaving.value || archiveSaving.value);

// 音源开关：仅当桥接声明支持系统音频时才显示（macOS）。切换即持久化。
const supportsSystemAudio = bridge().audioSources?.includes('system') ?? false;
const audioSourceTitle = computed(() =>
  settings.value?.audioSource === 'system' ? t('main.audioSourceSystem') : t('main.audioSourceMic'),
);
function toggleAudioSource(): void {
  const s = settings.value;
  if (!s || headerLocked.value) return;
  void saveSettings({ ...s, audioSource: s.audioSource === 'system' ? 'mic' : 'system' });
}

// 移动端「...」溢出菜单（翻译开/关已移至设置的「翻译方式」，此处不再有翻译项）
const mobileMenuOptions = computed<DropdownMixedOption[]>(() => [
  ...(supportsSystemAudio
    ? ([
        {
          key: 'audio-source',
          label: audioSourceTitle.value,
          icon: () => h(settings.value?.audioSource === 'system' ? MonitorSpeaker : Mic, { size: 16 }),
          disabled: headerLocked.value,
        },
        { type: 'divider', key: 'd0' },
      ] satisfies DropdownMixedOption[])
    : []),
  { key: 'delete', label: t('archive.delete'), icon: () => h(Trash2, { size: 16 }), disabled: !hasContent.value },
  { key: 'archive', label: t('main.archive'), icon: () => h(Archive, { size: 16 }), disabled: !hasContent.value },
  { type: 'divider', key: 'd3' },
  { key: 'view-archive', label: t('main.viewArchives'), icon: () => h(Library, { size: 16 }) },
  { key: 'settings', label: t('main.settings'), icon: () => h(Settings, { size: 16 }) },
  ...(canForceUpdate
    ? ([
        { type: 'divider', key: 'd4' },
        { key: 'force-update', label: t('main.forceUpdate'), icon: () => h(RefreshCw, { size: 16 }) },
      ] satisfies DropdownMixedOption[])
    : []),
]);

function onMobileMenuSelect(key: string): void {
  switch (key) {
    case 'audio-source':
      toggleAudioSource();
      break;
    case 'archive':
      void openArchiveModal();
      break;
    case 'delete':
      deleteTranscript();
      break;
    case 'view-archive':
      emit('open-archive');
      break;
    case 'settings':
      emit('open-settings');
      break;
    case 'force-update':
      // 注销 SW、清应用外壳缓存并整页重载（模型缓存保留），随后页面即以最新资源启动。
      void bridge().forceUpdateApp?.();
      break;
  }
}

// 仅 ASR 模型加载属于"软件未就绪"：显示进度条并禁用录音。
// 翻译模型加载/下载是可选项，只在翻译开关旁提示，不挡录音。
const preparing = computed(() => modelLoading.value);

// 麦克风权限弹窗：''=不显示；'ask'=首次说明；'denied'=已拒绝去设置
const micModal = ref<'' | 'ask' | 'denied'>('');
const showMicModal = computed({
  get: () => micModal.value !== '',
  set: (v: boolean) => {
    if (!v) micModal.value = '';
  },
});

// 按需下载：确认弹窗仅征询体积，确认后转后台下载；主屏进「等待下载」态显示进度、可终止本次录音
// （下载后台继续）；所等模型全部下完自动开始录音。
const downloadModalOpen = ref(false);
const downloadTasks = ref<DownloadTask[]>([]); // 确认弹窗里展示 + 待启动的新下载任务
const pendingTasks = ref<DownloadTask[]>([]); // 本次录音要等待的全部缺失模型（含已在后台下的）

// 等待下载态：用户点了录音、模型正在（后台）下载，主屏显示进度并可终止本次录音。
const awaitingRecord = ref(false);
let offAwaitDone: (() => void) | null = null;

// 汇总当前设置下录音所需但未就绪的模型下载任务。
async function collectMissingTasks(): Promise<DownloadTask[]> {
  const s = settings.value;
  if (!s) return [];
  const tasks: DownloadTask[] = [];
  try {
    const { asrReady } = await bridge().getSetupStatus(s.asr.model);
    if (!asrReady) {
      const spec = getAsrModel(s.asr.model);
      if (spec) tasks.push({ kind: 'asr', modelId: spec.id, nameKey: spec.nameKey, sizeBytes: spec.approxBytes });
    }
  } catch {
    /* 查询失败不拦截，按已就绪继续 */
  }
  const getTrStatus = bridge().getTranslationSetupStatus;
  const trSpec = s.translation.engine !== 'cloud' ? getTranslationModel(s.translation.engine) : undefined;
  if (s.translation.enabled && trSpec && getTrStatus && bridge().downloadTranslationModel) {
    try {
      const { ready } = await getTrStatus(trSpec.id);
      if (!ready) tasks.push({ kind: 'translation', modelId: trSpec.id, nameKey: trSpec.nameKey, sizeBytes: trSpec.approxDownloadBytes });
    } catch {
      /* 查询失败不拦截，按已就绪继续 */
    }
  }
  return tasks;
}

// 录音按钮：等待下载中→终止本次录音（下载后台续）；录音中→停止；否则汇总缺失模型（有则先下）。
async function onRecordClick(): Promise<void> {
  if (recordBusy.value || awaitingRecord.value) return; // 等待态由进度模态承载，按钮此时不响应
  if (recording.value) {
    toggleRecording();
    return;
  }
  const tasks = await collectMissingTasks();
  if (!tasks.length) {
    await proceedToRecord();
    return;
  }
  // 已在后台下载的不必再确认；仅未开始的需弹确认窗。全部已在下 → 直接进等待（进度模态）。
  const toStart = tasks.filter((tk) => !isDownloading(tk.kind, tk.modelId));
  if (toStart.length) {
    pendingTasks.value = tasks;
    downloadTasks.value = toStart;
    downloadModalOpen.value = true;
    return;
  }
  beginAwait(tasks);
}

// 确认后台下载：启动新任务并进入等待态（等全部所需模型下完自动录音）。
function onDownloadConfirm(toStart: DownloadTask[]): void {
  startDownloads(toStart);
  beginAwait(pendingTasks.value.length ? pendingTasks.value : toStart);
}

// 进入等待态：订阅所等任务的完成——全部成功→自动开始录音；任一失败→退出等待并提示。
function beginAwait(tasks: DownloadTask[]): void {
  const remaining = new Set(tasks.map((tk) => `${tk.kind}:${tk.modelId}`));
  pendingTasks.value = tasks; // 进度模态据此列出所等模型（含「已在后台下」直接进等待的路径）
  awaitingRecord.value = true;
  offAwaitDone?.();
  offAwaitDone = onDownloadDone((task, ok) => {
    if (!awaitingRecord.value) return;
    const k = `${task.kind}:${task.modelId}`;
    if (!remaining.has(k)) return;
    if (!ok) {
      // 失败或被取消：退出等待，提示下载失败（用户可到模型管理重试）。
      stopAwait();
      errorText.value = t('download.failed');
      errorCode.value = null;
      return;
    }
    remaining.delete(k);
    if (remaining.size === 0) {
      stopAwait();
      void proceedToRecord();
    }
  });
}

// 退出等待态（不影响后台下载）。
function stopAwait(): void {
  awaitingRecord.value = false;
  pendingTasks.value = [];
  offAwaitDone?.();
  offAwaitDone = null;
}

// 切屏卸载时反注册等待订阅，避免后台下载完成误触发已离开的录音等待。
onUnmounted(() => offAwaitDone?.());

// 进度模态里每个所等模型的进度：下载中取实时百分比，已下完（仍在等其它模型）显示 100%。
function awaitTaskName(task: DownloadTask): string {
  const spec = task.kind === 'asr' ? getAsrModel(task.modelId) : getTranslationModel(task.modelId);
  return spec ? t(spec.nameKey) : task.modelId;
}
function awaitTaskPercent(task: DownloadTask): number {
  return isDownloading(task.kind, task.modelId) ? percentOf(task.kind, task.modelId) : 100;
}
function awaitTaskIndeterminate(task: DownloadTask): boolean {
  return (
    isDownloading(task.kind, task.modelId) &&
    (downloadEntry(task.kind, task.modelId)?.total ?? 0) === 0
  );
}

// 系统音频权限说明弹窗：CoreAudio Tap 无权限查询 API，无法像麦克风那样按状态分流——
// 「首次说明」用本地持久化标记补齐（本机只提示一次），「已拒绝去设置」在采集报
// system-audio-permission 错误码时事后弹出。
const SYS_AUDIO_PROMPTED_KEY = 'rt.systemAudioPrompted';
const sysAudioModal = ref<'' | 'ask' | 'denied'>('');
const showSysAudioModal = computed({
  get: () => sysAudioModal.value !== '',
  set: (v: boolean) => {
    if (!v) sysAudioModal.value = '';
  },
});
watch(errorCode, (code) => {
  if (code === 'system-audio-permission') sysAudioModal.value = 'denied';
  if (code === 'mic-permission') micModal.value = 'denied';
});

function confirmSysAudio(): void {
  localStorage.setItem(SYS_AUDIO_PROMPTED_KEY, '1');
  sysAudioModal.value = '';
  toggleRecording(); // 此时才触发系统音频录制的系统授权
}

function openSysAudioSettings(): void {
  bridge().openSystemAudioSettings?.();
  sysAudioModal.value = '';
}

// 模型就绪后的权限 + 启动流程。麦克风音源走权限说明流程；系统音源首次先弹说明，
// 之后直接启动（授权由宿主处理，被拒会以 system-audio-permission 错误码回来）。
async function proceedToRecord(): Promise<void> {
  const usesSystem = supportsSystemAudio && settings.value?.audioSource === 'system';
  if (usesSystem) {
    if (!localStorage.getItem(SYS_AUDIO_PROMPTED_KEY)) {
      sysAudioModal.value = 'ask';
      return;
    }
    toggleRecording();
    return;
  }
  let status = 'granted';
  try {
    status = await bridge().getMicStatus();
  } catch {
    /* 查询失败按已授权处理，让系统弹窗兜底 */
  }
  if (status === 'granted') {
    toggleRecording();
  } else if (status === 'denied' || status === 'restricted') {
    micModal.value = 'denied';
  } else {
    micModal.value = 'ask';
  }
}

function confirmMic(): void {
  micModal.value = '';
  toggleRecording(); // 此时才触发系统权限请求
}

function openMicSettings(): void {
  bridge().openMicSettings();
  micModal.value = '';
}
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="app-header">
      <span v-if="errorText" class="min-w-0 truncate text-xs text-[var(--rt-live)]">{{ errorDisplay }}</span>

      <div class="flex-1" />

      <!-- 停止后仍有未归档内容：常驻提示，点击直接打开归档弹窗 -->
      <button v-if="showUnsaved" type="button" class="unsaved-btn" @click="openArchiveModal">
        <span class="unsaved-dot" aria-hidden="true" />{{ t('main.unsaved') }}
      </button>

      <!-- 模型加载状态：顶栏内联，转圈图标 + 文案；hover 看具体加载项 -->
      <n-tooltip v-if="loadingItems.length">
        <template #trigger>
          <div class="flex items-center gap-2 text-xs text-[var(--rt-ink-3)]">
            <LoaderCircle :size="14" class="animate-spin" />
            <span>{{ loadingSummary }}</span>
          </div>
        </template>
        <div v-for="item in loadingItems" :key="item">{{ item }}</div>
      </n-tooltip>
      <!-- 翻译引擎级错误：同一位置收敛为红色警示图标（行级失败仍在对应行内展示） -->
      <n-tooltip v-else-if="translateOn && translationError">
        <template #trigger>
          <TriangleAlert :size="14" class="text-[var(--rt-live)]" />
        </template>
        {{ translationErrorDetail || t('status.transFailed') }}
      </n-tooltip>
      <n-tooltip v-else-if="windowsHost && translateOn && translationBackend">
        <template #trigger>
          <span class="text-xs text-[var(--rt-ink-3)]">
            {{ t(translationBackend === 'cuda' ? 'status.localCuda' : 'status.localCpu') }}
          </span>
        </template>
        {{ translationNotice || t('status.localPrivate') }}
      </n-tooltip>

      <!-- 窄屏隐藏，改用下方「...」菜单与底部圆形录音按钮 -->
      <div class="flex items-center gap-3 max-sm:hidden">
        <!-- 次要操作收进一组图标，和主操作（电平 / 语言 / 录音）之间用细分隔线拉开层级 -->
        <div class="tool-group">
          <!-- NDropdown 无 disabled 属性：无内容或录音锁定时直接渲染禁用按钮，避免仍能弹出菜单 -->
          <n-dropdown v-if="hasContent && !headerLocked" trigger="hover" :options="clearOptions" @select="onClearSelect">
            <n-button quaternary circle size="small" :aria-label="t('main.clear')">
              <template #icon><Eraser :size="17" /></template>
            </n-button>
          </n-dropdown>
          <n-button v-else quaternary circle size="small" disabled :aria-label="t('main.clear')">
            <template #icon><Eraser :size="17" /></template>
          </n-button>
          <n-tooltip>
            <template #trigger>
              <n-button quaternary circle size="small" :disabled="headerLocked" :aria-label="t('main.viewArchives')" @click="$emit('open-archive')">
                <template #icon><Library :size="17" /></template>
              </n-button>
            </template>
            {{ t('main.viewArchives') }}
          </n-tooltip>
          <n-tooltip>
            <template #trigger>
              <n-button quaternary circle size="small" :disabled="headerLocked" :aria-label="t('main.settings')" @click="$emit('open-settings')">
                <template #icon><Settings :size="17" /></template>
              </n-button>
            </template>
            {{ t('main.settings') }}
          </n-tooltip>
          <!-- 音源开关：仅桥接支持系统音频时显示，图标即当前音源，点击切换 -->
          <n-tooltip v-if="supportsSystemAudio">
            <template #trigger>
              <n-button
                quaternary
                circle
                size="small"
                :disabled="headerLocked"
                :aria-label="audioSourceTitle"
                @click="toggleAudioSource"
              >
                <template #icon>
                  <component :is="settings?.audioSource === 'system' ? MonitorSpeaker : Mic" :size="17" />
                </template>
              </n-button>
            </template>
            {{ audioSourceTitle }}
          </n-tooltip>
        </div>
        <span class="header-divider" aria-hidden="true" />
        <AudioLevelMeter :active="recording" />
        <n-select
          v-if="internalBuild && settings"
          class="w-[168px]"
          size="small"
          :aria-label="t('main.primaryLanguage')"
          :value="settings.asr.language"
          :options="primaryLanguageOptions"
          :disabled="headerLocked || preparing || awaitingRecord"
          @update:value="selectPrimaryLanguage"
        />
        <button
          type="button"
          class="record-btn"
          :class="{ 'is-live': recording }"
          :disabled="preparing || recordBusy || awaitingRecord || languageSaving"
          @click="onRecordClick"
        >
          <LoaderCircle v-if="recordBusy" :size="15" class="animate-spin" />
          <span v-else class="record-glyph" aria-hidden="true" />
          <span>{{ recording ? t('main.stop') : t('main.start') }}</span>
        </button>
      </div>

      <!-- sm:hidden 放在外层 div：Naive 运行时注入的 .n-button{display:inline-flex} 会盖过
           直接加在按钮上的 sm:hidden，故由普通 div 承载响应式隐藏（桌面 ≥640px 隐藏整组）。 -->
      <div class="sm:hidden">
        <!-- NDropdown 无 disabled 属性：录音锁定时直接渲染禁用按钮，避免仍能弹出菜单 -->
        <n-dropdown
          v-if="!headerLocked"
          trigger="click"
          placement="bottom-end"
          :options="mobileMenuOptions"
          @select="onMobileMenuSelect"
        >
          <n-button quaternary circle :aria-label="t('main.menu')">
            <template #icon><MoreHorizontal :size="20" /></template>
          </n-button>
        </n-dropdown>
        <n-button v-else quaternary circle disabled :aria-label="t('main.menu')">
          <template #icon><MoreHorizontal :size="20" /></template>
        </n-button>
      </div>
    </header>

    <transcript-list
      :lines="lines"
      :partial="partial"
      :stable-partial="stablePartial"
      :draft="draftLine"
      :recording="recording"
      :empty-hint="t('main.emptyHint')"
      :translate-on="translateOn"
      :source-lang="settings?.asr.language"
      :target-lang="settings?.nativeLang"
    />

    <!-- 删除后的撤销条：保留到撤销、关闭或下一次开始录音 -->
    <div v-if="canUndoDelete" class="undo-bar" role="status">
      <span>{{ t('main.deleted') }}</span>
      <button type="button" class="undo-action" @click="undoDelete">{{ t('main.undo') }}</button>
      <button type="button" class="undo-close" :aria-label="t('main.dismiss')" @click="dismissUndo">
        <X :size="14" />
      </button>
    </div>

    <!-- 归档命名弹窗 -->
    <n-modal
      v-model:show="archiveModalOpen"
      preset="card"
      :title="t('archive.modalTitle')"
      :mask-closable="!archiveSaving"
      :closable="!archiveSaving"
      :close-on-esc="!archiveSaving"
      style="width: 420px; max-width: 90vw"
    >
      <div class="mb-1.5 text-xs text-neutral-500 dark:text-neutral-400">{{ t('archive.nameLabel') }}</div>
      <n-input v-model:value="archiveName" autofocus :disabled="archiveSaving" :maxlength="120" @keydown.enter="confirmArchive" />
      <p v-if="foldersEnabled" class="mt-1 text-xs text-neutral-400">{{ t('archive.autoTitle') }}</p>
      <template v-if="foldersEnabled">
        <div class="mb-1.5 mt-4 text-xs text-neutral-500">{{ t('archive.folder') }}</div>
        <n-select :value="archiveFolder ?? ''" :options="archiveFolderOptions" :disabled="archiveSaving" :aria-label="t('archive.folder')" @update:value="archiveFolder = $event || null" />
      </template>
      <p v-if="archiveError" role="alert" class="mt-2 text-sm text-red-500">{{ archiveError }}</p>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button :disabled="archiveSaving" @click="archiveModalOpen = false">{{ t('archive.cancel') }}</n-button>
          <n-button type="primary" :loading="archiveSaving" :disabled="archiveSaving" @click="confirmArchive">{{ t('archive.save') }}</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 麦克风权限说明弹窗：在触发系统授权前先告知用途 -->
    <n-modal
      v-model:show="showMicModal"
      preset="card"
      :title="micModal === 'denied' ? t('mic.deniedTitle') : t('mic.title')"
      style="width: 420px; max-width: 90vw"
    >
      <p class="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
        {{ micModal === 'denied' ? t(windowsHost ? 'mic.windowsDeniedDesc' : 'mic.deniedDesc') : t('mic.desc') }}
      </p>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="micModal = ''">{{ t('mic.cancel') }}</n-button>
          <n-button v-if="micModal === 'denied'" type="primary" @click="openMicSettings">
            {{ t('mic.openSettings') }}
          </n-button>
          <n-button v-else type="primary" @click="confirmMic">{{ t('mic.allow') }}</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 系统音频权限弹窗：首次说明（本机一次）/ 被拒后引导去「屏幕与系统音频录制」设置 -->
    <n-modal
      v-model:show="showSysAudioModal"
      preset="card"
      :title="sysAudioModal === 'denied' ? t('sysAudio.deniedTitle') : t('sysAudio.title')"
      style="width: 420px; max-width: 90vw"
    >
      <p class="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
        {{ sysAudioModal === 'denied'
          ? t(windowsHost ? 'sysAudio.windowsDeniedDesc' : 'sysAudio.deniedDesc')
          : t(windowsHost ? 'sysAudio.windowsDesc' : 'sysAudio.desc') }}
      </p>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="sysAudioModal = ''">{{ t('mic.cancel') }}</n-button>
          <n-button v-if="sysAudioModal === 'denied'" type="primary" @click="openSysAudioSettings">
            {{ t('mic.openSettings') }}
          </n-button>
          <n-button v-else type="primary" @click="confirmSysAudio">{{ t('mic.allow') }}</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 录音前的按需模型下载确认弹窗：确认后转后台下载 + 进等待态，取消则不录音 -->
    <model-download-modal
      v-model:show="downloadModalOpen"
      :tasks="downloadTasks"
      @confirm="onDownloadConfirm"
    />

    <!-- 录音等待下载：进度模态，展示所等模型各自进度；可取消本次录音（下载后台继续）；下完自动开始录音 -->
    <n-modal
      :show="awaitingRecord"
      preset="card"
      :title="t('download.titleDownloading')"
      style="width: 460px; max-width: 90vw"
      :closable="false"
      :mask-closable="false"
      :close-on-esc="false"
    >
      <p class="mb-3 text-sm text-neutral-500 dark:text-neutral-400">{{ t('download.recordWaitDesc') }}</p>
      <div v-for="task in pendingTasks" :key="`${task.kind}:${task.modelId}`" class="mb-3">
        <div class="mb-1 flex items-center justify-between gap-2 text-sm">
          <span class="min-w-0 truncate">{{ awaitTaskName(task) }}</span>
          <span
            v-if="!awaitTaskIndeterminate(task)"
            class="shrink-0 tabular-nums text-neutral-500 dark:text-neutral-400"
          >{{ awaitTaskPercent(task) }}%</span>
        </div>
        <n-progress
          type="line"
          :percentage="awaitTaskPercent(task)"
          :show-indicator="false"
          :height="8"
          :processing="awaitTaskIndeterminate(task)"
        />
      </div>
      <div class="mt-5 flex justify-end">
        <n-button @click="stopAwait">{{ t('download.cancelRecording') }}</n-button>
      </div>
    </n-modal>

    <!-- bottom 计入 safe-area，避开 Home 指示条 -->
    <n-tooltip>
      <template #trigger>
        <button
          class="fixed left-1/2 z-20 flex h-16 w-16 -translate-x-1/2 items-center justify-center rounded-full shadow-lg transition-colors disabled:opacity-40 sm:hidden"
          :class="recording ? 'bg-[var(--rt-live)] text-white' : 'bg-[var(--rt-ink)] text-[var(--rt-bg)]'"
          :style="{ bottom: 'calc(env(safe-area-inset-bottom) + 22px)' }"
          :disabled="preparing || recordBusy || awaitingRecord"
          :aria-label="recording ? t('main.stop') : t('main.start')"
          @click="onRecordClick"
        >
          <LoaderCircle v-if="recordBusy" :size="26" class="animate-spin" />
          <component v-else :is="recording ? Square : Mic" :size="26" :fill="recording ? 'currentColor' : 'none'" />
        </button>
      </template>
      {{ recording ? t('main.stop') : t('main.start') }}
    </n-tooltip>
  </div>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 56px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--rt-line);
}


.tool-group { display: flex; align-items: center; gap: 2px; }
.header-divider { width: 1px; height: 18px; background: var(--rt-line); }

/* 主操作：静止态为墨色实心按钮 + 红色录音圆点；录音中转为红底 + 方形停止符号 */
.record-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 14px 0 12px;
  border: 0;
  border-radius: 999px;
  font: inherit;
  font-size: 13px;
  font-weight: 550;
  white-space: nowrap;
  color: var(--rt-bg);
  background: var(--rt-ink);
  cursor: pointer;
  transition: background-color 0.25s var(--rt-ease), transform 0.12s ease, opacity 0.2s ease, box-shadow 0.25s ease;
}
.record-btn:hover:not(:disabled) { box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12); }
.record-btn:active:not(:disabled) { transform: scale(0.97); }
.record-btn:disabled { opacity: 0.4; cursor: default; }
.record-btn:focus-visible { outline: 2px solid var(--rt-accent); outline-offset: 2px; }
.record-glyph {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--rt-live);
  transition: border-radius 0.25s var(--rt-ease), background-color 0.25s ease;
}
.record-btn.is-live { color: #fff; background: var(--rt-live); }
.record-btn.is-live .record-glyph { border-radius: 2px; background: #fff; }

.unsaved-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--rt-line);
  border-radius: 999px;
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  color: var(--rt-ink-2);
  background: transparent;
  cursor: pointer;
}
.unsaved-btn:hover { color: var(--rt-ink); }
.unsaved-btn:focus-visible { outline: 2px solid var(--rt-accent); outline-offset: 2px; }
.unsaved-dot { width: 6px; height: 6px; border-radius: 50%; background: #e0a43a; }

.undo-bar {
  position: fixed;
  left: 50%;
  bottom: 24px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 8px 8px 16px;
  border-radius: 999px;
  font-size: 13px;
  white-space: nowrap;
  color: var(--rt-bg);
  background: var(--rt-ink);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  transform: translateX(-50%);
}
.undo-action { font: inherit; font-weight: 600; color: inherit; text-decoration: underline; text-underline-offset: 3px; background: none; border: 0; cursor: pointer; }
.undo-close { display: inline-flex; padding: 4px; border: 0; border-radius: 50%; color: inherit; background: none; opacity: 0.7; cursor: pointer; }
.undo-close:hover { opacity: 1; }

@media (max-width: 639px) {
  .app-header { min-height: 52px; padding: 8px 12px 8px 16px; }
  /* 避开底部圆形录音按钮 */
  .undo-bar { bottom: calc(env(safe-area-inset-bottom) + 100px); }
}
</style>
