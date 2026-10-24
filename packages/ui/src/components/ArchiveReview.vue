<script setup lang="ts">
// 归档详情正文（普通归档与文件夹归档共用）：原音、版本切换、录后转写与逐行回听。
// 实时原文（record.lines）永远原样展示、不可覆盖；录后转写的结果是另存的版本（record.revisions）。
import { computed, ref, watch } from 'vue';
import { NButton, NFormItem, NModal, NProgress, NSelect } from 'naive-ui';
import { AudioLines } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import {
  UI_LANGS, getAsrModel, getTranslationModel, makeDefaults,
  type ArchiveRecord, type ArchiveRefineOptions, type ArchiveRevision, type AsrLang, type LocalEngine, type UiLang,
} from '@rt/core';
import ConversationLine from './ConversationLine.vue';
import ArchiveAudioPlayer from './ArchiveAudioPlayer.vue';
import { LANG_LABELS } from './settings/form';
import {
  activeLineIndex, canRefine, defaultRefineOptions, formatOffset, lineSeek,
  pickAsrModel, pickTranslationModel, readyAsrModels, readyTranslationModels, validRefineOptions,
} from './archive-review';
import { useArchiveRefine } from './archive-refine';
import { useModels } from '../composables/useModels';
import { settings } from '../composables/useSettings';
import { fmtDateTime } from '../utils/datetime';
import { bridge } from '../bridge';

const props = defineProps<{ record: ArchiveRecord }>();
const emit = defineEmits<{ update: [record: ArchiveRecord] }>();
const { t } = useI18n();

const host = bridge();
const refineHost = { platform: host.platform, localTranslationAvailable: host.localTranslationAvailable };
const availability = computed(() => canRefine(props.record, !!host.refineArchive));

// —— 版本：'live' 为实时原文，其余为 revision.id ——
const version = ref<string>('live');
const revisions = computed<ArchiveRevision[]>(() => props.record.revisions ?? []);
const revision = computed(() => revisions.value.find((r) => r.id === version.value) ?? null);
watch(revisions, (list) => { if (version.value !== 'live' && !list.some((r) => r.id === version.value)) version.value = 'live'; });
const versionOptions = computed(() => [
  { label: t('archive.versionLive'), value: 'live' },
  ...revisions.value.map((r, i) => ({ label: t('archive.versionRevision', { n: i + 1, time: fmtDateTime(r.createdAt) }), value: r.id })),
]);
const lines = computed(() => revision.value?.lines ?? props.record.lines);

function langLabel(lang: AsrLang | UiLang): string {
  return lang === 'auto' ? t('settings.asrLanguageAuto') : LANG_LABELS[lang];
}
function asrName(id: string): string {
  const spec = getAsrModel(id);
  return spec ? t(spec.nameKey) : id;
}
function translationName(id: LocalEngine): string {
  const spec = getTranslationModel(id);
  return spec ? t(spec.nameKey) : id;
}
const revisionMeta = computed(() => {
  const o = revision.value?.options;
  if (!o) return '';
  const recognize = t('archive.revisionAsr', { model: asrName(o.asrModel), lang: langLabel(o.language) });
  const translate = o.translationModel
    ? t('archive.revisionTranslate', { model: translationName(o.translationModel), lang: langLabel(o.targetLang) })
    : t('onboarding.noTranslation');
  return `${recognize} · ${translate}`;
});

// —— 回听：只有带原音偏移的行可点；播放中高亮当前行，不滚动、不抢焦点 ——
const player = ref<InstanceType<typeof ArchiveAudioPlayer> | null>(null);
const position = ref<{ recordingId: string; time: number; playing: boolean } | null>(null);
const active = computed(() => position.value?.playing ? activeLineIndex(lines.value, position.value.recordingId, position.value.time) : -1);
const rows = computed(() => lines.value.map((line) => {
  const seek = lineSeek(line, props.record);
  const time = line.time ?? (seek ? formatOffset(seek.start) : undefined);
  return { line, seek, time, seekLabel: seek ? t('archive.seekLine', { time }) : undefined };
}));
function seekTo(target: { recordingId: string; start: number }): void {
  void player.value?.seek(target.recordingId, target.start);
}

// —— 录后转写 ——
const { models, error: modelsError, refreshModels } = useModels();
const refine = useArchiveRefine(host, () => props.record.id, (record) => {
  emit('update', record);
  const latest = record.revisions?.[record.revisions.length - 1];
  if (latest) version.value = latest.id;
});
const dialog = ref(false);
const checking = ref(false);
const draft = ref<ArchiveRefineOptions>({ asrModel: '', language: 'auto', targetLang: 'en' });

async function openDialog(): Promise<void> {
  dialog.value = true;
  checking.value = true;
  // 每次打开都重新探测：只列出此刻确实已下载的模型。
  await refreshModels().catch(() => undefined);
  checking.value = false;
  draft.value = defaultRefineOptions(settings.value ?? makeDefaults([]), refineHost, models.value);
}
const languageOptions = computed(() => [
  { label: t('settings.asrLanguageAuto'), value: 'auto' },
  ...UI_LANGS.map((l) => ({ label: LANG_LABELS[l], value: l as string })),
]);
const asrOptions = computed(() => readyAsrModels(refineHost, models.value, draft.value.language).map((m) => ({ label: t(m.nameKey), value: m.id })));
const translationOptions = computed(() => [
  { label: t('onboarding.noTranslation'), value: 'none' },
  ...readyTranslationModels(refineHost, models.value, draft.value.targetLang).map((m) => ({ label: t(m.nameKey), value: m.id as string })),
]);
const targetOptions = computed(() => UI_LANGS.map((l) => ({ label: LANG_LABELS[l], value: l as string })));
const translationValue = computed({
  get: () => draft.value.translationModel ?? 'none',
  set: (value: string) => {
    const next = { ...draft.value };
    if (value === 'none') delete next.translationModel;
    else next.translationModel = value as LocalEngine;
    draft.value = next;
  },
});
function setLanguage(language: AsrLang): void {
  draft.value = { ...draft.value, language, asrModel: pickAsrModel(refineHost, models.value, language, draft.value.asrModel) };
}
function setTarget(targetLang: UiLang): void {
  const next: ArchiveRefineOptions = { ...draft.value, targetLang };
  const kept = pickTranslationModel(refineHost, models.value, targetLang, draft.value.translationModel);
  if (kept) next.translationModel = kept;
  else delete next.translationModel;
  draft.value = next;
}
const submittable = computed(() => validRefineOptions(draft.value, refineHost, models.value));
function begin(): void {
  const options = submittable.value;
  if (!options) return;
  dialog.value = false;
  void refine.start(options);
}

const phase = refine.phase;
// 识别阶段的 completed/total 是音频毫秒、翻译阶段是行数：只展示阶段与百分比，不暴露内部单位。
const progressText = computed(() => {
  if (phase.value === 'saving') return t('archive.refineSaving');
  if (refine.cancelling.value) return t('archive.refineCancelling');
  if (!refine.total.value) return t('archive.refinePreparing');
  return t(phase.value === 'translating' ? 'archive.refineTranslating' : 'archive.refineTranscribing', { percent: refine.percent.value });
});
</script>

<template>
  <div>
    <ArchiveAudioPlayer ref="player" :archive-id="record.id" :audio="record.audio" @position="position = $event" />

    <section v-if="revisions.length || availability !== 'unsupported'" class="review-bar" :aria-label="t('archive.versionTitle')">
      <div class="flex min-h-8 items-center gap-3">
        <n-select v-if="revisions.length" :value="version" :options="versionOptions" size="small" class="min-w-0 max-w-[280px] flex-1"
          :consistent-menu-width="false" :aria-label="t('archive.versionTitle')" @update:value="version = $event" />
        <span v-else class="text-sm font-medium">{{ t('archive.versionLive') }}</span>
        <n-button v-if="availability === 'yes'" class="ml-auto" size="small" quaternary :disabled="refine.running.value" @click="openDialog">
          <template #icon><AudioLines :size="15" /></template>{{ t('archive.refine') }}
        </n-button>
      </div>
      <p class="mt-1.5 text-xs text-[var(--rt-ink-3)]">
        <template v-if="revision">{{ revisionMeta }}<br>{{ t('archive.liveKeptShort') }}</template>
        <template v-else-if="availability === 'no-audio'">{{ t('archive.refineNoAudio') }}</template>
        <template v-else>{{ t('archive.liveKept') }}</template>
      </p>

      <!-- 运行状态：进行中可取消（写盘时不可），失败可用同一组选项重试 -->
      <div v-if="refine.running.value" class="mt-3">
        <div class="flex items-center gap-3 text-xs text-[var(--rt-ink-2)]">
          <span class="min-w-0 flex-1 truncate">{{ progressText }}</span>
          <n-button size="tiny" quaternary :disabled="!refine.canCancel.value" @click="refine.cancel()">{{ t('archive.cancel') }}</n-button>
        </div>
        <n-progress v-if="phase !== 'saving'" type="line" :percentage="refine.percent.value" :show-indicator="false" :height="2" class="mt-1.5"
          :aria-label="progressText" />
      </div>
      <div v-else-if="phase === 'error'" class="mt-3 flex items-start gap-3 text-xs">
        <div class="min-w-0 flex-1" role="alert">
          <p class="text-[var(--rt-live)]">{{ t('archive.refineFailed') }}</p>
          <p v-if="refine.error.value" class="mt-0.5 break-words text-[var(--rt-ink-3)]">{{ refine.error.value }}</p>
        </div>
        <n-button v-if="refine.lastOptions.value" size="tiny" quaternary @click="refine.retry()">{{ t('archive.audioRetry') }}</n-button>
        <n-button size="tiny" quaternary @click="refine.dismiss()">{{ t('archive.refineDismiss') }}</n-button>
      </div>
      <div v-else-if="phase === 'cancelled' || phase === 'done'" class="mt-3 flex items-center gap-3 text-xs text-[var(--rt-ink-3)]">
        <span role="status" class="min-w-0 flex-1">{{ t(phase === 'done' ? 'archive.refineDone' : 'archive.refineCancelled') }}</span>
        <n-button size="tiny" quaternary @click="refine.dismiss()">{{ t('archive.refineDismiss') }}</n-button>
      </div>
    </section>

    <p v-if="!rows.length" class="mt-10 text-center text-sm text-[var(--rt-ink-3)]">{{ t('archive.noLines') }}</p>
    <ConversationLine
      v-for="(row, i) in rows"
      :key="`${version}:${i}`"
      :time="row.time"
      :text="row.line.text"
      :translation="row.line.translation"
      :seek-label="row.seekLabel"
      :active="i === active"
      @seek="row.seek && seekTo(row.seek)"
    />

    <n-modal v-model:show="dialog" preset="card" :title="t('archive.refineTitle')" style="width: 420px; max-width: calc(100vw - 32px)">
      <p class="mb-4 text-sm text-[var(--rt-ink-2)]">{{ t('archive.refineDesc') }}</p>
      <p v-if="checking" role="status" class="text-sm text-[var(--rt-ink-3)]">{{ t('archive.refineChecking') }}</p>
      <div v-else-if="modelsError" role="alert" class="flex items-center gap-3 text-sm">
        <span class="text-[var(--rt-live)]">{{ t('archive.refineModelsFailed') }}</span>
        <n-button size="small" quaternary @click="openDialog">{{ t('archive.audioRetry') }}</n-button>
      </div>
      <template v-else>
        <n-form-item :label="t('settings.asrLanguage')" :show-feedback="false" class="mb-3">
          <n-select :value="draft.language" :options="languageOptions" @update:value="setLanguage" />
        </n-form-item>
        <n-form-item :label="t('settings.asrModel')" :show-feedback="!asrOptions.length" :feedback="t('archive.refineNoAsr')" class="mb-3">
          <n-select :value="draft.asrModel || null" :options="asrOptions" :disabled="!asrOptions.length" @update:value="draft = { ...draft, asrModel: $event }" />
        </n-form-item>
        <n-form-item :label="t('settings.translationModel')" :show-feedback="translationOptions.length === 1" :feedback="t('archive.refineNoTranslation')" class="mb-3">
          <n-select v-model:value="translationValue" :options="translationOptions" />
        </n-form-item>
        <n-form-item v-if="draft.translationModel" :label="t('settings.targetLang')" :show-feedback="false">
          <n-select :value="draft.targetLang" :options="targetOptions" @update:value="setTarget" />
        </n-form-item>
        <p class="mt-4 text-xs text-[var(--rt-ink-3)]">{{ t('archive.refineLocal') }}</p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="dialog = false">{{ t('archive.cancel') }}</n-button>
          <n-button type="primary" :disabled="checking || !submittable" @click="begin">{{ t('archive.refineStart') }}</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.review-bar { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--rt-line, rgb(128 128 128 / 20%)); }
</style>
