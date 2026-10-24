// 模型下载源治理的单元测试：自托管 GitHub Release 直链、HF 上游(+镜像)有序列表、缓存键主机不可变。
import { describe, expect, it } from 'vitest';
import {
  HF,
  HF_MIRRORS,
  HF_REVISIONS,
  SELF_HOSTED_ENABLED,
  SELF_HOSTED_PINS,
  nativeModelUrls,
  SELF_HOSTED,
  TRANSFORMERS_REMOTE_HOST,
  hfResolveUrls,
  selfHostedAsset,
} from './model-sources';

describe('selfHostedAsset', () => {
  it('拼接自托管 GitHub Release（models-v1）的扁平资产直链', () => {
    expect(selfHostedAsset('silero_vad.onnx')).toBe(
      'https://github.com/sany2ng0226-boop/subline/releases/download/models-v1/silero_vad.onnx',
    );
    expect(selfHostedAsset('sense-voice-model.int8.onnx')).toBe(
      'https://github.com/sany2ng0226-boop/subline/releases/download/models-v1/sense-voice-model.int8.onnx',
    );
  });

  it('随 SELF_HOSTED 配置拼接（owner/repo/tag 均来自配置）', () => {
    const { host, owner, repo, tag } = SELF_HOSTED;
    expect(selfHostedAsset('silero_vad.onnx')).toBe(`${host}/${owner}/${repo}/releases/download/${tag}/silero_vad.onnx`);
  });
});

describe('hfResolveUrls', () => {
  it('主源在首、各镜像按序追加', () => {
    const urls = hfResolveUrls('Xenova/m2m100_418M', 'onnx/encoder_model_quantized.onnx');
    expect(urls[0]).toBe(
      'https://huggingface.co/Xenova/m2m100_418M/resolve/main/onnx/encoder_model_quantized.onnx',
    );
    // 列表长度 = 1 主源 + 镜像数；主源恒为 HF.host。
    expect(urls.length).toBe(1 + HF_MIRRORS.length);
    expect(urls[0].startsWith(HF.host)).toBe(true);
    for (let i = 0; i < HF_MIRRORS.length; i++) {
      expect(urls[i + 1]).toBe(
        `${HF_MIRRORS[i]}/Xenova/m2m100_418M/resolve/main/onnx/encoder_model_quantized.onnx`,
      );
    }
  });
});

describe('TRANSFORMERS_REMOTE_HOST（web 翻译缓存键主机，不可变）', () => {
  it('恒为 Transformers.js 默认 remoteHost，绝不跟随 HF 下载镜像切换', () => {
    // 这是缓存键主机（离线加载 cache.match 用），与可切换的下载源 HF/HF_MIRRORS 严格分离。
    expect(TRANSFORMERS_REMOTE_HOST).toBe('https://huggingface.co/');
  });
});


describe('model pins and future mirror', () => {
  it('keeps the unpublished Subline release disabled and allows unpinned upstream files', () => {
    expect(SELF_HOSTED_ENABLED).toBe(false);
    const upstream = ['https://example.com/future-model.bin'];
    expect(nativeModelUrls('future-model.bin', upstream)).toEqual(upstream);
    expect(nativeModelUrls('silero_vad.onnx', upstream)).toEqual(upstream);
    expect(() => selfHostedAsset('future-model.bin')).toThrow(/未登记/);
  });

  it('preserves the patch pin table and immutable HF revisions', () => {
    expect(Object.keys(SELF_HOSTED_PINS)).toHaveLength(25);
    for (const [asset, pin] of Object.entries(SELF_HOSTED_PINS)) {
      expect(Number.isInteger(pin.bytes) && pin.bytes > 0, asset).toBe(true);
      expect(pin.sha256, asset).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(HF_REVISIONS)).toHaveLength(5);
    for (const revision of Object.values(HF_REVISIONS)) expect(revision).toMatch(/^[0-9a-f]{40}$/);
    const revision = HF_REVISIONS['Xenova/m2m100_418M'];
    expect(hfResolveUrls('Xenova/m2m100_418M', 'config.json', revision)[0])
      .toBe(`https://huggingface.co/Xenova/m2m100_418M/resolve/${revision}/config.json`);
  });
});
