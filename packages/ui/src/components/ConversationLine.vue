<script setup lang="ts">
// 一行对话：时间 + 原文 + 可选译文。主页历史与归档详情共用。
// dim=true 用于主页历史（弱化，让当前句更突出）。
// translating=true 表示译文尚未到达、仍在翻译中：在译文区显示等待动画（归档详情不传，恒 false）。
// failed=true 表示该行翻译失败：译文区显示失败标记，悬停可见 failedDetail 原始错误。
import { NTooltip } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import TranslatingDots from './TranslatingDots.vue';
const { t } = useI18n();
defineProps<{
  time?: string;
  text: string;
  translation?: string;
  dim?: boolean;
  translating?: boolean;
  failed?: boolean;
  failedDetail?: string;
  /** 归档详情：有原音偏移的行把时间做成「从此处播放」按钮（seekLabel 即其无障碍名称）。 */
  seekLabel?: string;
  /** 归档详情：播放位置正落在这一行。 */
  active?: boolean;
  /** 归档详情的 Codex 校对版本：待核对标记与原因；改动过的行可展开查看修改前文字（默认收起）。 */
  review?: { needsReview: boolean; note: string; originalText?: string };
}>();
const emit = defineEmits<{ seek: [] }>();
</script>

<template>
  <div class="mb-3.5 flex gap-3" :class="{ 'line-active': active }" :aria-current="active ? 'true' : undefined">
    <button v-if="seekLabel" type="button" class="timeline-time line-seek" :aria-label="seekLabel" :title="seekLabel" @click="emit('seek')">{{ time }}</button>
    <time v-else-if="time" class="timeline-time">{{ time }}</time>
    <div class="min-w-0 flex-1">
      <div
        :class="[
          'text-[length:var(--transcript-size)] leading-relaxed',
          dim ? 'text-neutral-600 dark:text-neutral-300' : 'text-neutral-700 dark:text-neutral-200',
        ]"
      >
        {{ text }}
      </div>
      <div
        v-if="translation || translating || failed"
        :class="[
          'mt-1 border-l-2 pl-2.5 text-[length:calc(var(--transcript-size)-1px)] leading-relaxed',
          failed && !translation && !translating
            ? 'border-[var(--rt-live)] text-[var(--rt-live)]'
            : 'border-[var(--rt-accent)] text-[var(--rt-ink-3)]',
        ]"
      >
        <template v-if="translation">{{ translation }}</template>
        <TranslatingDots v-else-if="translating" class="text-[var(--rt-accent)]" />
        <!-- 失败标记：有原始错误时用 tooltip 悬停展示，无错误详情则仅显示标记 -->
        <n-tooltip v-else-if="failedDetail">
          <template #trigger>
            <span>{{ t('status.transFailedLine') }}</span>
          </template>
          {{ failedDetail }}
        </n-tooltip>
        <span v-else>{{ t('status.transFailedLine') }}</span>
      </div>
      <template v-if="review">
        <p v-if="review.needsReview" class="review-note">
          <span class="text-[var(--rt-live)]">{{ t('archive.reviewNeeded') }}</span><template v-if="review.note"> · {{ review.note }}</template>
        </p>
        <details v-if="(review.originalText && review.originalText !== text) || (!review.needsReview && review.note)" class="review-more">
          <summary>{{ t(review.originalText && review.originalText !== text ? 'archive.reviewOriginal' : 'archive.reviewNote') }}</summary>
          <p v-if="review.originalText && review.originalText !== text" class="mt-1">{{ review.originalText }}</p>
          <p v-if="!review.needsReview && review.note" class="mt-1">{{ review.note }}</p>
        </details>
      </template>
    </div>
  </div>
</template>

<style scoped>
.line-seek { text-align: left; cursor: pointer; border-radius: 4px; text-decoration: underline dotted transparent; text-underline-offset: 3px; }
.line-seek:hover { color: var(--rt-accent); text-decoration-color: currentColor; }
.line-seek:focus-visible { outline: 2px solid var(--rt-accent); outline-offset: 2px; }
.line-active .timeline-time { color: var(--rt-accent); }
.line-active > div > div:first-child { color: var(--rt-ink); }
.review-note, .review-more { margin-top: 4px; font-size: 12px; line-height: 1.5; color: var(--rt-ink-3); }
.review-more summary { cursor: pointer; width: fit-content; border-radius: 4px; }
.review-more summary:focus-visible { outline: 2px solid var(--rt-accent); outline-offset: 2px; }
</style>
