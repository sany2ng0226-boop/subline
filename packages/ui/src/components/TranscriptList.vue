<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import type { TranscriptLine } from '../composables/useTranscription';
import TranslatingDots from './TranslatingDots.vue';
import { useCaptionAnnouncer } from '../composables/useCaptionAnnouncer';
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
  /** 读屏播报定稿字幕（设置「朗读字幕」） */
  announce?: boolean;
}>();
function textLang(value?: string): string | undefined {
  return value === 'zh' ? 'zh-Hans' : value === 'auto' ? undefined : value;
}
const { announcements } = useCaptionAnnouncer(() => props.lines, () => props.announce);
const scroller = ref<HTMLElement | null>(null);
const column = ref<HTMLElement | null>(null);

const newLineCount = ref(0);
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

type ReadingAnchor = { id: string; top: number };
let anchor: ReadingAnchor | undefined;
function sources(): HTMLElement[] {
  return Array.from(column.value?.querySelectorAll<HTMLElement>('.caption-source') ?? []);
}
function rememberAnchor(): void {
  const el = scroller.value;
  if (!el) return;
  const viewport = el.getBoundingClientRect();
  const visible = sources().filter(source => {
    const rect = source.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  });
  const source = visible.find(source => source.getBoundingClientRect().top >= viewport.top) ?? visible[0];
  const id = source?.closest<HTMLElement>('[data-caption-id]')?.dataset.captionId;
  anchor = source && id ? { id, top: source.getBoundingClientRect().top - viewport.top } : undefined;
}
function pauseFollowing(): void {
  followEnd.value = false;
  rememberAnchor();
}
function onNavigation(event: KeyboardEvent): void {
  if (event.target !== event.currentTarget) return;
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) pauseFollowing();
}
function onPointerDown(event: PointerEvent): void {
  const el = scroller.value;
  if (!el || event.target !== event.currentTarget) return;
  const scrollbarWidth = el.offsetWidth - el.clientWidth;
  if (scrollbarWidth > 0 && event.clientX >= el.getBoundingClientRect().right - scrollbarWidth) pauseFollowing();
}
function onScroll(): void {
  if (!followEnd.value) rememberAnchor();
  const el = scroller.value;
  if (el && el.scrollHeight - el.clientHeight - el.scrollTop < 40) newLineCount.value = 0;
}
function preserveReadingPosition(): void {
  const el = scroller.value;
  if (!el) return;
  if (followEnd.value) { el.scrollTop = el.scrollHeight; return; }
  const source = anchor && sources().find(source =>
    source.closest<HTMLElement>('[data-caption-id]')?.dataset.captionId === anchor!.id);
  if (source && anchor) {
    const shift = source.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(shift) > 0.5) el.scrollTop += shift;
  }
  rememberAnchor();
}
function jumpToLatest(): void {
  const el = scroller.value;
  if (!el) return;
  newLineCount.value = 0;
  followEnd.value = true;
  el.scrollTop = el.scrollHeight;
  rememberAnchor();
}
watch(() => props.lines.length, (length, previous) => {
  if (!length || length < previous) { newLineCount.value = 0; anchor = undefined; }
  else if (!props.recording || followEnd.value) newLineCount.value = 0;
  else newLineCount.value += length - previous;
}, { flush: 'pre' });

function onKeydown(event: KeyboardEvent): void {
  if (!showJump.value || event.key !== 'Enter' || event.isComposing
    || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const focused = document.activeElement;
  if (focused?.closest('input, textarea, select, button') || (focused as HTMLElement | null)?.isContentEditable) return;
  event.preventDefault();
  jumpToLatest();
}
// Content growth follows the bottom only until the reader deliberately starts browsing.
watch(() => [props.draft?.text, ...props.lines.map((line) =>
  [line.text, line.translation, line.translating, line.failed])], () => nextTick(preserveReadingPosition));
let resizeObserver: ResizeObserver | undefined;
onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  resizeObserver = new ResizeObserver(preserveReadingPosition);
  if (scroller.value) resizeObserver.observe(scroller.value);
  if (column.value) resizeObserver.observe(column.value);
  jumpToLatest();
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener('keydown', onKeydown);
});

const jumpAction = computed(() => newLineCount.value
  ? `↓ ${t('main.jumpLatestCount', { count: newLineCount.value }, newLineCount.value)}`
  : t('main.jumpLatest'));
const jumpLabel = computed(() => jumpAction.value);
const showJump = computed(() => !followEnd.value && rows.value.length > 0);
</script>

<template>
  <div class="relative flex min-h-0 flex-1 flex-col">
    <div
      ref="scroller"
      class="transcript-scroller relative flex-1 overflow-y-auto px-6 pb-16 pt-7 max-sm:px-4"
      @scroll="onScroll"
      @wheel.passive="pauseFollowing"
      @touchstart.passive="pauseFollowing"
      @pointerdown="onPointerDown"
      @keydown="onNavigation"
      tabindex="0"
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
            <time v-if="line.time" class="timeline-time">{{ line.time }}</time>
            <div class="caption-body">
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
            </div>
          </article>
        </TransitionGroup>
      </div>
    </div>

    <!-- 读屏区域：视觉隐藏，只追加定稿原文与定稿译文 -->
    <div v-if="announce" class="sr-only" aria-live="polite">
      <p v-for="a in announcements" :key="a.id" :lang="textLang(a.kind === 'source' ? sourceLang : targetLang)">{{ a.text }}</p>
    </div>

    <Transition name="jump">
      <div v-if="showJump" class="jump-controls">
        <button type="button" class="jump-latest" :class="{ 'has-new': newLineCount > 0 }" :aria-label="jumpLabel" @click="jumpToLatest">
          <span :key="newLineCount" class="jump-action">{{ jumpAction }}</span>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.transcript-scroller { overflow-anchor: none; }
.caption-column { max-width: calc(36 * (var(--transcript-size) + 7px)); }

.caption-row { display: flex; gap: 12px; padding-bottom: 26px; }
.caption-body { min-width: 0; flex: 1; }
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
  border-left: 2px solid var(--rt-accent);
  padding-left: 10px;
  min-height: 1.6em;
  font-size: calc(var(--transcript-size) + 4px);
  line-height: 1.6;
  color: var(--rt-accent-ink);
}
/* 流式译文：与背景混色而非 opacity，旧行里也不会再叠一层变浅 */
.is-partial { color: color-mix(in srgb, var(--rt-accent-ink) 85%, var(--rt-bg)); }
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

.jump-controls {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
}
.jump-latest {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 14px 0 12px;
  border: 1px solid color-mix(in srgb, var(--rt-accent) 35%, transparent);
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  color: var(--rt-accent-ink);
  background: color-mix(in srgb, var(--rt-accent) 10%, var(--rt-bg));
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08);
  cursor: pointer;
  transition: background-color 0.18s ease, color 0.18s ease, border-color 0.18s ease;
}
.jump-latest:hover { background: color-mix(in srgb, var(--rt-accent) 16%, var(--rt-bg)); }
.jump-latest.has-new {
  border-color: var(--rt-accent);
  color: var(--rt-bg);
  background: var(--rt-accent);
  font-weight: 600;
}
.jump-latest.has-new:hover { background: color-mix(in srgb, var(--rt-accent) 88%, var(--rt-ink)); }
.jump-latest:focus-visible { outline: 2px solid var(--rt-accent); outline-offset: 3px; }
/* 日文/韩文：按 :lang() 选本地字体，避免落到 PingFang SC 的中文字形；↓ 固定用 Hiragino 字形以保证居中。 */
@font-face { font-family: "JumpArrow"; src: local("HiraginoSans-W3"); font-weight: 100 400; unicode-range: U+2193; }
@font-face { font-family: "JumpArrow"; src: local("HiraginoSans-W4"); font-weight: 401 500; unicode-range: U+2193; }
@font-face { font-family: "JumpArrow"; src: local("HiraginoSans-W5"); font-weight: 501 900; unicode-range: U+2193; }
.jump-action { font-family: "JumpArrow", -apple-system, "PingFang SC", "Hiragino Sans", "Apple SD Gothic Neo", sans-serif; }
.jump-latest:lang(ja) {
  font-family: -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
  font-weight: 400; font-feature-settings: "palt"; letter-spacing: 0.02em;
}
.jump-latest:lang(ja).has-new { font-weight: 500; }
.jump-latest:lang(ja) .jump-action { font-family: "JumpArrow", -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif; }
.jump-latest:lang(ko) { font-family: -apple-system, "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", sans-serif; letter-spacing: -0.01em; }
.jump-latest:lang(ko) .jump-action { font-family: "JumpArrow", -apple-system, "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", sans-serif; }
/* 数字等宽：计数变化时胶囊宽度不跳 */
.jump-action { font-variant-numeric: tabular-nums; }
/* 过渡：只动 opacity（合成层完成，不触发重排/重绘），新行出现与自动滚动不再互相打架 */
.caption-enter-active { transition: opacity 0.3s ease-out; }
.caption-enter-from { opacity: 0; }
.tr-enter-active { transition: opacity 0.25s ease-out; }
.tr-leave-active { transition: opacity 0.1s linear; }
.tr-enter-from, .tr-leave-to { opacity: 0; }
.jump-enter-active { transition: opacity 0.2s ease-out; }
.jump-leave-active { transition: opacity 0.14s ease-in; }
.jump-enter-from { opacity: 0; }
.jump-leave-to { opacity: 0; }

/* Keep language-specific CJK glyphs independent of the interface language. */
.caption-source:lang(ja), .caption-translation:lang(ja) { font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif; }
.caption-source:lang(zh-Hans), .caption-translation:lang(zh-Hans) { font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif; }

@media (max-width: 639px) {
  .caption-row { padding-bottom: 22px; }
}

@media (prefers-reduced-motion: reduce) {
  .caption-enter-active, .tr-enter-active, .tr-leave-active { transition: none; }
  .caret { animation: none; }
  .jump-enter-active, .jump-leave-active, .jump-latest { transition: none; }
}
</style>
