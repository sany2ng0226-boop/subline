<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AudioAttachment } from '@rt/core';
import { bridge } from '../bridge';

const props = defineProps<{ archiveId: string; audio?: AudioAttachment[] }>();
const { t, locale } = useI18n();
interface Track {
  attachment: AudioAttachment;
  state: 'loading' | 'ready' | 'failed' | 'unavailable';
  url?: string;
}
const tracks = ref<Track[]>([]);
let revision = 0;

async function load(track: Track, current = revision): Promise<void> {
  track.state = 'loading';
  track.url = undefined;
  try {
    const getUrl = bridge().getArchiveAudioUrl;
    if (!getUrl) {
      track.state = 'unavailable';
      return;
    }
    const url = await getUrl(props.archiveId, track.attachment.id);
    if (current !== revision) return;
    if (!url) throw new Error('Audio URL unavailable');
    track.url = url;
    track.state = 'ready';
  } catch {
    if (current === revision) track.state = 'failed';
  }
}
watch(() => [props.archiveId, props.audio] as const, () => {
  const current = ++revision;
  tracks.value = (props.audio ?? []).map(attachment => ({ attachment, state: 'loading' }));
  for (const track of tracks.value) void load(track, current);
}, { immediate: true });
onBeforeUnmount(() => { revision++; });

function startedAt(epoch: number): string {
  const date = new Date(epoch);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'short', timeStyle: 'medium',
  }).format(date);
}
function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(ms) ? ms / 1000 : 0));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
</script>

<template>
  <section class="archive-audio" :aria-label="t('archive.audioTitle')">
    <h2 class="mb-2 text-sm font-medium">{{ t('archive.audioTitle') }}</h2>
    <p v-if="!tracks.length" class="text-xs text-[var(--rt-ink-3)]">{{ t('archive.audioNotSaved') }}</p>
    <ol v-else class="flex flex-col gap-3">
      <li v-for="(track, index) in tracks" :key="`${archiveId}:${track.attachment.id}`" class="min-w-0">
        <p class="mb-1 text-xs text-[var(--rt-ink-3)]">
          {{ t('archive.audioSegment', { n: index + 1 }) }} · {{ startedAt(track.attachment.startedAt) }} · {{ duration(track.attachment.durationMs) }}
        </p>
        <audio v-if="track.state === 'ready'" :src="track.url" controls preload="none"
          class="w-full" :aria-label="t('archive.audioSegment', { n: index + 1 })" @error="track.state = 'failed'" />
        <p v-else-if="track.state === 'loading'" role="status" class="text-xs text-[var(--rt-ink-3)]">{{ t('archive.audioLoading') }}</p>
        <p v-else-if="track.state === 'unavailable'" class="text-xs text-[var(--rt-ink-3)]">{{ t('archive.audioUnavailable') }}</p>
        <div v-else class="flex items-center gap-2 text-xs">
          <span role="alert">{{ t('archive.audioLoadFailed') }}</span>
          <button type="button" class="cursor-pointer underline" @click="load(track)">{{ t('archive.audioRetry') }}</button>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.archive-audio { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--rt-line, rgb(128 128 128 / 20%)); }
audio { min-height: 40px; }
</style>
