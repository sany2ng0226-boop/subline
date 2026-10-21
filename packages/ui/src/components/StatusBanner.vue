<script setup lang="ts">
// 字幕区顶部的错误横幅：完整文案 + 一个恢复操作 + 关闭。不截断、不弹窗，不挡录音。
import { NButton } from 'naive-ui';
import { TriangleAlert, X } from '@lucide/vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
defineProps<{ message: string; actionLabel?: string }>();
defineEmits<{ action: []; dismiss: [] }>();
</script>

<template>
  <div class="status-banner" role="alert">
    <TriangleAlert :size="16" class="status-icon" aria-hidden="true" />
    <p class="status-text">{{ message }}</p>
    <div class="flex shrink-0 items-center gap-3">
      <n-button v-if="actionLabel" text type="primary" size="small" @click="$emit('action')">{{ actionLabel }}</n-button>
      <button type="button" class="status-close" :aria-label="t('main.dismiss')" @click="$emit('dismiss')">
        <X :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.status-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 24px;
  border-bottom: 1px solid var(--rt-line);
  font-size: 13px;
  line-height: 1.5;
  color: var(--rt-ink);
}
.status-icon { flex-shrink: 0; margin-top: 2px; color: var(--rt-live); }
.status-text { flex: 1; min-width: 0; margin: 0; overflow-wrap: anywhere; }
.status-close {
  display: inline-flex;
  padding: 5px;
  border: 0;
  border-radius: 50%;
  color: var(--rt-ink-2);
  background: none;
  cursor: pointer;
}
.status-close:hover { color: var(--rt-ink); }
.status-close:focus-visible { outline: 2px solid var(--rt-accent); outline-offset: 1px; }

@media (max-width: 639px) {
  .status-banner { padding: 10px 16px; }
}
</style>
