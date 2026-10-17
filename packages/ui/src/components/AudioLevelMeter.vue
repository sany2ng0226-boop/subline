<script setup lang="ts">
// 输入电平图：连续滚动的居中柱状波形，最新在最右。
// 性能：Canvas 直接绘制，不经过 Vue 响应式；滚动按帧插值（不再每 68ms 跳一格），
// 未录音且波形已归零时停止 rAF 循环，空闲时零开销。只读 onAudioLevel 遥测，不碰采集数据。
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { bridge } from '../bridge';

const props = defineProps<{ active: boolean }>();
const supported = !!bridge().onAudioLevel;

const BARS = 22;
const BAR_W = 2.5;
const GAP = 2;
const STEP = BAR_W + GAP;
const H = 22;
const MIN = 2.5;
const SAMPLE_MS = 70; // 每根柱子代表的时长
const WIDTH = BARS * STEP - GAP;

const canvas = ref<HTMLCanvasElement | null>(null);
const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// 环形缓冲：BARS+1 个样本（多一个用于滚动时从右侧滑入）
const samples = new Float32Array(BARS + 1);
let target = 0, lastInput = 0, previous = 0, sinceSample = 0, env = 0, frame = 0;
let ctx: CanvasRenderingContext2D | null = null;
let colorIdle = '#8a8a93', colorActive = '#3557d6';
let unsubscribe: (() => void) | undefined;
let themeObserver: MutationObserver | undefined;

function readColors(): void {
  const el = canvas.value;
  if (!el) return;
  const cs = getComputedStyle(el);
  colorIdle = cs.getPropertyValue('--rt-ink-3').trim() || colorIdle;
  colorActive = cs.getPropertyValue('--rt-accent').trim() || colorActive;
}

function setupCanvas(): void {
  const el = canvas.value;
  if (!el) return;
  const dpr = window.devicePixelRatio || 1;
  el.width = Math.round(WIDTH * dpr);
  el.height = Math.round(H * dpr);
  ctx = el.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  readColors();
}

function draw(shift: number): void {
  if (!ctx) return;
  ctx.clearRect(0, 0, WIDTH, H);
  const active = props.active;
  ctx.fillStyle = active ? colorActive : colorIdle;
  for (let i = 0; i <= BARS; i += 1) {
    const x = i * STEP - shift * STEP;
    if (x < -BAR_W || x > WIDTH) continue;
    const v = samples[i];
    const h = MIN + v * (H - MIN);
    // 越靠左越淡，营造「流过去」的感觉
    ctx.globalAlpha = active ? 0.3 + 0.7 * Math.max(0, x / WIDTH) : 0.45;
    ctx.beginPath();
    ctx.roundRect(x, (H - h) / 2, BAR_W, h, BAR_W / 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function tick(now: number): void {
  const elapsed = previous ? Math.min(100, now - previous) : 16;
  previous = now;
  const goal = props.active && now - lastInput < 350 ? target : 0;
  env += (goal - env) * (1 - Math.exp(-elapsed / (goal > env ? 35 : 160)));
  if (env < 0.001) env = 0;
  // 感知压缩：低电平也能看出起伏，高电平不至于一直顶满
  const v = Math.min(1, Math.sqrt(env) * 1.15);

  if (reduceMotion) {
    samples.fill(v);
    draw(0);
  } else {
    sinceSample += elapsed;
    while (sinceSample >= SAMPLE_MS) {
      sinceSample -= SAMPLE_MS;
      samples.copyWithin(0, 1);
    }
    samples[BARS] = v; // 最右一根实时跟随当前电平
    draw(sinceSample / SAMPLE_MS);
  }

  const settled = !props.active && env === 0 && samples.every((s) => s === 0);
  if (settled) {
    frame = 0;
    previous = 0;
    draw(0);
    return;
  }
  frame = requestAnimationFrame(tick);
}

function start(): void {
  if (!frame && supported) frame = requestAnimationFrame(tick);
}

watch(() => props.active, (on) => {
  if (on) start();
});

onMounted(() => {
  setupCanvas();
  draw(0);
  unsubscribe = bridge().onAudioLevel?.((level) => {
    target = level;
    lastInput = performance.now();
    start();
  });
  // 主题切换后刷新取色
  themeObserver = new MutationObserver(() => { readColors(); if (!frame) draw(0); });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  if (props.active) start();
});
onUnmounted(() => {
  themeObserver?.disconnect();
  unsubscribe?.();
  cancelAnimationFrame(frame);
});
</script>

<template>
  <canvas
    v-if="supported"
    ref="canvas"
    aria-hidden="true"
    class="audio-level-meter"
    :style="{ width: `${WIDTH}px`, height: `${H}px` }"
  />
</template>

<style scoped>
.audio-level-meter {
  display: block;
  flex-shrink: 0;
}
</style>
