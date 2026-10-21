<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { NButton, NModal, NTooltip } from 'naive-ui';
import { ArrowLeft, Trash2 } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import type { ArchiveSummary, ArchiveRecord } from '@rt/core';
import ConversationLine from '../components/ConversationLine.vue';
import ScrollArea from '../components/ScrollArea.vue';
import UndoBar from '../components/UndoBar.vue';
import { useArchiveDelete } from '../composables/useArchiveDelete';
import { fmtDateTime } from '../utils/datetime';
import { archiveErrorKey } from '../utils/archiveError';
import { bridge } from '../bridge';
import ArchiveLibrary from './ArchiveLibrary.vue';
declare const __INTERNAL_BUILD__: boolean;
const foldersEnabled = typeof __INTERNAL_BUILD__ !== 'undefined' && __INTERNAL_BUILD__ && !!bridge().getArchiveLibrary;

const { t } = useI18n();
const emit = defineEmits<{ close: [] }>();

const items = ref<ArchiveSummary[]>([]);
const selected = ref<ArchiveRecord | null>(null);
const error = ref('');

// 删除先确认（默认焦点在「取消」），确认后 8 秒内可撤销，离开本页时立即提交
const removal = useArchiveDelete(items);
const deleteCancelBtn = ref<{ $el: HTMLElement } | null>(null);

async function open(id: string): Promise<void> {
  error.value = '';
  try {
    selected.value = await bridge().getArchive(id);
  } catch (cause) {
    error.value = t(archiveErrorKey(cause, 'archive.openFailed'));
    console.error('[archive:open]', cause);
  }
}

// 详情里点返回回到列表；列表里点返回回到主页
function back(): void {
  if (selected.value) {
    selected.value = null;
  } else {
    emit('close');
  }
}

onMounted(async () => {
  if (foldersEnabled) return;
  try {
    items.value = await bridge().listArchives();
  } catch (cause) {
    error.value = t(archiveErrorKey(cause, 'archive.loadFailed'));
    console.error('[archive:list]', cause);
  }
});
</script>

<template>
  <ArchiveLibrary v-if="foldersEnabled" @close="emit('close')" />
  <div v-else class="flex h-full flex-col">
    <header
      class="flex items-center gap-3 border-b border-neutral-200 px-[18px] py-3 dark:border-[#3a3b44]"
    >
      <n-tooltip>
        <template #trigger>
          <n-button quaternary circle :aria-label="t('settings.back')" @click="back">
            <template #icon><ArrowLeft :size="18" /></template>
          </n-button>
        </template>
        {{ t('settings.back') }}
      </n-tooltip>
      <span class="truncate text-[15px] font-semibold">
        {{ selected ? selected.name : t('archive.title') }}
      </span>
    </header>

    <p v-if="error || removal.failed.value" role="alert" class="px-5 py-2 text-sm text-red-500">
      {{ removal.failed.value ? t('archive.deleteFailed') : error }}
    </p>

    <!-- 详情：某条归档的完整对话（按时间顺序） -->
    <ScrollArea v-if="selected" class="flex-1">
      <div class="mx-auto w-full max-w-[640px] px-5 py-4">
        <ConversationLine
          v-for="(line, i) in selected.lines"
          :key="i"
          :time="line.time"
          :text="line.text"
          :translation="line.translation"
        />
      </div>
    </ScrollArea>

    <!-- 列表 -->
    <ScrollArea v-else class="flex-1">
      <p
        v-if="items.length === 0"
        class="mt-16 text-center text-sm text-neutral-400 dark:text-neutral-500"
      >
        {{ t('archive.empty') }}
      </p>
      <ul v-else class="mx-auto w-full max-w-[640px] px-5 py-4">
        <li
          v-for="it in items"
          :key="it.id"
          class="flex items-start gap-3 border-b border-neutral-200 py-3 dark:border-[#2b2c33]"
        >
          <button
            class="min-w-0 flex-1 cursor-pointer text-left"
            @click="open(it.id)"
          >
            <div class="flex items-center gap-2">
              <span class="truncate font-medium">{{ it.name }}</span>
              <span class="shrink-0 text-xs text-neutral-400 dark:text-neutral-500">
                {{ fmtDateTime(it.createdAt) }}
              </span>
            </div>
            <div class="mt-0.5 truncate text-xs text-neutral-400 dark:text-neutral-500">
              {{ it.lastLine }}
            </div>
          </button>
          <n-tooltip>
            <template #trigger>
              <n-button quaternary circle size="small" :aria-label="t('archive.delete')" @click="removal.request(it)">
                <template #icon><Trash2 :size="16" /></template>
              </n-button>
            </template>
            {{ t('archive.delete') }}
          </n-tooltip>
        </li>
      </ul>
    </ScrollArea>

    <!-- 删除确认：默认焦点在「取消」，回车不会误删 -->
    <n-modal
      :show="removal.confirmTarget.value !== null"
      preset="card"
      :title="t('archive.delete')"
      :auto-focus="false"
      style="width: 390px; max-width: calc(100vw - 32px)"
      @update:show="(show: boolean) => { if (!show) removal.cancel(); }"
      @after-enter="deleteCancelBtn?.$el.focus()"
    >
      <p class="break-words">{{ t('archive.confirmDelete', { name: removal.confirmTarget.value?.name }) }}</p>
      <template #footer>
        <div class="flex justify-end gap-2">
          <n-button ref="deleteCancelBtn" @click="removal.cancel()">{{ t('archive.cancel') }}</n-button>
          <n-button type="error" @click="removal.confirm()">{{ t('archive.deleteConfirmOk') }}</n-button>
        </div>
      </template>
    </n-modal>

    <UndoBar
      v-if="removal.pending.value"
      :message="t('archive.deleted')"
      @undo="removal.undo()"
      @dismiss="removal.flush()"
    />
  </div>
</template>
