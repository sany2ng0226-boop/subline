<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { ArrowDown } from '@lucide/vue';
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
  translateOn?: boolean;
  sourceLang?: string;
  targetLang?: string;
}>();
function textLang(value?: string): string | undefined {
  return value === 'zh' ? 'zh-Hans' : value === 'auto' ? undefined : value;
}
const scroller = ref<HTMLElement | null>(null);
const column = ref<HTMLElement | null>(null);
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

// 视觉焦点：正在说的草稿行 + 最近一条定稿行为「当前」，更早的行退为次级墨色。
const focusFrom = computed(() => Math.max(0, rows.value.length - (props.draft ? 2 : 1)));

// 跟随只由用户向上滚动打断：内容在底部长高（如 out-in 过渡后才插入的多行译文）、
// 平滑跳转途中继续追加，都不会产生向上的 scroll，因此不会误判为离开底部。
let lastTop = 0;
let jumping = false;
function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
  if (gap < 40) followEnd.value = true;
  else if (el.scrollTop < lastTop - 1) followEnd.value = false;
  if (gap < 2 || !followEnd.value) jumping = false;
  lastTop = el.scrollTop;
}
function pinToEnd(): void {
  const el = scroller.value;
  if (!el || !followEnd.value) return;
  // 平滑跳转进行中有新内容时，把目标改到新的底部，而不是瞬移打断动画。
  if (jumping) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  else el.scrollTop = el.scrollHeight;
}
function jumpToLatest(): void {
  const el = scroller.value;
  if (!el) return;
  followEnd.value = true;
  jumping = true;
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
}
// 数据变化后立即贴底（不依赖渲染帧，窗口在后台时也成立）；
// 过渡结束后才出现的高度变化（新行、译文回填、窗口缩放）由 ResizeObserver 在绘制前补齐。
watch(() => [props.draft?.text, ...props.lines.map((line) =>
  [line.text, line.translation, line.translating, line.failed])], () => nextTick(pinToEnd));
let resizeObserver: ResizeObserver | undefined;
onMounted(() => {
  resizeObserver = new ResizeObserver(pinToEnd);
  if (scroller.value) resizeObserver.observe(scroller.value);
  if (column.value) resizeObserver.observe(column.value);
  pinToEnd();
});
onBeforeUnmount(() => resizeObserver?.disconnect());

const showJump = computed(() => !followEnd.value && rows.value.length > 0);
</script>

<template>
  <div class="relative flex min-h-0 flex-1 flex-col">
    <div
      ref="scroller"
      class="relative flex-1 overflow-y-auto px-6 pb-16 pt-7 max-sm:px-4 max-sm:pb-32"
      @scroll="onScroll"
    >
      <p v-if="!recording && !rows.length" class="empty-hint">{{ emptyHint }}</p>

      <div ref="column" class="caption-column mx-auto w-full">
        <TransitionGroup name="caption" tag="div">
          <article
            v-for="(line, i) in rows"
            :key="line.displayId"
            :data-caption-id="line.displayId"
            class="caption-row"
            :class="{ 'is-past': i < focusFrom }"
          >
            <div :lang="textLang(line.lang || sourceLang)" class="caption-source">
              <!-- stablePartial 为 undefined 表示 iOS/Web 不提供稳定前缀元数据：草稿必须保持整段深色，不能去掉这层判断。 -->
              <template v-if="line === draft"><span>{{ stableText }}</span><span :class="{ tentative: stablePartial !== undefined }">{{ tentativeText }}</span><span class="caret" aria-hidden="true" /></template>
              <template v-else>{{ line.text }}</template>
            </div>
            <div v-if="translateOn && line !== draft" :lang="textLang(targetLang)" class="caption-translation">
              <Transition name="tr" mode="out-in">
                <span v-if="line.translation" key="text" :class="{ 'is-partial': line.translationPartial }">{{ line.translation }}</span>
                <TranslatingDots v-else-if="line.translating" key="dots" class="tr-dots" />
                <span v-else-if="line.failed" key="failed" class="tr-failed" :title="line.failedDetail">{{ t('status.transFailedLine') }}</span>
              </Transition>
            </div>
          </article>
        </TransitionGroup>
      </div>
    </div>

    <Transition name="jump">
      <button v-if="showJump" type="button" class="jump-latest" @click="jumpToLatest">
        <ArrowDown :size="14" />{{ t('main.jumpLatest') }}
      </button>
    </Transition>
  </div>
</template>

<style scoped>
.caption-column { max-width: calc(36 * (var(--transcript-size) + 7px)); }

.caption-row { padding-bottom: 26px; }
.caption-source, .caption-translation {
  font-weight: 400; letter-spacing: normal;
  line-break: strict; word-break: normal; overflow-wrap: anywhere;
}
.caption-source {
  font-size: calc(var(--transcript-size) + 7px);
  line-height: 1.55;
  color: var(--rt-ink);
}
.caption-translation {
  margin-top: 6px;
  min-height: 1.6em;
  font-size: calc(var(--transcript-size) + 4px);
  line-height: 1.6;
  color: var(--rt-accent-ink);
}
.is-partial { opacity: 0.72; }
.tr-dots { color: var(--rt-accent); }
.tr-failed { color: var(--rt-live); font-size: 0.85em; }

/* 早于焦点的行：退到次级墨色（只换颜色、不做动画，保证回看时仍清晰） */
.is-past .caption-source { color: var(--rt-ink-2); }
.is-past .caption-translation { color: color-mix(in srgb, var(--rt-accent-ink) 82%, var(--rt-bg)); }

/* 实时草稿行 */
.tentative { color: var(--rt-ink-3); }
.caret {
  display: inline-block;
  width: 2px;
  height: 1.05em;
  margin-left: 3px;
  vertical-align: -0.16em;
  border-radius: 1px;
  background: var(--rt-accent);
  animation: caret-blink 1.05s steps(1) infinite;
}
@keyframes caret-blink { 50% { opacity: 0; } }

.empty-hint {
  margin-top: 18vh;
  text-align: center;
  font-size: 13px;
  color: var(--rt-ink-3);
}

.jump-latest {
  position: absolute;
  left: 50%;
  bottom: 18px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px 7px 11px;
  border: 1px solid var(--rt-line);
  border-radius: 999px;
  font-size: 12.5px;
  color: var(--rt-ink-2);
  background: var(--rt-bg);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  transform: translateX(-50%);
  cursor: pointer;
}
.jump-latest:hover { color: var(--rt-ink); }

/* 过渡：只动 opacity（合成层完成，不触发重排/重绘），新行出现与自动滚动不再互相打架 */
.caption-enter-active { transition: opacity 0.3s ease-out; }
.caption-enter-from { opacity: 0; }
.tr-enter-active { transition: opacity 0.25s ease-out; }
.tr-leave-active { transition: opacity 0.1s linear; }
.tr-enter-from, .tr-leave-to { opacity: 0; }
.jump-enter-active, .jump-leave-active { transition: opacity 0.18s ease; }
.jump-enter-from, .jump-leave-to { opacity: 0; }

/* Keep language-specific CJK glyphs independent of the interface language. */
.caption-source:lang(ja), .caption-translation:lang(ja) { font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif; }
.caption-source:lang(zh-Hans), .caption-translation:lang(zh-Hans) { font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif; }

@media (max-width: 639px) {
  .caption-row { padding-bottom: 22px; }
}

@media (prefers-reduced-motion: reduce) {
  .caption-enter-active, .tr-enter-active, .tr-leave-active { transition: none; }
  .caret { animation: none; }
}
</style>
