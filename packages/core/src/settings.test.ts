// settings 纯逻辑的单元测试：默认值的母语推断、字段补齐与语言/模型校验。
import { describe, expect, it } from 'vitest';
import { UI_LANGS, makeDefaults, withDefaults } from './settings';

describe('UI_LANGS', () => {
  it('按 key 字母序渲染', () => {
    expect(UI_LANGS).toEqual(['en', 'ja', 'ko', 'zh']);
  });
});

describe('makeDefaults 母语推断', () => {
  it('任意中文变体（含 TW/HK/MO/Hant）一律推断为简体 zh', () => {
    expect(makeDefaults(['zh-CN']).nativeLang).toBe('zh');
    expect(makeDefaults(['zh']).nativeLang).toBe('zh');
    expect(makeDefaults(['zh-TW']).nativeLang).toBe('zh');
    expect(makeDefaults(['zh-HK']).nativeLang).toBe('zh');
    expect(makeDefaults(['zh-Hant-TW']).nativeLang).toBe('zh');
  });

  it('ja / ko / en 按前缀命中', () => {
    expect(makeDefaults(['ja-JP']).nativeLang).toBe('ja');
    expect(makeDefaults(['ko-KR']).nativeLang).toBe('ko');
    expect(makeDefaults(['en-US']).nativeLang).toBe('en');
  });

  it('首个可识别语言优先', () => {
    expect(makeDefaults(['fr-FR', 'ja-JP', 'zh-CN']).nativeLang).toBe('ja');
  });

  it('未知语言或空列表回退英语', () => {
    expect(makeDefaults(['fr-FR']).nativeLang).toBe('en');
    expect(makeDefaults([]).nativeLang).toBe('en');
  });

  it('识别默认 auto + sense-voice，音源默认麦克风', () => {
    const d = makeDefaults([]);
    expect(d.asr).toEqual({ language: 'auto', model: 'sense-voice' });
    expect(d.audioSource).toBe('mic');
  });

  it('默认关闭翻译、引擎为本地 m2m100、云端三项留空', () => {
    const d = makeDefaults([]);
    expect(d.onboarded).toBe(false);
    expect(d.fontSize).toBe('small');
    expect(d.theme).toBe('system');
    expect(d.alwaysOnTop).toBe(false);
    expect(d.translation.enabled).toBe(false);
    expect(d.translation.engine).toBe('m2m100');
    expect(d.translation.cloud).toEqual({ baseURL: '', apiKey: '', model: '' });
  });
});

describe('withDefaults 字段补齐与校验', () => {
  const d = makeDefaults(['en-US']);

  it('空对象/null 全部落默认', () => {
    expect(withDefaults(null, d)).toEqual(d);
    expect(withDefaults({}, d)).toEqual(d);
  });

  it('非法 nativeLang / fontSize / theme / audioSource 回退默认', () => {
    const s = withDefaults(
      { nativeLang: 'fr', fontSize: 'huge', theme: 'blue', audioSource: 'bluetooth' },
      d,
    );
    expect(s.nativeLang).toBe(d.nativeLang);
    expect(s.fontSize).toBe('small');
    expect(s.theme).toBe('system');
    expect(s.audioSource).toBe('mic');
  });

  it('合法字段原样保留', () => {
    const s = withDefaults(
      {
        onboarded: true,
        nativeLang: 'ja',
        fontSize: 'large',
        theme: 'dark',
        audioSource: 'mic',
        asr: { language: 'ja', model: 'zipformer-ja-reazonspeech' },
        translation: {
          enabled: true,
          engine: 'cloud',
          cloud: { baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm' },
        },
      },
      d,
    );
    expect(s.onboarded).toBe(true);
    expect(s.nativeLang).toBe('ja');
    expect(s.fontSize).toBe('large');
    expect(s.theme).toBe('dark');
    expect(s.audioSource).toBe('mic');
    expect(s.asr).toEqual({ language: 'ja', model: 'zipformer-ja-reazonspeech' });
    expect(s.translation).toEqual({
      enabled: true,
      engine: 'cloud',
      cloud: { baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'm' },
    });
  });

  it('preserves boolean pinning and falls back for missing or invalid values', () => {
    for (const on of [true, false]) {
      expect(withDefaults({ alwaysOnTop: on }, d).alwaysOnTop).toBe(on);
    }
    for (const value of [undefined, null, 0, 1, 'true', 'false', {}, []]) {
      expect(withDefaults({ alwaysOnTop: value }, d).alwaysOnTop).toBe(false);
      expect(withDefaults({ alwaysOnTop: value }, { ...d, alwaysOnTop: true }).alwaysOnTop).toBe(true);
    }
  });

  it('cloud 字段缺省补齐为空串', () => {
    const s = withDefaults({ translation: { engine: 'cloud' } }, d);
    expect(s.translation.cloud).toEqual({ baseURL: '', apiKey: '', model: '' });
  });

  it('引擎校验：cloud 与注册表本地模型 id 保留，未知值回落默认本地模型', () => {
    // 注册表内的本地模型 id 原样保留。
    expect(withDefaults({ translation: { engine: 'm2m100' } }, d).translation.engine).toBe('m2m100');
    expect(withDefaults({ translation: { engine: 'm2m100-1.2b' } }, d).translation.engine).toBe('m2m100-1.2b');
    expect(withDefaults({ translation: { engine: 'cloud' } }, d).translation.engine).toBe('cloud');
    // 未在注册表中的旧值/非法值/已下架 id 回落默认本地模型。
    expect(withDefaults({ translation: { engine: 'local' } }, d).translation.engine).toBe('m2m100');
    expect(withDefaults({ translation: { engine: 'nllb' } }, d).translation.engine).toBe('m2m100');
    expect(withDefaults({ translation: { engine: 'mbart50' } }, d).translation.engine).toBe('m2m100');
  });

  describe('asr 语言与模型校验', () => {
    it('非法识别语言回落 auto', () => {
      const s = withDefaults({ asr: { language: 'fr', model: 'sense-voice' } }, d);
      expect(s.asr.language).toBe('auto');
    });

    it('模型不在注册表：回落 sense-voice', () => {
      const s = withDefaults({ asr: { language: 'auto', model: 'ghost-model' } }, d);
      expect(s.asr.model).toBe('sense-voice');
    });

    it('模型存在但不支持当前识别语言：回落 sense-voice', () => {
      // paraformer-zh 只支持 zh，识别语言却设 ja → 不匹配，回落默认模型
      const s = withDefaults({ asr: { language: 'ja', model: 'paraformer-zh' } }, d);
      expect(s.asr.language).toBe('ja');
      expect(s.asr.model).toBe('sense-voice');
    });

    it('模型存在且支持当前识别语言：保留', () => {
      const s = withDefaults({ asr: { language: 'zh', model: 'paraformer-zh' } }, d);
      expect(s.asr).toEqual({ language: 'zh', model: 'paraformer-zh' });
    });
  });
});

describe('v2 settings migration', () => {
  const d = makeDefaults([]);
  it.each([
    [undefined, 'small', 'xs'], [1, 'medium', 'small'], [0, 'large', 'large'],
    [2, 'small', 'small'], [2, 'medium', 'medium'], [3, 'small', 'small'],
  ])('version %s migrates %s to %s', (settingsVersion, fontSize, expected) => {
    const normalized = withDefaults({ settingsVersion, fontSize }, d);
    expect(normalized.fontSize).toBe(expected);
    expect(normalized.settingsVersion).toBe(2);
    expect(withDefaults(normalized, d)).toEqual(normalized);
  });

  it.each(['xs', 'small', 'medium', 'large', 'xl'])('preserves v2 font %s', (fontSize) => {
    expect(withDefaults({ settingsVersion: 2, fontSize }, d).fontSize).toBe(fontSize);
  });

  it('round trips optional preferences through JSON and normalization', () => {
    const raw = {
      ...d, uiScale: 1.15, contrast: 'system', alwaysOnTop: true,
      overlay: { fontDelta: -2.5, bounds: { x: -100, y: 0, width: 640, height: 120 }, clickThrough: true },
      shortcuts: { toggleOverlay: 'Alt+Command+F', toggleRecording: null },
    };
    expect(withDefaults(JSON.parse(JSON.stringify(raw)), d)).toEqual(raw);
    for (const uiScale of [1, 1.15, 1.3]) {
      expect(withDefaults({ uiScale }, d).uiScale).toBe(uiScale);
    }
    for (const contrast of ['standard', 'more', 'system']) {
      expect(withDefaults({ contrast }, d).contrast).toBe(contrast);
    }
  });

  it('rejects malformed values without coercion', () => {
    for (const raw of [null, [], true, 42, 'settings']) {
      expect(withDefaults(raw, d)).toEqual(d);
    }
    const s = withDefaults({
      settingsVersion: '2', fontSize: 'medium', uiScale: '1.15', contrast: 'high',
      overlay: { fontDelta: Infinity, clickThrough: 1, bounds: { x: 0, y: 0, width: -1, height: 120 } },
      shortcuts: { toggleOverlay: '', toggleRecording: 5, toggleClickThrough: null, unknown: 'X' },
      translation: { cloud: { baseURL: {}, apiKey: 5, model: true } },
    }, d);
    expect(s.settingsVersion).toBe(2);
    expect(s.fontSize).toBe('small');
    expect(s.uiScale).toBe(1);
    expect(s.contrast).toBe('standard');
    expect(s.overlay).toEqual({ fontDelta: 0, clickThrough: false });
    expect(s.shortcuts).toEqual({ toggleClickThrough: null });
    expect(s.translation.cloud).toEqual(d.translation.cloud);
    for (const value of [null, [], 'bad', 3]) {
      const normalized = withDefaults({ overlay: value, shortcuts: value }, d);
      expect(normalized.overlay).toBeUndefined();
      expect(normalized.shortcuts).toBeUndefined();
    }
    for (const value of [NaN, Infinity, '0', null]) {
      expect(withDefaults({ overlay: { fontDelta: value } }, d).overlay?.fontDelta).toBe(0);
    }
  });
});
