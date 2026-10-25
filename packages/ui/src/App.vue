<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { NConfigProvider, darkTheme, lightTheme, type GlobalThemeOverrides } from 'naive-ui';
import Onboarding from './screens/Onboarding.vue';
import MainScreen from './screens/MainScreen.vue';
import SettingsScreen from './screens/SettingsScreen.vue';
import ArchiveScreen from './screens/ArchiveScreen.vue';
import { loadSettings, isDark } from './composables/useSettings';
import { modelLoading } from './composables/useTranscription';
import { bridge } from './bridge';
import { isOverlayWindow } from './utils/window';

type Screen = 'loading' | 'onboarding' | 'main' | 'settings' | 'archive' | 'overlay';
const screen = ref<Screen>('loading');

const naiveTheme = computed(() => (isDark.value ? darkTheme : lightTheme));

// 组件库主色与 styles.css 的 --rt-accent 对齐：按钮、开关、焦点环与主页译文/电平图同一强调色。
const themeOverrides = computed<GlobalThemeOverrides>(() => {
  const [base, hover, pressed] = isDark.value
    ? ['#8ea2ff', '#a5b5ff', '#7489ec']
    : ['#3557d6', '#4a6ae0', '#2a47b8'];
  return {
    common: {
      primaryColor: base,
      primaryColorHover: hover,
      primaryColorPressed: pressed,
      primaryColorSuppl: hover,
      borderRadius: '8px',
      fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, "PingFang SC", "Hiragino Sans", "Apple SD Gothic Neo", sans-serif',
    },
    Button: isDark.value ? { textColorPrimary: '#14151a', textColorHoverPrimary: '#14151a', textColorPressedPrimary: '#14151a', textColorFocusPrimary: '#14151a' } : {},
  };
});

// 进主界面：模型不再在此下载（改为点击录音时按需确认下载），仅后台预热已就绪的 ASR 模型，
// 使首次点击录音免等冷启动（不触麦克风）。调用前先置 modelLoading，消除 loading 事件到达前的
// 可点空窗；平台保证预热的任何路径（含跳过/失败）都以终态 status 收尾解禁。
async function enterMain(): Promise<void> {
  if (bridge().prewarmPipeline) {
    modelLoading.value = true;
    bridge().prewarmPipeline!();
  }
  screen.value = 'main';
}

onMounted(async () => {
  const s = await loadSettings();
  // 悬浮字幕窗不走引导、不预热、不显示主屏（及其弹窗）；字幕视图另行实现。
  if (isOverlayWindow()) {
    screen.value = 'overlay';
  } else if (s.onboarded) {
    await enterMain();
  } else {
    screen.value = 'onboarding';
  }
});
</script>

<template>
  <n-config-provider :theme="naiveTheme" :theme-overrides="themeOverrides">
    <!-- safe-area 内边距：iOS 刘海/灵动岛/Home 指示条留白；env() 在桌面端恒为 0，故 macOS 不受影响 -->
    <div
      class="h-svh overflow-hidden bg-[var(--rt-bg)] text-[var(--rt-ink)]"
      style="padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"
    >
      <!-- 屏幕切换过渡（样式见 styles.css .screen-*）；h-full 包裹保证各屏仍撑满 -->
      <Transition name="screen" mode="out-in">
        <onboarding v-if="screen === 'onboarding'" @done="enterMain" />
        <main-screen
          v-else-if="screen === 'main'"
          @open-settings="screen = 'settings'"
          @open-archive="screen = 'archive'"
        />
        <settings-screen v-else-if="screen === 'settings'" @close="screen = 'main'" />
        <archive-screen v-else-if="screen === 'archive'" @close="screen = 'main'" />
      </Transition>
    </div>
  </n-config-provider>
</template>
