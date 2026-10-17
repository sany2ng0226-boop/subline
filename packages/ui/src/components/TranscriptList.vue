<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import type { TranscriptLine } from '../composables/useTranscription';
import TranslatingDots from './TranslatingDots.vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const props = defineProps<{
  lines: TranscriptLine[];
  draft?: TranscriptLine | null;
  partial: string;
  stablePartial?: string;
  recording?: boolean;
  emptyHint: string;
  listeningHint: string;
  translateOn?: boolean;
  sourceLang?: string;
  targetLang?: string;
}>();
function textLang(value?: string): string | undefined {
  return value === 'zh' ? 'zh-Hans' : value === 'auto' ? undefined : value;
}
const scroller = ref<HTMLElement | null>(null);
const followEnd = ref(true);
const rows = computed(() => props.draft ? [...props.lines, props.draft] : props.lines);
const stableText = computed(() => props.stablePartial && props.partial.startsWith(props.stablePartial)
  ? props.stablePartial : '');
const visiblePartial = computed(() => {
  const raw = Array.from(props.partial);
  // Delay only the tentative tail; allow later ASR corrections to replace any prefix.
  return raw.slice(0, Math.max(Array.from(stableText.value).length, raw.length - 2, 0)).join('');
});
const tentativeText = computed(() => visiblePartial.value.slice(stableText.value.length));

function onScroll(): void {
  const el = scroller.value;
  if (el) followEnd.value = el.scrollHeight - el.clientHeight - el.scrollTop < 40;
}
watch(() => [props.draft?.text, ...props.lines.map((line) =>
  [line.text, line.translation, line.translating, line.failed])], async () => {
  // Only follow when the reader was already at the live end before this update.
  const follow = followEnd.value;
  await nextTick();
  if (follow && scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}, { immediate: true });
</script>

<template>
  <div ref="scroller" class="relative flex-1 overflow-y-auto px-6 py-5 max-sm:px-4 max-sm:pb-28" @scroll="onScroll">
    <p v-if="!recording && !rows.length" class="mt-12 text-center text-[13px] text-neutral-400 dark:text-neutral-500">{{ emptyHint }}</p>
    <div class="caption-column mx-auto w-full">
      <article v-for="line in rows" :key="line.displayId" :data-caption-id="line.displayId" class="caption-row text-left">
        <div class="caption-time tabular-nums text-neutral-400 dark:text-neutral-500">{{ line.time }}</div>
        <div class="caption-body">
        <div :lang="textLang(line.lang || sourceLang)" class="caption-source text-neutral-800 dark:text-neutral-100">
          <template v-if="line === draft"><span>{{ stableText }}</span><span :class="stablePartial !== undefined ? 'text-neutral-500 dark:text-neutral-400' : undefined">{{ tentativeText }}</span></template>
          <template v-else>{{ line.text }}</template>
        </div>
        <div v-if="translateOn" :lang="textLang(targetLang)" class="caption-translation">
          <template v-if="line.translation">{{ line.translation }}</template>
          <TranslatingDots v-else-if="line.translating" />
          <span v-else-if="line.failed" class="text-red-500" :title="line.failedDetail">{{ t('status.transFailedLine') }}</span>
        </div>
        </div>
      </article>
      <p v-if="recording && !draft" class="text-[13px] text-neutral-400 dark:text-neutral-500">{{ listeningHint }}</p>
    </div>
  </div>
</template>

<style scoped>
.caption-column { max-width: calc(36 * (var(--transcript-size) + 7px) + 64px); }
.caption-row { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 12px; margin-bottom: 22px; }
.caption-time { padding-top: 8px; font-size: 11px; line-height: 1.6; }
.caption-body { min-width: 0; }
.caption-source, .caption-translation {
  font-weight: 400; line-height: 1.6; letter-spacing: normal;
  line-break: strict; word-break: normal; overflow-wrap: anywhere;
}
.caption-source { font-size: calc(var(--transcript-size) + 7px); }
.caption-translation { font-size: calc(var(--transcript-size) + 5px); margin-top: 6px; min-height: 1.6em; color: #365e87; }
/* Keep language-specific CJK glyphs independent of the interface language. */
.caption-source:lang(ja), .caption-translation:lang(ja) { font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif; }
.caption-source:lang(zh-Hans), .caption-translation:lang(zh-Hans) { font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif; }
:global(.dark) .caption-translation { color: #a6bed7; }
@media (max-width: 639px) {
  .caption-row { grid-template-columns: 40px minmax(0, 1fr); gap: 8px; }
  .caption-time { font-size: 9px; }
}
</style>
