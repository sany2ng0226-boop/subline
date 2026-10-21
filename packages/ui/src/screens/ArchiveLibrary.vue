<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, NInput, NModal, NSelect } from 'naive-ui';
import { ArrowLeft, Folder, FolderPlus, Pencil, FolderInput, Trash2 } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import type { ArchiveLibrary, ArchiveRecord, ArchiveSummary } from '@rt/core';
import ConversationLine from '../components/ConversationLine.vue';
import ScrollArea from '../components/ScrollArea.vue';
import UndoBar from '../components/UndoBar.vue';
import { useArchiveDelete } from '../composables/useArchiveDelete';
import { bridge } from '../bridge';
import { fmtDateTime } from '../utils/datetime';

const { t } = useI18n();
const emit = defineEmits<{ close: [] }>();
const items = ref<ArchiveSummary[]>([]);
const library = ref<ArchiveLibrary>({ folders: [], lastFolderId: null });
const folder = ref<string | null | 'all'>('all');
const selected = ref<ArchiveRecord | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const modal = ref<'create' | 'folderRename' | 'rename' | 'move' | 'delete' | null>(null);
const target = ref<ArchiveSummary | ArchiveRecord | null>(null);
const name = ref('');
const destination = ref<string | null>(null);
const visible = computed(() => items.value.filter((item) => folder.value === 'all' || (item.folderId ?? null) === folder.value));
const folderOptions = computed(() => [{ label: t('archive.unfiled'), value: '' }, ...library.value.folders.map((f) => ({ label: f.name, value: f.id }))]);
const location = computed(() => folder.value === 'all' ? t('archive.all') : folderName(folder.value));
const modalTitle = computed(() => t(`archive.${({ create: 'newFolder', folderRename: 'renameFolder', rename: 'rename', move: 'move', delete: 'delete' } as const)[modal.value ?? 'rename']}`));
// 删除与稳定版共用：确认后先移除，8 秒内可撤销，离开本页时立即提交
const removal = useArchiveDelete(items, { onRemoved: (id) => { if (selected.value?.id === id) selected.value = null; } });
function folderName(id: string | null | undefined): string {
  return library.value.folders.find((f) => f.id === id)?.name ?? t('archive.unfiled');
}
async function run(task: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try { await task(); }
  catch (cause) { error.value = t('archive.operationFailed'); console.error('[archive]', cause); }
  finally { busy.value = false; }
}
function edit(kind: NonNullable<typeof modal.value>, item?: ArchiveSummary | ArchiveRecord): void {
  error.value = '';
  removal.failed.value = false;
  target.value = item ?? null;
  name.value = kind === 'folderRename' ? folderName(folder.value) : item?.name ?? '';
  destination.value = item?.folderId ?? null;
  modal.value = kind;
}
async function confirm(): Promise<void> {
  if (modal.value === 'delete') {
    const item = items.value.find((it) => it.id === target.value?.id);
    if (item) { removal.request(item); removal.confirm(); }
    modal.value = null;
    return;
  }
  await run(async () => {
    if (modal.value === 'create') library.value = await bridge().createArchiveFolder!(name.value);
    else if (modal.value === 'folderRename' && folder.value && folder.value !== 'all') {
      library.value = await bridge().renameArchiveFolder!(folder.value, name.value);
    } else if (target.value) {
      const id = target.value.id;
      items.value = await bridge().updateArchive!(id, modal.value === 'move' ? { folderId: destination.value } : { name: name.value });
      if (selected.value?.id === id) selected.value = await bridge().getArchive(id);
    }
    modal.value = null;
  });
}
async function open(id: string): Promise<void> {
  await run(async () => { selected.value = await bridge().getArchive(id); });
}
function back(): void { if (selected.value) selected.value = null; else emit('close'); }
onMounted(async () => {
  await run(async () => {
    [items.value, library.value] = await Promise.all([bridge().listArchives(), bridge().getArchiveLibrary!()]);
  });
  loading.value = false;
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <header class="flex items-center gap-3 border-b border-neutral-200 px-[18px] py-3 dark:border-[#3a3b44]">
      <n-button quaternary circle :aria-label="t('settings.back')" @click="back"><template #icon><ArrowLeft :size="18" /></template></n-button>
      <span class="min-w-0 flex-1 truncate text-[15px] font-semibold">{{ selected ? selected.name : t('archive.title') }}</span>
      <template v-if="selected">
        <n-button quaternary circle :disabled="busy" :aria-label="t('archive.rename')" @click="edit('rename', selected)"><template #icon><Pencil :size="16" /></template></n-button>
        <n-button quaternary circle :disabled="busy" :aria-label="t('archive.move')" @click="edit('move', selected)"><template #icon><FolderInput :size="16" /></template></n-button>
      </template>
    </header>
    <p v-if="(error || removal.failed.value) && !modal" role="alert" class="px-5 py-2 text-sm text-red-500">{{ removal.failed.value ? t('archive.deleteFailed') : error }}</p>
    <ScrollArea v-if="selected" class="min-h-0 flex-1">
      <div class="mx-auto w-full max-w-[760px] px-5 py-5">
        <p class="mb-6 text-xs text-neutral-400">{{ folderName(selected.folderId) }} · {{ fmtDateTime(selected.createdAt) }}</p>
        <ConversationLine v-for="(line, i) in selected.lines" :key="i" :time="line.time" :text="line.text" :translation="line.translation" />
      </div>
    </ScrollArea>
    <div v-else class="flex min-h-0 flex-1">
      <aside class="w-[160px] shrink-0 overflow-y-auto border-r border-neutral-200 p-2 dark:border-[#3a3b44]">
        <nav :aria-label="t('archive.folders')" class="flex flex-col gap-1">
          <button v-for="entry in [{ id: 'all', name: t('archive.all') }, { id: null, name: t('archive.unfiled') }, ...library.folders]" :key="entry.id ?? 'unfiled'"
            class="folder-row" :class="{ active: folder === entry.id }" :aria-current="folder === entry.id ? 'page' : undefined" @click="folder = entry.id">
            <Folder :size="15" class="shrink-0" /><span class="truncate">{{ entry.name }}</span>
            <span class="ml-auto text-xs text-neutral-400">{{ items.filter((it) => entry.id === 'all' || (it.folderId ?? null) === entry.id).length }}</span>
          </button>
        </nav>
        <n-button class="mt-3" quaternary size="small" :disabled="busy || loading" @click="edit('create')"><template #icon><FolderPlus :size="15" /></template>{{ t('archive.newFolder') }}</n-button>
      </aside>
      <ScrollArea class="min-w-0 flex-1">
        <div class="mx-auto w-full max-w-[760px] px-5 py-4">
          <div class="mb-3 flex items-center gap-2 text-sm font-medium">
            <span class="min-w-0 truncate">{{ location }}</span>
            <n-button v-if="folder && folder !== 'all'" quaternary circle size="tiny" :disabled="busy" :aria-label="t('archive.renameFolder')" @click="edit('folderRename')"><template #icon><Pencil :size="13" /></template></n-button>
          </div>
          <p v-if="!loading && !visible.length" class="mt-16 text-center text-sm text-neutral-400">{{ t('archive.empty') }}</p>
          <ul>
            <li v-for="item in visible" :key="item.id" class="border-b border-neutral-200 py-3 dark:border-[#2b2c33]">
              <button class="block w-full min-w-0 cursor-pointer text-left" :disabled="busy" @click="open(item.id)">
                <div class="truncate text-[15px] font-medium">{{ item.name }}</div>
                <div class="mt-1 text-xs text-neutral-400">{{ fmtDateTime(item.createdAt) }} · {{ folderName(item.folderId) }}</div>
                <div class="mt-1 truncate text-xs text-neutral-500">{{ item.lastLine }}</div>
              </button>
              <div class="mt-1 flex justify-end gap-1">
                <n-button quaternary size="tiny" :disabled="busy" @click="edit('rename', item)">{{ t('archive.rename') }}</n-button>
                <n-button quaternary size="tiny" :disabled="busy" @click="edit('move', item)">{{ t('archive.move') }}</n-button>
                <n-button quaternary circle size="tiny" :disabled="busy" :aria-label="t('archive.delete')" @click="edit('delete', item)"><template #icon><Trash2 :size="13" /></template></n-button>
              </div>
            </li>
          </ul>
        </div>
      </ScrollArea>
    </div>
    <n-modal :show="modal !== null" preset="card" :title="modalTitle" style="width: 390px; max-width: calc(100vw - 32px)" :mask-closable="!busy" :closable="!busy" @update:show="(show) => { if (!show && !busy) modal = null; }">
      <n-select v-if="modal === 'move'" :value="destination ?? ''" :options="folderOptions" :disabled="busy" :aria-label="t('archive.folder')" @update:value="destination = $event || null" />
      <p v-else-if="modal === 'delete'" class="break-words">{{ t('archive.confirmDelete', { name: target?.name }) }}</p>
      <n-input v-else v-model:value="name" autofocus :maxlength="120" :disabled="busy" :aria-label="modalTitle" @keydown.enter="name.trim() && !busy && confirm()" />
      <p v-if="error" role="alert" class="mt-2 text-sm text-red-500">{{ error }}</p>
      <template #footer><div class="flex justify-end gap-2">
        <n-button :disabled="busy" @click="modal = null">{{ t('archive.cancel') }}</n-button>
        <n-button type="primary" :loading="busy" :disabled="busy || (!['move', 'delete'].includes(modal ?? '') && !name.trim())" @click="confirm">{{ t('archive.save') }}</n-button>
      </div></template>
    </n-modal>
    <UndoBar v-if="removal.pending.value" :message="t('archive.deleted')" @undo="removal.undo()" @dismiss="removal.flush()" />
  </div>
</template>

<style scoped>
.folder-row { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 8px; border-radius: 7px; text-align: left; font-size: 13px; cursor: pointer; }
.folder-row:hover { background: rgb(128 128 128 / 8%); }
.folder-row.active { background: rgb(88 120 180 / 12%); color: #5276b0; }
</style>
