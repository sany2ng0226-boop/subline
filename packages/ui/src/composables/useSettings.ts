import { ref, computed } from 'vue';
import { i18n } from '../i18n';
import { bridge } from '../bridge';
import type { AppSettings, SettingsFontSize, ThemePref, UiLang } from '@rt/core';

const FONT_PX: Record<SettingsFontSize, string> = {
  xs: '13px', small: '15px', medium: '17px', large: '20px', xl: '24px',
};

// 全局单例：整个渲染进程共享同一份设置
export const settings = ref<AppSettings | null>(null);

// 当前是否深色（供 Naive 的 NConfigProvider 与界面响应式使用）
export const isDark = ref(false);
export const themePref = computed<ThemePref>(() => settings.value?.theme ?? 'system');

const darkMql = matchMedia('(prefers-color-scheme: dark)');

function applyTheme(pref: ThemePref): void {
  const dark = pref === 'system' ? darkMql.matches : pref === 'dark';
  isDark.value = dark;
  document.documentElement.classList.toggle('dark', dark);
}

// 跟随系统模式下，系统外观变化时实时更新
darkMql.addEventListener('change', () => {
  if (themePref.value === 'system') {
    applyTheme('system');
  }
});

function applyLocale(lang: UiLang): void {
  i18n.global.locale.value = lang;
  document.documentElement.lang = lang;
}

export function applyFontSize(size: SettingsFontSize): void {
  const px = Object.prototype.hasOwnProperty.call(FONT_PX, size) ? FONT_PX[size] : '15px';
  document.documentElement.style.setProperty('--transcript-size', px);
}

/** 启动时加载设置并应用语言/字体/主题 */
export async function loadSettings(): Promise<AppSettings> {
  const s = await bridge().getSettings();
  settings.value = s;
  applyLocale(s.nativeLang);
  applyFontSize(s.fontSize);
  applyTheme(s.theme);
  offAlwaysOnTop ??= bridge().onAlwaysOnTopChange?.(syncAlwaysOnTop);
  // UI 层不在此主动预热翻译模型（放这里统一预热会让每次打开都重载缓存模型、弹"加载中"）；
  // 预热时机交给各平台 bridge 决定：web 启动时若翻译已开+本地引擎就预热，macOS 仅开关开启时预热。
  return s;
}

/** 持久化整份设置，并重新应用语言/字体/主题 */
export async function saveSettings(next: AppSettings): Promise<AppSettings> {
  // 去掉 Vue 响应式 Proxy，否则 Electron IPC 结构化克隆会抛 "could not be cloned"
  const plain: AppSettings = JSON.parse(JSON.stringify(next));
  const saved = await bridge().saveSettings(plain);
  settings.value = saved;
  applyLocale(saved.nativeLang);
  applyFontSize(saved.fontSize);
  applyTheme(saved.theme);
  return saved;
}

// 字号档位从小到大，A−/A+ 每次移动一档
const FONT_TIERS: SettingsFontSize[] = ['xs', 'small', 'medium', 'large', 'xl'];

/** 当前字号是否已到最小 / 最大档 */
export const fontAtMin = computed(() => settings.value?.fontSize === FONT_TIERS[0]);
export const fontAtMax = computed(() => settings.value?.fontSize === FONT_TIERS[FONT_TIERS.length - 1]);

// 连点 A−/A+ 时串行保存，避免并发写把档位回退
let fontSaves: Promise<unknown> = Promise.resolve();

/** 字幕字号升降一档：立即生效并持久化（录音中可用） */
export function stepFontSize(delta: 1 | -1): void {
  const s = settings.value;
  if (!s) return;
  const index = FONT_TIERS.indexOf(s.fontSize);
  if (index < 0) return;
  const next = FONT_TIERS[Math.min(FONT_TIERS.length - 1, Math.max(0, index + delta))];
  if (next === s.fontSize) return;
  settings.value = { ...s, fontSize: next };
  applyFontSize(next);
  fontSaves = fontSaves
    .then(() => saveSettings({ ...settings.value!, fontSize: next }))
    .catch((error) => console.error('[settings:font-size]', error));
}

// 主窗置顶：仅宿主实现 setAlwaysOnTop 时可用（macOS），宿主负责应用与持久化；
// 菜单等其他入口改动时经 onAlwaysOnTopChange 同步回来。
export const alwaysOnTopSupported = (): boolean => typeof bridge().setAlwaysOnTop === 'function';
let offAlwaysOnTop: (() => void) | undefined;
function syncAlwaysOnTop(on: boolean): void {
  if (settings.value && settings.value.alwaysOnTop !== on) settings.value = { ...settings.value, alwaysOnTop: on };
}
export async function setAlwaysOnTop(on: boolean): Promise<void> {
  const before = settings.value?.alwaysOnTop ?? false;
  syncAlwaysOnTop(on);
  try {
    await bridge().setAlwaysOnTop?.(on);
  } catch (error) {
    syncAlwaysOnTop(before);
    console.error('[settings:always-on-top]', error);
  }
}

/** 直接设置主题偏好（持久化） */
export function setTheme(pref: ThemePref): void {
  if (!settings.value || settings.value.theme === pref) return;
  void saveSettings({ ...settings.value, theme: pref });
}

/** 顶栏单按钮轮替：浅 → 深 → 跟随系统 */
export function cycleTheme(): void {
  if (!settings.value) return;
  const order: ThemePref[] = ['light', 'dark', 'system'];
  setTheme(order[(order.indexOf(settings.value.theme) + 1) % order.length]);
}

/** 仅预览主题（设置页未保存前的实时预览） */
export function previewTheme(pref: ThemePref): void {
  applyTheme(pref);
}

/** 仅预览界面语言/字体（设置页未保存前的实时预览） */
export function previewLocale(lang: UiLang): void {
  applyLocale(lang);
}
