<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { bridge } from '../bridge';
const props = defineProps<{ active: boolean }>();
const supported = !!bridge().onAudioLevel;
const shown = ref(0);
let target = 0, lastInput = 0, previous = 0, frame = 0;
let unsubscribe: (() => void) | undefined;
function update(now: number) {
  const elapsed = previous ? Math.min(100, now - previous) : 16;
  previous = now;
  const goal = props.active && now - lastInput < 350 ? target : 0;
  shown.value += (goal - shown.value) * (1 - Math.exp(-elapsed / (goal > shown.value ? 35 : 160)));
  if (shown.value < 0.001) shown.value = 0;
  frame = requestAnimationFrame(update);
}
onMounted(() => {
  unsubscribe = bridge().onAudioLevel?.(level => { target = level; lastInput = performance.now(); });
  if (supported) frame = requestAnimationFrame(update);
});
onUnmounted(() => { unsubscribe?.(); cancelAnimationFrame(frame); });
</script>

<template>
  <span v-if="supported" aria-hidden="true" class="audio-level-meter">
    <span class="audio-level-fill" :style="{ transform: `scaleX(${shown})` }" />
  </span>
</template>

<style scoped>
.audio-level-meter { display: inline-block; position: relative; width: 42px; height: 6px; border-radius: 3px; overflow: hidden; background: rgba(128,128,128,.16); flex-shrink: 0; }
.audio-level-fill { position: absolute; inset: 0; background: #3b9a83; border-radius: inherit; transform-origin: left; }
</style>
