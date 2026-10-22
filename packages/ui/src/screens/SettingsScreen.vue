<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { NButton, NFormItem, NSelect, NSwitch, NTooltip } from 'naive-ui';
import { ArrowLeft } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import { UI_LANGS, asrModelsFor, getAsrModel, getTranslationModel, DEFAULT_ASR_MODEL_ID, DEFAULT_TRANSLATION_MODEL_ID } from '@rt/core';
import { settings, saveSettings, pendingSettingsSave, alwaysOnTopSupported, setAlwaysOnTop } from '../composables/useSettings';
import { bridge } from '../bridge';
import { LANG_LABELS, type SettingsFormData } from '../components/settings/form';
import { humanBytes } from '../utils/bytes';
import GeneralSection from '../components/settings/GeneralSection.vue';
import TranslationSection from '../components/settings/TranslationSection.vue';
import ModelsSection from '../components/settings/ModelsSection.vue';
import ModelDownloadModal from '../components/ModelDownloadModal.vue';
import { missingTranslationDownload } from '../composables/translationDownload';
import { type DownloadTask, startDownloads } from '../composables/useModelDownloads';

const { t } = useI18n();
const emit = defineEmits<{ close: [] }>();

// 发布版本串（构建期注入的包版本+commit 短哈希）；宿主未提供则不展示
const appVersion = bridge().appVersion;
// 置顶开关：宿主不支持（Web / iOS）时不显示
const canPin = alwaysOnTopSupported();

const current = settings.value!;
const currentEngine = current.translation.engine;
const form = reactive<SettingsFormData>({
  nativeLang: current.nativeLang,
  targetLang: current.translation.targetLang ?? current.nativeLang,
  fontSize: current.fontSize,
  theme: current.theme,
  asr: { ...current.asr },
  // 三态：未开启翻译 → 无；云端引擎 → 云端；其余本地引擎 → 本地模型（主页无独立开关，选方式即开启）。
  translationMode: !current.translation.enabled ? 'none' : currentEngine === 'cloud' ? 'cloud' : 'local',
  // 本地模型：持久化引擎为注册表内本地模型 id 则沿用，否则（云端/未知）落默认本地模型。
  translationModel:
    currentEngine !== 'cloud' && getTranslationModel(currentEngine)
      ? currentEngine
      : DEFAULT_TRANSLATION_MODEL_ID,
  cloud: { ...current.translation.cloud },
  announceCaptions: current.announceCaptions,
});

const languageOptions = UI_LANGS.map((value) => ({ label: LANG_LABELS[value], value }));
const asrLanguageOptions = computed(() => [
  { label: t('settings.asrLanguageAuto'), value: 'auto' }, ...languageOptions,
]);
const asrModelOptions = computed(() => asrModelsFor(form.asr.language, bridge().platform).map((model) => ({
  label: `${t(model.nameKey)} (${humanBytes(model.approxBytes)})`, value: model.id,
})));
watch(() => form.asr.language, (language) => {
  if (!asrModelsFor(language, bridge().platform).some((model) => model.id === form.asr.model)) {
    form.asr.model = DEFAULT_ASR_MODEL_ID;
  }
});

// 本地翻译模型未缓存时的就地下载弹窗
const downloadModalOpen = ref(false);
const downloadTasks = ref<DownloadTask[]>([]);

// Compare against the form's last submission, not live settings changed by other controls.
let submitted = JSON.parse(JSON.stringify(form));
function changedFields(next: Record<string, any>, before: Record<string, any>): Record<string, any> {
  const patch: Record<string, any> = {};
  for (const key of Object.keys(next)) {
    if (JSON.stringify(next[key]) === JSON.stringify(before[key])) continue;
    patch[key] = next[key] && typeof next[key] === 'object'
      ? changedFields(next[key], before[key] ?? {}) : next[key];
  }
  return patch;
}
function persist(): Promise<unknown> {
  const snapshot = JSON.parse(JSON.stringify(form));
  const changed = changedFields(snapshot, submitted);
  submitted = snapshot;
  const { translationMode, translationModel, targetLang, cloud, ...patch } = changed;
  const translation: Record<string, any> = {};
  if (targetLang !== undefined) translation.targetLang = targetLang;
  if (translationMode !== undefined || translationModel !== undefined) {
    translation.enabled = snapshot.translationMode !== 'none';
    if (snapshot.translationMode !== 'none') {
      translation.engine = snapshot.translationMode === 'cloud' ? 'cloud' : snapshot.translationModel;
    }
  }
  if (cloud) translation.cloud = cloud;
  return saveSettings({ ...patch, ...(Object.keys(translation).length ? { translation } : {}) })
    .catch((err) => console.error('[settings:save]', err));
}

// 保存通道 a：选择器类字段变化即刻落盘（含即时的语言/字体/主题预览）。
watch(
  [
    () => form.nativeLang,
    () => form.targetLang,
    () => form.fontSize,
    () => form.theme,
    () => form.announceCaptions,
    () => form.asr.language,
    () => form.asr.model,
    () => form.translationMode,
    () => form.translationModel,
  ],
  () => {
    void persist();
  },
);

// 保存通道 b：云端三个文本字段（Base URL / 模型 / API Key）连续输入时防抖 500ms 再落盘。
let cloudTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => form.cloud,
  () => {
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(() => void persist(), 500);
  },
  { deep: true },
);

// 选择即触发下载确认（识别模型 / 本地翻译引擎一致）：设置值本身已经保存通道 a 落盘，
// 弹窗只负责「顺手下载」；取消不回退任何设置，缺失的模型留到点击录音时再按需下载。
// 打开前先 await 保存链，确保本次变更已落盘再查就绪状态（保存通道 a 的 watch 声明在前，
// await 到的正是那次保存）；弹窗已在展示（含下载中）时不打断、不覆盖任务。
function offerDownload(tasks: DownloadTask[]): void {
  if (downloadModalOpen.value || tasks.length === 0) return;
  downloadTasks.value = tasks;
  downloadModalOpen.value = true;
}

// 切到本地方式、或本地方式下切换模型时，检查该本地模型是否就绪、未就绪则弹下载确认。
// 任务的 nameKey/sizeBytes 取自所选 spec；平台无对应本地模型（如 iOS 系统翻译）则跳过。
watch(
  [() => form.translationMode, () => form.translationModel],
  async ([mode]) => {
    if (mode !== 'local') return;
    const spec = getTranslationModel(form.translationModel);
    if (!spec) return;
    await pendingSettingsSave();
    try {
      const tasks = await missingTranslationDownload(spec.id);
      if (form.translationMode === 'local' && form.translationModel === spec.id) offerDownload(tasks);
    } catch {
      /* 查询失败：留到点击录音时按需下载 */
    }
  },
);

watch(
  () => form.asr.model,
  async (modelId) => {
    await pendingSettingsSave();
    try {
      const { asrReady } = await bridge().getSetupStatus(modelId);
      if (asrReady) return;
      const spec = getAsrModel(modelId);
      if (!spec) return;
      offerDownload([
        { kind: 'asr', modelId: spec.id, nameKey: spec.nameKey, sizeBytes: spec.approxBytes },
      ]);
    } catch {
      /* 查询失败：不弹窗；缺模型会在点击录音时按需下载 */
    }
  },
);

// 确认下载 → 转后台下载（设置早已生效，不离开设置页；进度/取消在所选模型下方呈现）
function onDownloadConfirm(tasks: DownloadTask[]): void {
  startDownloads(tasks);
}
</script>

<template>
  <div class="flex h-full flex-col">
    <header
      class="flex items-center gap-3 border-b border-neutral-200 px-[18px] py-3 dark:border-[#3a3b44]"
    >
      <n-tooltip>
        <template #trigger>
          <n-button quaternary circle :aria-label="t('settings.back')" @click="emit('close')">
            <template #icon><ArrowLeft :size="18" /></template>
          </n-button>
        </template>
        {{ t('settings.back') }}
      </n-tooltip>
      <span class="text-[15px] font-semibold">{{ t('settings.title') }}</span>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-[720px] px-5 py-6 sm:px-8">
        <div class="grid gap-x-6 sm:grid-cols-2">
          <n-form-item :label="t('settings.asrLanguage')">
            <n-select v-model:value="form.asr.language" :options="asrLanguageOptions" />
          </n-form-item>
          <n-form-item :label="t('settings.targetLang')">
            <n-select v-model:value="form.targetLang" :options="languageOptions" />
          </n-form-item>
        </div>

        <section class="mb-6 border-b border-neutral-200 pb-5 dark:border-[#3a3b44]">
          <n-form-item :label="t('settings.asrModel')" :show-feedback="false">
            <n-select v-model:value="form.asr.model" :options="asrModelOptions" />
          </n-form-item>
          <models-section kind="asr" :selected-id="form.asr.model" compact />
        </section>
        <section class="mb-6 border-b border-neutral-200 pb-5 dark:border-[#3a3b44]">
          <translation-section :form="form" />
          <models-section v-if="form.translationMode === 'local'" kind="translation" :selected-id="form.translationModel" compact />
        </section>

        <details class="mb-5">
          <summary class="cursor-pointer py-2 text-sm font-medium">{{ t('settings.appearance') }}</summary>
          <div class="pt-4">
            <general-section :form="form" />
            <n-form-item :label="t('settings.announceCaptions')" :show-feedback="false">
              <n-switch v-model:value="form.announceCaptions" />
            </n-form-item>
            <p class="mt-1.5 text-xs text-[var(--rt-ink-3)]">{{ t('settings.announceCaptionsHint') }}</p>
            <n-form-item v-if="canPin" class="mt-6" :label="t('settings.alwaysOnTop')" :show-feedback="false">
              <n-switch :value="settings?.alwaysOnTop ?? false" @update:value="setAlwaysOnTop" />
            </n-form-item>
          </div>
        </details>
        <details>
          <summary class="cursor-pointer py-2 text-sm font-medium">{{ t('settings.modelManagement') }}</summary>
          <div class="pt-3"><models-section /></div>
        </details>
        <p v-if="appVersion" class="mt-8 text-xs text-[var(--rt-ink-3)] select-text">
          {{ t('settings.version') }} {{ appVersion }}
        </p>
      </div>
    </div>

    <!-- 选择识别模型/本地翻译引擎时的就地下载：确认后转后台下载（进度在所选模型下方呈现）；
         取消不回退设置（值已落盘），缺失模型留到点击录音时再按需下载 -->
    <model-download-modal
      v-model:show="downloadModalOpen"
      :tasks="downloadTasks"
      @confirm="onDownloadConfirm"
    />
  </div>
</template>
