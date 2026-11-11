<script setup lang="ts">
import { computed } from 'vue';
import { NModal, NButton } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { belowRecommendedMemory } from '@rt/core';
import { bridge } from '../bridge';
import { humanBytes } from '../utils/bytes';
import type { DownloadTask } from '../composables/useModelDownloads';

const { t } = useI18n();
// 下载确认弹窗（仅确认态）：列出待下载模型 + 合计体积，征询后由父组件转后台下载
// （下载进度/取消/失败重试均移到行内或主屏，见 useModelDownloads / ModelPicker / MainScreen）。
const props = defineProps<{ tasks: DownloadTask[] }>();
const show = defineModel<boolean>('show', { default: false });
const emit = defineEmits<{ confirm: [tasks: DownloadTask[]]; cancel: [] }>();

const totalBytes = computed(() => props.tasks.reduce((sum, task) => sum + task.sizeBytes, 0));

// 内存低于模型提醒线时只提醒、不拦截：用户仍可继续下载。
const lowMemoryTask = computed(() => props.tasks.find(
  (task) => task.kind === 'translation' && belowRecommendedMemory(task.modelId, bridge().totalMemoryBytes)));
const memoryGb = computed(() => Math.round((bridge().totalMemoryBytes ?? 0) / 1024 ** 3));

function onConfirm(): void {
  const tasks = props.tasks;
  show.value = false;
  emit('confirm', tasks);
}

function onCancel(): void {
  show.value = false;
  emit('cancel');
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    :title="t('download.title')"
    style="width: 460px; max-width: 90vw"
    :closable="false"
    :mask-closable="false"
    :close-on-esc="false"
  >
    <p class="mb-3 text-sm text-[var(--rt-ink-3)]">{{ t(tasks.some((task) => task.kind === 'translation') ? 'download.translationDesc' : 'download.desc') }}</p>
    <ul class="mb-2 space-y-1.5">
      <li
        v-for="(task, i) in tasks"
        :key="i"
        class="flex items-center justify-between gap-3 text-sm"
      >
        <span class="min-w-0 truncate">{{ t(task.nameKey) }}</span>
        <span class="shrink-0 tabular-nums text-[var(--rt-ink-3)]">{{ humanBytes(task.sizeBytes) }}</span>
      </li>
    </ul>
    <div
      v-if="tasks.length > 1"
      class="flex items-center justify-between gap-3 border-t border-neutral-200 pt-2 text-sm font-medium dark:border-[#3a3b44]"
    >
      <span>{{ t('download.total') }}</span>
      <span class="tabular-nums">{{ humanBytes(totalBytes) }}</span>
    </div>
    <p v-if="lowMemoryTask" class="mt-3 border-t border-neutral-200 pt-3 text-sm text-[#b45309] dark:border-[#3a3b44] dark:text-[#f0b35a]" role="alert">
      {{ t('download.lowMemory', { gb: memoryGb, model: t(lowMemoryTask.nameKey) }) }}
    </p>
    <div class="mt-5 flex justify-end gap-2">
      <n-button @click="onCancel">{{ t('download.cancel') }}</n-button>
      <n-button type="primary" @click="onConfirm">{{ t('download.start') }}</n-button>
    </div>
  </n-modal>
</template>
