<script setup lang="ts">
// 归档详情正文（普通归档与文件夹归档共用）：原音、版本切换、录后转写、Codex 校对与逐行回听。
// 实时原文（record.lines）永远原样展示、不可覆盖；录后转写与 Codex 校对的结果都是另存的版本（record.revisions）。
import { computed, ref, watch } from 'vue';
import { NButton, NFormItem, NModal, NProgress, NSelect } from 'naive-ui';
import { AudioLines, SpellCheck } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import {
  UI_LANGS, getAsrModel, getTranslationModel, makeDefaults,
  type ArchiveRecord, type ArchiveRefineOptions, type ArchiveRevision, type AsrLang, type LocalEngine, type UiLang,
} from '@rt/core';
import ConversationLine from './ConversationLine.vue';
import ArchiveAudioPlayer from './ArchiveAudioPlayer.vue';
import { LANG_LABELS } from './settings/form';
import {
  activeLineIndex, canProofread, canRefine, codexIssue, defaultRefineOptions, describeRevision, formatOffset, lineSeek,
  isProofreadOptions, proofreadOptions, revisionOrdinal,
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
function versionLabel(id: string): string {
  if (id === 'live') return t('archive.versionLive');
  const r = revisions.value.find((item) => item.id === id);
  const ord = revisionOrdinal(revisions.value, id);
  if (!r || !ord) return t('archive.revisionSourceUnknown');
  return t(ord.kind === 'codex' ? 'archive.versionCodex' : 'archive.versionRevision', { n: ord.n, time: fmtDateTime(r.createdAt) });
}
const versionOptions = computed(() => [{ id: 'live' }, ...revisions.value].map(({ id }) => ({ label: versionLabel(id), value: id })));
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
const summary = computed(() => revision.value ? describeRevision(revision.value, revisions.value) : null);
const revisionMeta = computed(() => {
  const s = summary.value;
  if (!s) return '';
  if (s.kind === 'codex') {
    const source = s.source === 'unknown' ? t('archive.revisionSourceUnknown') : versionLabel(s.source);
    return [
      s.model ? t('archive.revisionCodex', { model: s.model }) : t('archive.revisionCodexNoModel'),
      t('archive.revisionCodexTarget', { lang: langLabel(s.targetLang) }),
      t('archive.revisionSource', { version: source }),
    ].join(' · ');
  }
  const recognize = t('archive.revisionAsr', { model: asrName(s.asrModel), lang: langLabel(s.language) });
  const translate = s.translationModel
    ? t('archive.revisionTranslate', { model: translationName(s.translationModel), lang: langLabel(s.targetLang) })
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

// —— Codex 校对与翻译（仅 Dev）：发送当前选中版本的字幕文字，不发送音频 ——
const proofreadAvailable = canProofread(host);
const codexDialog = ref(false);
const codexState = ref<'checking' | 'ready' | 'missing' | 'login' | 'failed'>('checking');
const codexModel = ref('');
const codexError = ref('');
const codexTarget = ref<UiLang>('en');
const codexSource = ref('live');
let codexCheck = 0;
async function checkCodex(): Promise<void> {
  const current = ++codexCheck;
  codexState.value = 'checking';
  codexError.value = '';
  try {
    const status = await host.getCodexStatus!();
    if (current !== codexCheck) return;
    codexModel.value = status.model;
    codexState.value = codexIssue(status) ?? 'ready';
    codexError.value = codexState.value === 'ready' ? '' : status.error ?? '';
  } catch (cause) {
    if (current !== codexCheck) return;
    codexError.value = cause instanceof Error ? cause.message : String(cause ?? '');
    codexState.value = 'failed';
  }
}
function openCodex(): void {
  const s = settings.value ?? makeDefaults([]);
  // 来源固定为打开时选中的版本；目标语言沿用来源版本已翻译的目标，否则取翻译设置。
  codexSource.value = version.value;
  const o = revision.value?.options;
  codexTarget.value = o && (isProofreadOptions(o) || o.translationModel) ? o.targetLang : s.translation.targetLang ?? s.nativeLang;
  codexDialog.value = true;
  void checkCodex();
}
const codexSourceLines = computed(() => codexSource.value === 'live'
  ? props.record.lines
  : revisions.value.find((r) => r.id === codexSource.value)?.lines ?? []);
const codexSubmittable = computed(() => codexState.value === 'ready' && codexSourceLines.value.length > 0 && !refine.running.value);
function beginCodex(): void {
  if (!codexSubmittable.value) return;
  codexDialog.value = false;
  void refine.start(proofreadOptions(codexSource.value, codexTarget.value));
}
const reviewCount = computed(() => summary.value?.kind === 'codex' ? summary.value.needsReview : 0);

const phase = refine.phase;
// 识别阶段的 completed/total 是音频毫秒、翻译阶段是行数：只展示阶段与百分比，不暴露内部单位。
const progressText = computed(() => {
  if (phase.value === 'saving') return t('archive.refineSaving');
  if (refine.cancelling.value) return t('archive.refineCancelling');
  if (!refine.total.value) return t('archive.refinePreparing');
  const key = phase.value === 'proofreading' ? 'archive.codexProofreading'
    : phase.value === 'translating' ? 'archive.refineTranslating' : 'archive.refineTranscribing';
  return t(key, { percent: refine.percent.value });
});
</script>

<template>
  <div>
    <ArchiveAudioPlayer ref="player" :archive-id="record.id" :audio="record.audio" @position="position = $event" />

    <section v-if="revisions.length || availability !== 'unsupported' || proofreadAvailable" class="review-bar" :aria-label="t('archive.versionTitle')">
      <div class="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
        <n-select v-if="revisions.length" :value="version" :options="versionOptions" size="small" class="min-w-0 max-w-[280px] flex-1"
          :consistent-menu-width="false" :aria-label="t('archive.versionTitle')" @update:value="version = $event" />
        <span v-else class="text-sm font-medium">{{ t('archive.versionLive') }}</span>
        <div v-if="availability === 'yes' || proofreadAvailable" class="ml-auto flex items-center gap-1">
          <n-button v-if="availability === 'yes'" size="small" quaternary :disabled="refine.running.value" @click="openDialog">
            <template #icon><AudioLines :size="15" /></template>{{ t('archive.refine') }}
          </n-button>
          <n-button v-if="proofreadAvailable" size="small" quaternary :disabled="refine.running.value" @click="openCodex">
            <template #icon><SpellCheck :size="15" /></template>{{ t('archive.codex') }}
          </n-button>
        </div>
      </div>
      <p class="mt-1.5 text-xs text-[var(--rt-ink-3)]">
        <template v-if="revision">
          {{ revisionMeta }}
          <template v-if="summary?.kind === 'codex'"><br><span v-if="reviewCount" class="text-[var(--rt-live)]">{{ t('archive.reviewCount', { n: reviewCount }) }} · </span>{{ t('archive.reviewHint') }}</template>
          <br>{{ t('archive.liveKeptShort') }}
        </template>
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
          <p class="text-[var(--rt-live)]">{{ t(refine.kind.value === 'codex' ? 'archive.codexFailed' : 'archive.refineFailed') }}</p>
          <p v-if="refine.error.value" class="mt-0.5 break-words text-[var(--rt-ink-3)]">{{ refine.error.value }}</p>
          <p v-if="refine.kind.value === 'codex' && refine.lastOptions.value" class="mt-0.5 text-[var(--rt-ink-3)]">{{ t('archive.codexRetryHint') }}</p>
        </div>
        <n-button v-if="refine.lastOptions.value" size="tiny" quaternary @click="refine.retry()">{{ t(refine.kind.value === 'codex' ? 'archive.codexRetry' : 'archive.audioRetry') }}</n-button>
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
      :review="row.line.review"
      @seek="row.seek && seekTo(row.seek)"
    />

    <!-- Codex 校对：执行前说明发送内容与额度；本机 Codex 不可用时只给出处理办法，不改走其他服务 -->
    <n-modal v-if="proofreadAvailable" v-model:show="codexDialog" preset="card" :title="t('archive.codexTitle')" style="width: 420px; max-width: calc(100vw - 32px)">
      <p class="text-sm text-[var(--rt-ink-2)]">{{ t('archive.codexSource', { version: versionLabel(codexSource) }) }}</p>
      <p class="mt-0.5 mb-4 text-xs text-[var(--rt-ink-3)]">{{ codexSourceLines.length ? t('archive.codexSourceHint') : t('archive.codexNoLines') }}</p>
      <n-form-item :label="t('settings.targetLang')" :show-feedback="false">
        <n-select :value="codexTarget" :options="targetOptions" @update:value="codexTarget = $event" />
      </n-form-item>
      <ul class="codex-terms">
        <li>{{ t('archive.codexPrivacy') }}</li>
        <li>{{ t('archive.codexQuota') }}</li>
        <li>{{ t('archive.codexNoListen') }}</li>
        <li>{{ t('archive.codexKeep') }}</li>
      </ul>
      <p v-if="codexState === 'checking'" role="status" class="text-xs text-[var(--rt-ink-3)]">{{ t('archive.codexChecking') }}</p>
      <p v-else-if="codexState === 'ready'" role="status" class="text-xs text-[var(--rt-ink-3)]">
        {{ codexModel ? t('archive.codexReady', { model: codexModel }) : t('archive.codexReadyNoModel') }}
      </p>
      <div v-else role="alert" class="flex items-start gap-3 text-xs">
        <div class="min-w-0 flex-1">
          <p class="text-[var(--rt-live)]">{{ t(codexState === 'missing' ? 'archive.codexMissing' : codexState === 'login' ? 'archive.codexLogin' : 'archive.codexCheckFailed') }}</p>
          <p v-if="codexError" class="mt-0.5 break-words text-[var(--rt-ink-3)]">{{ codexError }}</p>
        </div>
        <n-button size="tiny" quaternary @click="checkCodex">{{ t('archive.codexRecheck') }}</n-button>
      </div>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button @click="codexDialog = false">{{ t('archive.cancel') }}</n-button>
          <n-button type="primary" :disabled="!codexSubmittable" @click="beginCodex">{{ t('archive.codexStart') }}</n-button>
        </div>
      </template>
    </n-modal>

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
.codex-terms { margin: 16px 0 12px; padding: 12px 0 0 16px; border-top: 1px solid var(--rt-line, rgb(128 128 128 / 20%)); list-style: disc; font-size: 12px; line-height: 1.6; color: var(--rt-ink-2); }
.codex-terms li + li { margin-top: 2px; }
</style>
