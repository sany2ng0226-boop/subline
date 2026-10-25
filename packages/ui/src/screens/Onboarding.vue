<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { NButton, NFormItem, NSelect } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import {
  UI_LANGS,
  asrModelsFor,
  getAsrModel,
  translationModelsFor,
  DEFAULT_ASR_MODEL_ID,
  DEFAULT_TRANSLATION_MODEL_ID,
  type AsrLang,
} from '@rt/core';
import { settings, saveSettings, previewLocale, previewTheme, applyFontSize } from '../composables/useSettings';
import { type DownloadTask, startDownloads } from '../composables/useModelDownloads';
import GeneralSection from '../components/settings/GeneralSection.vue';
import { LANG_LABELS, type GeneralFormData } from '../components/settings/form';
import { humanBytes } from '../utils/bytes';
import { bridge } from '../bridge';

const { t } = useI18n();
const emit = defineEmits<{ done: [] }>();

const current = settings.value!;
const platform = bridge().platform;
const form = reactive<GeneralFormData>({
  nativeLang: current.nativeLang,
  fontSize: current.fontSize,
  theme: current.theme,
});

// 两步：① 母语 / 字号 / 主题；② 对方说话的语言、翻译成母语用哪个本机模型。
const step = ref<1 | 2>(1);

// 引导页在「开始」前不落盘，仅即时预览界面语言/主题/字体（自动保存通道只在设置页）。
watch(() => form.nativeLang, (v) => previewLocale(v));
watch(() => form.theme, (v) => previewTheme(v));
watch(() => form.fontSize, (v) => applyFontSize(v));

// —— 授课语言：选定语言后用该语言的专用模型（如日语 ReazonSpeech），没有专用模型时用默认多语种模型 ——
const asrLanguage = ref<AsrLang>(current.asr.language);
const asrLangOptions = computed(() => [
  { label: t('settings.asrLanguageAuto'), value: 'auto' },
  ...UI_LANGS.map((l) => ({ label: LANG_LABELS[l], value: l })),
]);
function recommendedAsrModel(language: AsrLang): string {
  const models = asrModelsFor(language, platform);
  if (language === current.asr.language && models.some((m) => m.id === current.asr.model)) return current.asr.model;
  return models.find((m) => m.languages.length === 1)?.id ?? DEFAULT_ASR_MODEL_ID;
}
const asrModel = computed(() => getAsrModel(recommendedAsrModel(asrLanguage.value)));

// —— 翻译成母语：不翻译 / 本机模型（标明体积）。云端需要填密钥，留到设置页 ——
const localAvailable = bridge().localTranslationAvailable !== false;
const translationOptions = computed(() => {
  if (!localAvailable) return [];
  const models = translationModelsFor(platform);
  const local = models.length
    ? models.map((m) => ({ label: `${t(m.nameKey)}（${humanBytes(m.approxDownloadBytes)}）`, value: m.id as string }))
    // 无可选权重模型（如 iOS 系统翻译）：只有一个「本机翻译」
    : [{ label: t('settings.engineLocal'), value: DEFAULT_TRANSLATION_MODEL_ID as string }];
  return [{ label: t('onboarding.noTranslation'), value: 'none' }, ...local];
});
const translation = ref<string>('none');

// 引导只自动下载识别模型；翻译模型留到用户确认后下载。
async function queueDownloads(asrId: string): Promise<void> {
  const tasks: DownloadTask[] = [];
  try {
    const spec = getAsrModel(asrId);
    if (spec && !(await bridge().getSetupStatus(asrId)).asrReady) {
      tasks.push({ kind: 'asr', modelId: spec.id, nameKey: spec.nameKey, sizeBytes: spec.approxBytes });
    }
  } catch {
    /* 查询失败：留到点录音时按需下载 */
  }
  startDownloads(tasks);
}

async function start(): Promise<void> {
  const asrId = recommendedAsrModel(asrLanguage.value);
  const enabled = translation.value !== 'none';
  const translationSettings = {
    ...current.translation,
    enabled,
    targetLang: form.nativeLang,
    engine: enabled ? translation.value as typeof current.translation.engine : current.translation.engine,
  };
  await saveSettings({
    onboarded: true,
    nativeLang: form.nativeLang,
    fontSize: form.fontSize,
    theme: form.theme,
    asr: { language: asrLanguage.value, model: asrId },
    translation: translationSettings,
  });
  void queueDownloads(asrId);
  emit('done');
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="flex min-h-full items-center justify-center p-6">
      <div class="w-full max-w-[460px]">
        <div class="mb-6 text-center">
          <h1 class="mb-2 text-[22px] font-semibold">{{ t('onboarding.title') }}</h1>
          <p class="text-[var(--rt-ink-2)]">{{ step === 1 ? t('onboarding.configure') : t('onboarding.languageHint') }}</p>
        </div>

        <general-section v-if="step === 1" :form="form" />

        <template v-else>
          <n-form-item :label="t('onboarding.classLanguage')">
            <n-select v-model:value="asrLanguage" :options="asrLangOptions" />
          </n-form-item>
          <p v-if="asrModel" class="-mt-3 mb-6 text-xs text-[var(--rt-ink-3)]">
            {{ t('onboarding.asrModelNote', { model: t(asrModel.nameKey), size: humanBytes(asrModel.approxBytes) }) }}
          </p>

          <template v-if="translationOptions.length">
            <n-form-item :label="t('onboarding.translateTo', { lang: LANG_LABELS[form.nativeLang] })">
              <n-select v-model:value="translation" :options="translationOptions" />
            </n-form-item>
            <p class="-mt-3 text-xs text-[var(--rt-ink-3)]">{{ t('onboarding.onDevice') }}</p>
          </template>
        </template>

        <!-- 间距放外层 div：Naive 注入的样式会盖过直接写在 n-button 上的工具类（同 MainScreen 的 sm:hidden 教训） -->
        <div class="mt-6">
          <n-button v-if="step === 1" type="primary" block size="large" @click="step = 2">
            {{ t('onboarding.next') }}
          </n-button>
          <template v-else>
            <n-button type="primary" block size="large" @click="start">
              {{ t('onboarding.start') }}
            </n-button>
            <div class="mt-3 text-center">
              <n-button text size="small" @click="step = 1">{{ t('onboarding.back') }}</n-button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
