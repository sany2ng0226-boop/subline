<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ArchiveRecord } from '@rt/core';
import { bridge } from '../bridge';
import ArchiveAudioPlayer from './ArchiveAudioPlayer.vue';
import ConversationLine from './ConversationLine.vue';
import { activeLineIndex, lineSeek } from './archive-playback';

const props = defineProps<{ record: ArchiveRecord }>();
const { t } = useI18n();
const player = ref<InstanceType<typeof ArchiveAudioPlayer> | null>(null);
const position = ref<{ recordingId: string; time: number; playing: boolean } | null>(null);
const rows = computed(() => props.record.lines.map(line => ({ line,
  seek: bridge().getArchiveAudioUrl ? lineSeek(line, props.record) : null,
})));
const active = computed(() => position.value?.playing
  ? activeLineIndex(props.record.lines, position.value.recordingId, position.value.time) : -1);
</script>

<template>
  <ArchiveAudioPlayer ref="player" :archive-id="record.id" :audio="record.audio" @position="position = $event" />
  <ConversationLine v-for="(row, index) in rows" :key="index" :time="row.line.time"
    :text="row.line.text" :translation="row.line.translation" :active="active === index"
    :seek-label="row.seek ? t('archive.audioSeek', { time: row.line.time }) : undefined"
    @seek="row.seek && player?.seek(row.seek.recordingId, row.seek.start)" />
</template>
