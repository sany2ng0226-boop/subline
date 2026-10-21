<script setup lang="ts">
// 底部撤销条：删除 / 清空之后短暂出现，提供「撤销」和关闭。
import { X } from '@lucide/vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
defineProps<{ message: string }>();
defineEmits<{ undo: []; dismiss: [] }>();
</script>

<template>
  <div class="undo-bar" role="status">
    <span class="min-w-0 truncate">{{ message }}</span>
    <button type="button" class="undo-action" @click="$emit('undo')">{{ t('main.undo') }}</button>
    <button type="button" class="undo-close" :aria-label="t('main.dismiss')" @click="$emit('dismiss')">
      <X :size="14" />
    </button>
  </div>
</template>

<style scoped>
.undo-bar {
  position: fixed;
  left: 50%;
  bottom: calc(env(safe-area-inset-bottom) + 24px);
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: calc(100vw - 32px);
  padding: 8px 8px 8px 16px;
  border-radius: 999px;
  font-size: 13px;
  white-space: nowrap;
  color: var(--rt-bg);
  background: var(--rt-ink);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  transform: translateX(-50%);
}
.undo-action { flex-shrink: 0; font: inherit; font-weight: 600; color: inherit; text-decoration: underline; text-underline-offset: 3px; background: none; border: 0; cursor: pointer; }
.undo-close { display: inline-flex; flex-shrink: 0; padding: 5px; border: 0; border-radius: 50%; color: inherit; background: none; opacity: 0.7; cursor: pointer; }
.undo-close:hover { opacity: 1; }
</style>
