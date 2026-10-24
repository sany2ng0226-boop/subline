// ASR 模型注册表的单元测试：查表、按语言/平台过滤、齐全性文件清单。
import { describe, expect, it } from 'vitest';
import { HF_REVISIONS, SELF_HOSTED_PINS } from './model-sources';
import {
  ASR_MODELS,
  DEFAULT_ASR_MODEL_ID,
  SILERO_VAD,
  asrModelsFor,
  getAsrModel,
  requiredAsrFiles,
} from './models';

describe('ASR 模型注册表', () => {
  it('默认模型存在、多语种且全平台可用', () => {
    const m = getAsrModel(DEFAULT_ASR_MODEL_ID);
    expect(m).toBeDefined();
    expect(m?.languages).toContain('auto');
    expect(m?.platforms).toEqual(expect.arrayContaining(['macos', 'web', 'ios']));
  });

  it('每个模型 approxBytes 等于其文件字节之和（ASR 每文件登记字节）', () => {
    for (const m of ASR_MODELS) {
      const sum = m.files.reduce((acc, f) => acc + f.approxBytes, 0);
      expect(m.approxBytes).toBe(sum);
    }
  });

  it('getAsrModel 未知 id 返回 undefined', () => {
    expect(getAsrModel('nope')).toBeUndefined();
  });
});

describe('asrModelsFor', () => {
  it('auto 仅命中多语种模型', () => {
    expect(asrModelsFor('auto', 'macos').map((m) => m.id)).toEqual(['sense-voice']);
  });

  it('按语言+平台过滤（ja 在 macOS）', () => {
    const ids = asrModelsFor('ja', 'macos').map((m) => m.id);
    expect(ids).toContain('sense-voice');
    expect(ids).toContain('zipformer-ja-reazonspeech');
  });

  it('web 平台含专用模型（sense-voice + 各语言专用）', () => {
    expect(asrModelsFor('zh', 'web').map((m) => m.id)).toEqual(['sense-voice', 'paraformer-zh']);
    expect(asrModelsFor('ja', 'web').map((m) => m.id)).toEqual([
      'sense-voice',
      'zipformer-ja-reazonspeech',
    ]);
    expect(asrModelsFor('en', 'web').map((m) => m.id)).toEqual([
      'sense-voice',
      'parakeet-tdt-0.6b-v2-en',
    ]);
  });

  it('ios 平台仅 sense-voice', () => {
    expect(asrModelsFor('zh', 'ios').map((m) => m.id)).toEqual(['sense-voice']);
    expect(asrModelsFor('ja', 'ios').map((m) => m.id)).toEqual(['sense-voice']);
    expect(asrModelsFor('en', 'ios').map((m) => m.id)).toEqual(['sense-voice']);
  });
});

describe('ASR upstream sources and pins', () => {
  it('uses official VAD upstream and preserves its verification pin', () => {
    expect(SILERO_VAD.nativeUrls).toEqual([
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    ]);
    expect(SILERO_VAD.webUrls).toEqual([]);
    expect({ bytes: SILERO_VAD.expectedBytes, sha256: SILERO_VAD.sha256 })
      .toEqual(SELF_HOSTED_PINS['silero_vad.onnx']);
  });

  it('uses pinned HF revisions for native and web ASR downloads', () => {
    for (const m of ASR_MODELS) {
      for (const f of m.files) {
        expect(f.nativeUrls).toEqual(f.webUrls);
        expect(f.nativeUrls.length).toBeGreaterThan(0);
        for (const url of f.nativeUrls) {
          const [, repo, revision] = url.match(/huggingface\.co\/(csukuangfj\/[^/]+)\/resolve\/([^/]+)\//)!;
          expect(revision).toBe(HF_REVISIONS[repo]);
          expect(url.endsWith(f.filename)).toBe(true);
        }
        expect({ bytes: f.expectedBytes, sha256: f.sha256 })
          .toEqual(SELF_HOSTED_PINS[`${m.id}-${f.filename}`]);
      }
    }
  });
});

describe('requiredAsrFiles', () => {
  it('含公共依赖 VAD + 该模型全部文件（POSIX 相对路径）', () => {
    const files = requiredAsrFiles('sense-voice');
    expect(files[0]).toBe('silero_vad.onnx');
    expect(files).toContain(
      'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/model.int8.onnx',
    );
    expect(files).toContain('sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tokens.txt');
  });

  it('未知 id 仅返回 VAD', () => {
    expect(requiredAsrFiles('nope')).toEqual([SILERO_VAD.filename]);
  });
});
