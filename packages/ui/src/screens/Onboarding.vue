<script setup lang="ts">
import { computed, h, reactive, ref, watch } from 'vue';
import { NButton, NFormItem, NSelect, type SelectOption } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import {
  ASR_MODELS,
  getAsrModel,
  getTranslationModel,
  translationModelsFor,
  DEFAULT_ASR_MODEL_ID,
  DEFAULT_TRANSLATION_MODEL_ID,
} from '@rt/core';
import { settings, saveSettings, previewLocale, previewTheme, applyFontSize } from '../composables/useSettings';
import { type DownloadTask, startDownloads } from '../composables/useModelDownloads';
import GeneralSection from '../components/settings/GeneralSection.vue';
import type { GeneralFormData } from '../components/settings/form';
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

const step = ref<1 | 2>(1);

// 引导页在「开始」前不落盘，仅即时预览界面语言/主题/字体（自动保存通道只在设置页）。
watch(() => form.nativeLang, (v) => previewLocale(v));
watch(() => form.theme, (v) => previewTheme(v));
watch(() => form.fontSize, (v) => applyFontSize(v));

const availableAsrModels = ASR_MODELS.filter((m) => m.platforms.includes(platform));
const asrModel = ref(availableAsrModels.some((m) => m.id === current.asr.model)
  ? current.asr.model : DEFAULT_ASR_MODEL_ID);
const asrOptions = computed(() => availableAsrModels.map((m) => ({
  label: `${t(m.nameKey)}（${humanBytes(m.approxBytes)}）`, value: m.id,
})));

// —— 翻译成母语：不翻译 / 本机模型（标明体积）。云端需要填密钥，留到设置页 ——
const localAvailable = bridge().localTranslationAvailable !== false;
const translationOptions = computed(() => {
  if (!localAvailable) return [{ label: t('onboarding.noTranslation'), value: 'none' }];
  const models = translationModelsFor(platform);
  const local = models.length
    ? models.map((m) => ({ label: `${t(m.nameKey)}（${humanBytes(m.approxDownloadBytes)}）`, value: m.id as string }))
    // 无可选权重模型（如 iOS 系统翻译）：只有一个「本机翻译」
    : [{ label: t('settings.engineLocal'), value: DEFAULT_TRANSLATION_MODEL_ID as string }];
  return [{ label: t('onboarding.noTranslation'), value: 'none' }, ...local];
});
function renderTranslationLabel(option: SelectOption) {
  return h('span', { class: 'flex items-center gap-2' }, [
    String(option.label),
    ...(getTranslationModel(String(option.value))?.tier === 'ultra'
      ? [h('span', {
          class: 'quality-badge',
          style: {
            color: 'var(--rt-accent-ink)', background: 'var(--rt-surface)',
            border: '1px solid currentColor', borderRadius: '4px',
            padding: '1px 6px', fontSize: '12px', fontWeight: '600',
          },
        }, t('modelsScreen.ultra'))] : []),
  ]);
}
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
  const asrId = asrModel.value;
  const spec = getAsrModel(asrId)!;
  // 保留兼容的识别语言；专用模型改用其注册表声明的语言。
  const language = spec.languages.includes(current.asr.language)
    ? current.asr.language : spec.languages[0];
  const enabled = translation.value !== 'none';
  // 翻译目标继续由 nativeLang 推导；保留既有翻译配置，不另设引导目标语种。
  const translationSettings = {
    ...current.translation,
    enabled,
    engine: enabled ? translation.value as typeof current.translation.engine : current.translation.engine,
  };
  await saveSettings({
    onboarded: true,
    nativeLang: form.nativeLang,
    fontSize: form.fontSize,
    theme: form.theme,
    asr: { language, model: asrId },
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
          <p class="text-[var(--rt-ink-2)]">{{ step === 1 ? t('onboarding.configure') : t('onboarding.modelHint') }}</p>
        </div>

        <general-section v-if="step === 1" :form="form" />

        <template v-else>
          <n-form-item :label="t('settings.asrModel')">
            <n-select v-model:value="asrModel" :options="asrOptions" />
          </n-form-item>
          <n-form-item :label="t('settings.translationModel')">
            <n-select v-model:value="translation" :options="translationOptions" :render-label="renderTranslationLabel" />
          </n-form-item>
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
