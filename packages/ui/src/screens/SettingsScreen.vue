<script setup lang="ts">
import { computed, onUnmounted, reactive, watch } from 'vue';
import { NButton, NFormItem, NSelect, NSwitch, NTooltip } from 'naive-ui';
import { ArrowLeft } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import { UI_LANGS, asrModelsFor, getTranslationModel, DEFAULT_ASR_MODEL_ID, DEFAULT_TRANSLATION_MODEL_ID } from '@rt/core';
import { settings, saveSettings, alwaysOnTopSupported, setAlwaysOnTop } from '../composables/useSettings';
import { bridge } from '../bridge';
import { recording, recordBusy, modelLoading, toggleRecording } from '../composables/useTranscription';
import { onShortcutAction } from '../composables/useShortcuts';
import { recordingSettingsPatch } from '../components/settings/recording-settings';
import { LANG_LABELS, type SettingsFormData } from '../components/settings/form';
import GeneralSection from '../components/settings/GeneralSection.vue';
import TranslationSection from '../components/settings/TranslationSection.vue';
import ModelPicker from '../components/settings/ModelPicker.vue';
const { t } = useI18n();
const emit = defineEmits<{ close: [] }>();

// 发布版本串（构建期注入的包版本+commit 短哈希）；宿主未提供则不展示
const appVersion = bridge().appVersion;
// 置顶开关：宿主不支持（Web / iOS）时不显示
const canPin = alwaysOnTopSupported();
const pipelineLocked = computed(() => recording.value || recordBusy.value || modelLoading.value);
function stopCurrentRecording(): void {
  if (recording.value && !recordBusy.value) toggleRecording();
}
onUnmounted(onShortcutAction('toggleRecording', stopCurrentRecording));

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
  label: t(model.nameKey), value: model.id, modelId: model.id, sizeBytes: model.approxBytes,
})));
watch(() => form.asr.language, (language) => {
  if (!asrModelsFor(language, bridge().platform).some((model) => model.id === form.asr.model)) {
    form.asr.model = DEFAULT_ASR_MODEL_ID;
  }
});

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
  const safePatch = recordingSettingsPatch({ ...patch, ...(Object.keys(translation).length ? { translation } : {}) }, pipelineLocked.value);
  if (!Object.keys(safePatch).length) return Promise.resolve();
  return saveSettings(safePatch)
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
    if (!pipelineLocked.value) cloudTimer = setTimeout(() => { cloudTimer = undefined; void persist(); }, 500);
  },
  { deep: true },
);

watch(pipelineLocked, (locked) => {
  clearTimeout(cloudTimer);
  cloudTimer = undefined;
  if (!locked || !settings.value) return;
  const latest = settings.value;
  form.nativeLang = latest.nativeLang;
  form.targetLang = latest.translation.targetLang ?? latest.nativeLang;
  form.asr = { ...latest.asr };
  form.translationMode = !latest.translation.enabled ? 'none' : latest.translation.engine === 'cloud' ? 'cloud' : 'local';
  if (latest.translation.engine !== 'cloud') form.translationModel = latest.translation.engine;
  form.cloud = { ...latest.translation.cloud };
});
onUnmounted(() => {
  const pendingCloud = cloudTimer !== undefined;
  clearTimeout(cloudTimer);
  cloudTimer = undefined;
  if (pendingCloud && !pipelineLocked.value) void persist();
});
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
      <div v-if="recording" class="ml-auto flex items-center gap-3">
        <span role="status" class="text-xs text-[var(--rt-live)]">{{ t('settings.recordingStatus') }}</span>
        <n-button size="small" :disabled="recordBusy" @click="stopCurrentRecording">{{ t('main.stop') }}</n-button>
      </div>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-[720px] px-5 py-6 sm:px-8">
        <p v-if="pipelineLocked" role="status" class="mb-5 text-sm text-[var(--rt-ink-3)]">{{ t('settings.recordingLockHint') }}</p>
        <div class="grid gap-x-6 sm:grid-cols-2">
          <n-form-item :label="t('settings.asrLanguage')">
            <n-select v-model:value="form.asr.language" :disabled="pipelineLocked" :options="asrLanguageOptions" />
          </n-form-item>
          <n-form-item :label="t('settings.targetLang')">
            <n-select v-model:value="form.targetLang" :disabled="pipelineLocked" :options="languageOptions" />
          </n-form-item>
        </div>

        <section class="mb-6 border-b border-neutral-200 pb-5 dark:border-[#3a3b44]">
          <n-form-item :label="t('settings.asrModel')" :show-feedback="false">
            <model-picker v-model:value="form.asr.model" kind="asr" :disabled="pipelineLocked" :options="asrModelOptions" />
          </n-form-item>
        </section>
        <section class="mb-6 border-b border-neutral-200 pb-5 dark:border-[#3a3b44]">
          <translation-section :form="form" :disabled="pipelineLocked" />
        </section>

        <details class="mb-5">
          <summary class="cursor-pointer py-2 text-sm font-medium">{{ t('settings.appearance') }}</summary>
          <div class="pt-4">
            <general-section :form="form" :language-disabled="pipelineLocked" />
            <n-form-item :label="t('settings.announceCaptions')" :show-feedback="false">
              <n-switch v-model:value="form.announceCaptions" />
            </n-form-item>
            <p class="mt-1.5 text-xs text-[var(--rt-ink-3)]">{{ t('settings.announceCaptionsHint') }}</p>
            <n-form-item v-if="canPin" class="mt-6" :label="t('settings.alwaysOnTop')" :show-feedback="false">
              <n-switch :value="settings?.alwaysOnTop ?? false" @update:value="setAlwaysOnTop" />
            </n-form-item>
          </div>
        </details>
        <p v-if="appVersion" class="mt-8 text-xs text-[var(--rt-ink-3)] select-text">
          {{ t('settings.version') }} {{ appVersion }}
        </p>
      </div>
    </div>

  </div>
</template>
