// 应用设置的纯逻辑：默认值生成、字段补齐与语言/模型校验。
// 不依赖任何平台 API——系统语言由调用方传入，持久化（fs 等）留在各端实现。
import type { AppSettings, AsrLang, SettingsFontSize, ShortcutAction, UiLang } from './types';
import { DEFAULT_ASR_MODEL_ID, getAsrModel } from './models';
import { DEFAULT_TRANSLATION_MODEL_ID, getTranslationModel } from './translation/local-spec';

/** UI 语言下拉的渲染顺序（按 key 字母序）。 */
export const UI_LANGS: UiLang[] = ['en', 'ja', 'ko', 'zh'];

const ASR_LANGS: AsrLang[] = ['auto', 'en', 'ja', 'ko', 'zh'];

/**
 * 按系统语言猜母语，落到支持的语言之一，否则英语。
 * @param systemLangs 系统偏好语言列表（由各端提供，如 Electron 的 app.getPreferredSystemLanguages()）
 */
function defaultNativeLang(systemLangs: string[]): UiLang {
  const candidates = systemLangs.map((l) => (l || '').toLowerCase());
  for (const c of candidates) {
    // 繁体并入简体：任意中文变体（含台/港/澳、Hant）一律落简体 zh。
    if (c.startsWith('zh')) return 'zh';
    const hit = (['ja', 'en', 'ko'] as UiLang[]).find((l) => c.startsWith(l));
    if (hit) return hit;
  }
  return 'en';
}

/** 生成默认设置；母语按传入的系统语言推断 */
export function makeDefaults(systemLangs: string[]): AppSettings {
  return {
    settingsVersion: 2,
    uiScale: 1,
    contrast: 'standard',
    onboarded: false,
    nativeLang: defaultNativeLang(systemLangs),
    fontSize: 'small',
    theme: 'system',
    alwaysOnTop: false,
    asr: { language: 'auto', model: DEFAULT_ASR_MODEL_ID },
    // 默认麦克风（全平台可用）；系统音频由支持的端（macOS 14.2+）作为可选项提供。
    audioSource: 'mic',
    announceCaptions: false,
    translation: {
      enabled: false,
      engine: DEFAULT_TRANSLATION_MODEL_ID,
      // 云端三项默认留空：主页设置里由预设选择或手动输入填入（占位符仅作示例提示）
      cloud: {
        baseURL: '',
        apiKey: '',
        model: '',
      },
    },
  };
}

export function asUiLang(v: unknown): UiLang | null {
  return typeof v === 'string' && (UI_LANGS as string[]).includes(v) ? (v as UiLang) : null;
}

export function asAsrLang(v: unknown): AsrLang | null {
  return typeof v === 'string' && (ASR_LANGS as string[]).includes(v) ? (v as AsrLang) : null;
}

/**
 * 补齐缺省字段并校验，将旧版设置迁移到当前版本。
 * @param raw 反序列化得到的原始对象
 * @param defaults 由调用方按系统语言生成的默认值
 */
export function withDefaults(raw: unknown, defaults: AppSettings): AppSettings {
  const d = defaults;
  const s = record(raw);
  const t = record(s.translation);
  const cloud = record(t.cloud);
  const asr = record(s.asr);
  const version = finite(s.settingsVersion) ? s.settingsVersion : 1;
  let fontSize = s.fontSize;
  if (version < 2) {
    if (fontSize === 'small') fontSize = 'xs';
    else if (fontSize === 'medium') fontSize = 'small';
  }
  const overlay = normalizeOverlay(s.overlay);
  const shortcuts = normalizeShortcuts(s.shortcuts);

  // 识别语言非法则回落 auto。
  const asrLang = asAsrLang(asr.language) ?? d.asr.language;
  // 识别模型须存在于注册表且其 languages 含当前识别语言，否则回落默认模型。
  const asrModelId = typeof asr.model === 'string' ? asr.model : '';
  const asrModel = getAsrModel(asrModelId);
  const model = asrModel?.languages.includes(asrLang) ? asrModelId : DEFAULT_ASR_MODEL_ID;

  return {
    settingsVersion: 2,
    uiScale: s.uiScale === 1 || s.uiScale === 1.15 || s.uiScale === 1.3 ? s.uiScale : d.uiScale,
    contrast: s.contrast === 'standard' || s.contrast === 'more' || s.contrast === 'system'
      ? s.contrast : d.contrast,
    ...(overlay ? { overlay } : {}),
    ...(shortcuts ? { shortcuts } : {}),
    onboarded: typeof s.onboarded === 'boolean' ? s.onboarded : d.onboarded,
    alwaysOnTop: typeof s.alwaysOnTop === 'boolean' ? s.alwaysOnTop : d.alwaysOnTop,
    nativeLang: asUiLang(s.nativeLang) ?? d.nativeLang,
    fontSize: typeof fontSize === 'string' && ['xs', 'small', 'medium', 'large', 'xl'].includes(fontSize)
      ? fontSize as SettingsFontSize : d.fontSize,
    theme: s.theme === 'light' || s.theme === 'dark' ? s.theme : d.theme,
    asr: { language: asrLang, model },
    audioSource:
      s.audioSource === 'mic' || s.audioSource === 'system' ? s.audioSource : d.audioSource,
    announceCaptions: typeof s.announceCaptions === 'boolean' ? s.announceCaptions : d.announceCaptions,
    translation: {
      enabled: typeof t.enabled === 'boolean' ? t.enabled : d.translation.enabled,
      // 引擎：'cloud' 或注册表中的本地模型 id 原样保留，其余（未知/旧值）回落默认本地模型。
      engine:
        t.engine === 'cloud'
          ? 'cloud'
          : typeof t.engine === 'string' && getTranslationModel(t.engine)
            ? (t.engine as AppSettings['translation']['engine'])
            : DEFAULT_TRANSLATION_MODEL_ID,
      cloud: {
        baseURL: typeof cloud.baseURL === 'string' ? cloud.baseURL : d.translation.cloud.baseURL,
        apiKey: typeof cloud.apiKey === 'string' ? cloud.apiKey : d.translation.cloud.apiKey,
        model: typeof cloud.model === 'string' ? cloud.model : d.translation.cloud.model,
      },
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeOverlay(value: unknown): AppSettings['overlay'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const o = record(value);
  const b = record(o.bounds);
  const bounds = finite(b.x) && finite(b.y) && finite(b.width) && b.width > 0
    && finite(b.height) && b.height > 0
    ? { x: b.x, y: b.y, width: b.width, height: b.height } : undefined;
  return {
    fontDelta: finite(o.fontDelta) ? o.fontDelta : 0,
    clickThrough: typeof o.clickThrough === 'boolean' ? o.clickThrough : false,
    ...(bounds ? { bounds } : {}),
  };
}

function normalizeShortcuts(value: unknown): AppSettings['shortcuts'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = record(value);
  const shortcuts: Partial<Record<ShortcutAction, string | null>> = {};
  for (const action of ['toggleOverlay', 'toggleRecording', 'toggleClickThrough'] as const) {
    const accelerator = raw[action];
    if (accelerator === null || (typeof accelerator === 'string' && accelerator.trim())) {
      shortcuts[action] = accelerator;
    }
  }
  return shortcuts;
}

/** A save carries only the fields the caller intends to change. */
export type SettingsPatch = { [K in keyof AppSettings]?: AppSettings[K] extends object
  ? { [P in keyof AppSettings[K]]?: AppSettings[K][P] extends object
    ? Partial<AppSettings[K][P]> : AppSettings[K][P] } : AppSettings[K] };

/** Merge before validation so omitted nested fields keep their latest values. */
export function mergeSettings(current: AppSettings, patch: SettingsPatch): AppSettings {
  return withDefaults({
    ...current, ...patch,
    asr: { ...current.asr, ...patch.asr },
    translation: { ...current.translation, ...patch.translation,
      cloud: { ...current.translation.cloud, ...patch.translation?.cloud } },
    ...(patch.overlay ? { overlay: { ...current.overlay, ...patch.overlay } } : {}),
    ...(patch.shortcuts ? { shortcuts: { ...current.shortcuts, ...patch.shortcuts } } : {}),
  }, current);
}
