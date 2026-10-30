<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { NPopover, NPopconfirm, NProgress } from 'naive-ui';
import { ChevronDown, Check, Download, Trash2, X, RotateCw } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import { getAsrModel, getTranslationModel, type ModelKind } from '@rt/core';
import { bridge } from '../../bridge';
import { recording, recordBusy, modelLoading } from '../../composables/useTranscription';
import { useModels } from '../../composables/useModels';
import { cancelDownload, downloadEntry, downloadFailed, isDownloading, onDownloadDone,
  percentOf, startDownloads, type DownloadTask } from '../../composables/useModelDownloads';
import { humanBytes } from '../../utils/bytes';
import ModelDownloadModal from '../ModelDownloadModal.vue';
import { modelPickerRows, type ModelPickerOption } from './model-picker';

const props = defineProps<{ value: string; kind: ModelKind; options: ModelPickerOption[]; disabled?: boolean }>();
const emit = defineEmits<{ 'update:value': [value: string] }>();
const { t } = useI18n();
const { models, refreshModels, error: listError } = useModels();
const rows = computed(() => modelPickerRows(props.options, models.value, props.kind, props.value));
const selected = computed(() => rows.value.find((row) => row.current));
const locked = computed(() => props.disabled || recording.value || recordBusy.value || modelLoading.value);
const open = ref(false);
const menu = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const actionError = ref('');
const busyId = ref('');
const downloadModalOpen = ref(false);
const downloadTasks = ref<DownloadTask[]>([]);

function statusText(row: typeof rows.value[number]): string {
  if (!row.modelId) return '';
  if (row.systemManaged) return t('models.systemManaged');
  if (isDownloading(props.kind, row.modelId)) return t('download.downloading');
  if (downloadFailed(props.kind, row.modelId)) return t('download.retry');
  return t(row.status === 'downloaded' ? 'settings.downloaded'
    : row.status === 'notDownloaded' ? 'modelsScreen.notDownloaded' : 'settings.statusUnavailable');
}

async function refresh(): Promise<void> {
  actionError.value = '';
  try { await refreshModels(); }
  catch { actionError.value = t('settings.statusUnavailable'); }
}

// The singleton already refreshes after completion; this joins that same in-flight request.
const stopDoneListener = onDownloadDone(() => { void refresh(); });
onUnmounted(stopDoneListener);

function setOpen(show: boolean): void {
  open.value = show;
  if (show) void nextTick(() => menu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
}
function close(): void {
  open.value = false;
  trigger.value?.focus();
}
function choose(row: typeof rows.value[number]): void {
  if (!row.selectable || locked.value || row.modelId === busyId.value) return;
  emit('update:value', row.value);
  close();
}
function canDownload(row: typeof rows.value[number]): boolean {
  return !row.systemManaged && !!row.model && (props.kind === 'asr' || typeof bridge().downloadTranslationModel === 'function');
}
function requestDownload(row: typeof rows.value[number]): void {
  if (!row.modelId || !canDownload(row)) return;
  const spec = props.kind === 'asr' ? getAsrModel(row.modelId) : getTranslationModel(row.modelId);
  downloadTasks.value = [{ kind: props.kind, modelId: row.modelId,
    nameKey: spec?.nameKey ?? row.label, sizeBytes: row.sizeBytes ?? 0 }];
  open.value = false;
  downloadModalOpen.value = true;
}
function confirmDownload(tasks: DownloadTask[]): void {
  startDownloads(tasks);
}
async function cancel(id: string): Promise<void> {
  busyId.value = id;
  actionError.value = '';
  try { await cancelDownload(props.kind, id); await refreshModels(); }
  catch (error) { actionError.value = error instanceof Error ? error.message : String(error); }
  finally { busyId.value = ''; }
}
async function remove(id: string): Promise<boolean> {
  if (locked.value) return false;
  busyId.value = id;
  actionError.value = '';
  try {
    const result = await bridge().deleteModel(props.kind, id);
    if (!result.ok) throw new Error(result.error || t('settings.statusUnavailable'));
    await refreshModels();
    return true;
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
    return false;
  } finally { busyId.value = ''; }
}
</script>

<template>
  <div class="model-picker">
    <n-popover :show="open" trigger="click" width="trigger" placement="bottom-start"
      :show-arrow="false" @update:show="setOpen">
      <template #trigger>
        <button ref="trigger" type="button" class="picker-trigger" :disabled="disabled"
          :aria-label="`${t('settings.chooseModel')}: ${selected?.label ?? value}`"
          aria-haspopup="dialog" :aria-expanded="open" @keydown.down.prevent="setOpen(true)">
          <span class="trigger-copy">
            <span>{{ selected?.label ?? value }}</span>
            <small v-if="selected?.modelId">{{ statusText(selected) }}</small>
          </span>
          <ChevronDown :size="16" aria-hidden="true" />
        </button>
      </template>
      <div ref="menu" role="dialog" :aria-label="t('settings.chooseModel')" class="picker-menu" @keydown.esc.stop.prevent="close">
        <ul class="picker-list">
          <li v-for="row in rows" :key="row.value" class="picker-row">
            <button type="button" class="model-choice" :disabled="!row.selectable || locked || row.modelId === busyId"
              :aria-label="`${t('settings.chooseModel')}: ${row.label}`" :aria-pressed="row.current" @click="choose(row)">
              <span class="selection-mark" aria-hidden="true"><Check v-if="row.current" :size="16" /></span>
              <span class="choice-copy">
                <span class="model-name">{{ row.label }} <span v-if="row.ultra" class="quality-badge">{{ t('modelsScreen.ultra') }}</span></span>
                <small v-if="row.modelId">
                  <span v-if="row.sizeBytes !== undefined" class="model-size">{{ humanBytes(row.sizeBytes) }} · </span>{{ statusText(row) }}
                  <span v-if="row.current"> · {{ t('modelsScreen.inUse') }}</span>
                </small>
              </span>
            </button>
            <template v-if="row.modelId && !row.systemManaged">
              <div v-if="isDownloading(kind, row.modelId)" class="download-action">
                <n-progress type="line" :percentage="percentOf(kind, row.modelId)" :show-indicator="false" :height="4"
                  :processing="!downloadEntry(kind, row.modelId)?.total" />
                <button type="button" class="row-action" :disabled="busyId === row.modelId"
                  :aria-label="`${t('modelsScreen.cancelDownload')}: ${row.label}`" @click="cancel(row.modelId)">
                  <X :size="16" aria-hidden="true" />
                </button>
              </div>
              <button v-else-if="downloadFailed(kind, row.modelId) && canDownload(row)" type="button" class="row-action"
                :aria-label="`${t('download.retry')}: ${row.label}`" @click="requestDownload(row)">
                <RotateCw :size="16" aria-hidden="true" />
              </button>
              <n-popconfirm v-else-if="row.model?.downloaded" :positive-text="t('modelsScreen.delete')"
                :negative-text="t('archive.cancel')" @positive-click="remove(row.modelId)">
                <template #trigger>
                  <button type="button" class="row-action" :disabled="locked || busyId === row.modelId"
                    :aria-label="`${t('modelsScreen.delete')}: ${row.label}`"><Trash2 :size="16" aria-hidden="true" /></button>
                </template>
                {{ row.current ? t('modelsScreen.deleteInUseWarn') : t('modelsScreen.deleteConfirm') }}
              </n-popconfirm>
              <button v-else-if="canDownload(row)" type="button" class="row-action"
                :aria-label="`${t('modelsScreen.download')}: ${row.label}`" @click="requestDownload(row)">
                <Download :size="16" aria-hidden="true" />
              </button>
            </template>
          </li>
        </ul>
      </div>
    </n-popover>
    <div v-if="actionError || listError" role="alert" class="picker-error">
      {{ actionError || t('settings.statusUnavailable') }}
      <button type="button" @click="refresh">{{ t('download.retry') }}</button>
    </div>
    <model-download-modal v-model:show="downloadModalOpen" :tasks="downloadTasks" @confirm="confirmDownload" />
  </div>
</template>

<style scoped>
.model-picker { width: 100%; min-width: 0; }
.picker-trigger { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; min-height: 42px; padding: 7px 11px; border: 1px solid var(--rt-line); border-radius: 7px; background: var(--rt-surface); color: var(--rt-ink); text-align: left; cursor: pointer; }
.trigger-copy, .choice-copy { display: flex; flex-direction: column; min-width: 0; gap: 3px; }
small { font-size: 11px; line-height: 1.5; color: var(--rt-ink-3); }
.picker-menu { width: 100%; max-height: min(440px, 65vh); overflow-y: auto; }
.picker-list { list-style: none; margin: 0; padding: 0; }
.picker-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.model-choice { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; padding: 8px 4px; border: 0; border-radius: 5px; background: transparent; color: var(--rt-ink); text-align: left; cursor: pointer; }
.model-choice:disabled { cursor: default; }
.model-choice:disabled .model-name { color: var(--rt-ink-3); }
.model-choice:not(:disabled):hover, .row-action:hover { background: var(--rt-surface); }
.selection-mark { width: 16px; flex-shrink: 0; color: var(--rt-accent-ink); }
.model-name { overflow-wrap: anywhere; line-height: 1.4; }
.model-size { font-variant-numeric: tabular-nums; white-space: nowrap; }
.row-action { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex-shrink: 0; border: 0; border-radius: 5px; background: transparent; color: var(--rt-ink-2); cursor: pointer; }
button:disabled { cursor: default; }
.row-action:disabled, .picker-trigger:disabled { opacity: .45; }
button:focus-visible { outline: 2px solid var(--rt-accent-ink); outline-offset: 2px; }
.download-action { display: flex; align-items: center; gap: 4px; width: 80px; }
.download-action :deep(.n-progress) { flex: 1; }
.quality-badge { display: inline-block; padding: 0 4px; border: 1px solid currentColor; border-radius: 3px; color: var(--rt-accent-ink); font-size: 10px; }
.picker-error { margin-top: 6px; font-size: 12px; color: var(--rt-ink); }
.picker-error button { margin-left: 8px; text-decoration: underline; }
</style>
