<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AudioAttachment } from '@rt/core';
import { bridge } from '../bridge';
import { createSeeker, type SeekResult } from './audio-seek';

const props = defineProps<{ archiveId: string; audio?: AudioAttachment[] }>();
// 播放位置（秒，相对该段录音起点），供详情高亮当前行；不驱动滚动。
const emit = defineEmits<{ position: [value: { recordingId: string; time: number; playing: boolean }] }>();
const { t, locale } = useI18n();
interface Track {
  attachment: AudioAttachment;
  state: 'loading' | 'ready' | 'failed' | 'unavailable';
  url?: string;
  /** 点行跳转后浏览器拒绝播放：提示改用播放器自带按钮。 */
  blocked?: boolean;
  pending?: Promise<void>;
}
const tracks = ref<Track[]>([]);
const elements = new Map<string, HTMLAudioElement>();
let revision = 0;
// 点行跳转：最新一次点击生效；切换附件或卸载时作废进行中的跳转（见 ./audio-seek）。
const seeker = createSeeker({
  track: (id) => tracks.value.find((item) => item.attachment.id === id),
  element: (id) => elements.get(id),
  tick: nextTick,
  failed: (track) => { track.state = 'failed'; },
});

function load(track: Track, current = revision): Promise<void> {
  track.state = 'loading';
  track.url = undefined;
  track.blocked = false;
  track.pending = (async () => {
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
  })();
  return track.pending;
}
// 按附件 ID 重建：录后转写返回的新记录沿用同一组原音，不打断正在播放的段。
watch(() => `${props.archiveId}\n${(props.audio ?? []).map((a) => a.id).join('\n')}`, () => {
  const current = ++revision;
  seeker.cancel();
  elements.clear();
  tracks.value = (props.audio ?? []).map(attachment => ({ attachment, state: 'loading' }));
  for (const track of tracks.value) void load(track, current);
}, { immediate: true });
onBeforeUnmount(() => { revision++; seeker.cancel(); });

function bind(id: string, el: unknown): void {
  if (el instanceof HTMLAudioElement) elements.set(id, el);
  else elements.delete(id);
}

function report(id: string, el: HTMLAudioElement): void {
  emit('position', { recordingId: id, time: el.currentTime, playing: !el.paused && !el.ended });
}

// 同一时间只播一段：开始播放某段时暂停其余各段。
function onPlay(id: string, el: HTMLAudioElement): void {
  for (const [other, audio] of elements) if (other !== id && !audio.paused) audio.pause();
  const track = tracks.value.find((item) => item.attachment.id === id);
  if (track) track.blocked = false;
  report(id, el);
}

/** 从某段录音的 start 秒开始播放（仅由用户点行触发）；结果见 SeekResult。 */
function seek(recordingId: string, start: number): Promise<SeekResult> {
  return seeker.seek(recordingId, start);
}
defineExpose({ seek });

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
function sourceLabel(source: AudioAttachment['source']): string {
  return t(source === 'mic' ? 'archive.audioSourceMic' : 'archive.audioSourceSystem');
}
</script>

<template>
  <section class="archive-audio" :aria-label="t('archive.audioTitle')">
    <h2 class="mb-2 text-sm font-medium">{{ t('archive.audioTitle') }}</h2>
    <p v-if="!tracks.length" class="text-xs text-[var(--rt-ink-3)]">{{ t('archive.audioNotSaved') }}</p>
    <ol v-else class="flex flex-col gap-3">
      <li v-for="(track, index) in tracks" :key="`${archiveId}:${track.attachment.id}`" class="min-w-0">
        <p class="mb-1 text-xs text-[var(--rt-ink-3)]">
          {{ t('archive.audioSegment', { n: index + 1 }) }} · {{ sourceLabel(track.attachment.source) }} · {{ startedAt(track.attachment.startedAt) }} · {{ duration(track.attachment.durationMs) }}
        </p>
        <audio v-if="track.state === 'ready'" :ref="(el) => bind(track.attachment.id, el)" :src="track.url" controls preload="none"
          class="w-full" :aria-label="t('archive.audioSegment', { n: index + 1 })" @error="track.state = 'failed'"
          @play="onPlay(track.attachment.id, $event.target as HTMLAudioElement)"
          @pause="report(track.attachment.id, $event.target as HTMLAudioElement)"
          @ended="report(track.attachment.id, $event.target as HTMLAudioElement)"
          @timeupdate="report(track.attachment.id, $event.target as HTMLAudioElement)" />
        <p v-else-if="track.state === 'loading'" role="status" class="text-xs text-[var(--rt-ink-3)]">{{ t('archive.audioLoading') }}</p>
        <p v-else-if="track.state === 'unavailable'" class="text-xs text-[var(--rt-ink-3)]">{{ t('archive.audioUnavailable') }}</p>
        <div v-else class="flex items-center gap-2 text-xs">
          <span role="alert">{{ t('archive.audioLoadFailed') }}</span>
          <button type="button" class="cursor-pointer underline" @click="load(track)">{{ t('archive.audioRetry') }}</button>
        </div>
        <p v-if="track.state === 'ready' && track.blocked" role="status" class="mt-1 text-xs text-[var(--rt-ink-3)]">{{ t('archive.audioPlayBlocked') }}</p>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.archive-audio { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--rt-line, rgb(128 128 128 / 20%)); }
audio { min-height: 40px; }
</style>
