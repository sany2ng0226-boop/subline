// 模型下载源的单一治理点（平台无关、纯逻辑）：所有下载源基址 / host / release tag / 命名约定
// 收敛于此。ASR 与翻译两类模型、macOS/iOS/web 三端共用，避免各处硬编码基址而漂移。
//
// 按端分源：native（macOS/iOS，Node fetch / URLSession，自动跟随重定向、不受 CORS 约束）优先走
// 上游源；web（浏览器 fetch，受 CORS 约束）走发 CORS 头的上游 HuggingFace 源。
// 每个文件在每一端都是一个「有序 URL 列表」，下载器按序尝试、每个只试一次、全部失败才判失败
// （见各端下载器）。上游可追加镜像做 fallback（HF_MIRRORS）。
//
// 关键：下载源（可切换镜像）与 Transformers.js 缓存键（不可变，见 TRANSFORMERS_REMOTE_HOST）
// 严格分离——换镜像只影响下载走哪个地址，缓存键恒定，web 翻译离线加载才不会 miss。

/**
 * 自托管模型资产源（Subline 自己的 GitHub Release）。资产以扁平命名 `<模型id>-<原文件名>`
 * （公共依赖 Silero VAD 无前缀）上传到同一 release tag，各注册表据此构造下载直链。
 * 资产内容与 SELF_HOSTED_PINS 逐一对应；转存与上传见 scripts/mirror-model-assets.mjs。
 */
export const SELF_HOSTED_ENABLED: boolean = false;

export const UPSTREAM_MODEL_RELEASE = 'https://github.com/baijunjie/realtime-translator/releases/download/models-v1';

export const SELF_HOSTED = {
  host: 'https://github.com',
  owner: 'sany2ng0226-boop',
  repo: 'subline',
  tag: 'models-v1',
} as const;

/**
 * 自托管资产的固定字节数与 SHA-256（键为扁平资产名）。native 下载器据此校验每个下载源，
 * 内容不符即判该源失败；HF 兜底源锁定在 HF_REVISIONS 的提交上，内容与这里一致。
 */
export const SELF_HOSTED_PINS: Readonly<Record<string, { bytes: number; sha256: string }>> = {
  'silero_vad.onnx': { bytes: 643_854, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6' },
  'sense-voice-model.int8.onnx': { bytes: 239_233_841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
  'sense-voice-tokens.txt': { bytes: 315_894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
  'paraformer-zh-model.int8.onnx': { bytes: 227_330_205, sha256: '90bc03034ae1bef9575f8cc798cd1519c8be8aa9e8b458a033e32017ff4d584c' },
  'paraformer-zh-tokens.txt': { bytes: 75_354, sha256: '6c0e3b35cece259829e6cb5b8d90d13db88f61ea3a2953d11898e4b2bfd7a2e2' },
  'zipformer-ja-reazonspeech-encoder-epoch-99-avg-1.int8.onnx': { bytes: 154_670_139, sha256: '2c7bd08a8a99f9ddd0d9e458456577b1f6279214e51426f114f9eced44c54e1d' },
  'zipformer-ja-reazonspeech-decoder-epoch-99-avg-1.onnx': { bytes: 11_767_836, sha256: '58b18211ae06265466bfa17172dab574df94f76c8bcb61a3640c28ba860e4124' },
  'zipformer-ja-reazonspeech-joiner-epoch-99-avg-1.int8.onnx': { bytes: 2_696_970, sha256: '49cc7ea1d3d35a40a27442db5e89996da64bf0e683a903dce76e99e57a12e4de' },
  'zipformer-ja-reazonspeech-tokens.txt': { bytes: 45_754, sha256: '2c3ac659818a48a0c04010e0593bbc4d7c8a24a054340b01131499c05fd52def' },
  'parakeet-tdt-0.6b-v2-en-encoder.int8.onnx': { bytes: 652_184_296, sha256: 'a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab' },
  'parakeet-tdt-0.6b-v2-en-decoder.int8.onnx': { bytes: 7_257_753, sha256: 'b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e' },
  'parakeet-tdt-0.6b-v2-en-joiner.int8.onnx': { bytes: 1_739_080, sha256: '7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2' },
  'parakeet-tdt-0.6b-v2-en-tokens.txt': { bytes: 9_384, sha256: 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d' },
  'm2m100_418M-config.json': { bytes: 908, sha256: '1dbdf77ddc7809acd4c54ccf0eab46f840b40174afb1b6f6de8787244e832938' },
  'm2m100_418M-generation_config.json': { bytes: 233, sha256: '722210dd0bee7bef4e8e7f9a8574d8c56a2dfff723d73f390ce67892740b9009' },
  'm2m100_418M-tokenizer_config.json': { bytes: 1_813, sha256: 'bacfd4b9da25a61e01f17abe660465f616c9a1a3f5e23ab9ad3326c3788f2d9f' },
  'm2m100_418M-tokenizer.json': { bytes: 7_988_527, sha256: '03d9e111731c2d71f39a2c2a88499743e4c251385d07f0384b4349a23ba54363' },
  'm2m100_418M-encoder_model_quantized.onnx': { bytes: 287_856_370, sha256: '13a94e354a9140764eb81102d77d3ec6952d796e6f113c651eeb3c3443da0386' },
  'm2m100_418M-decoder_model_merged_quantized.onnx': { bytes: 344_128_178, sha256: '007654bcabb6cea6fd3bde34ce933137b431330b3755781145d7b6906270b45a' },
  'm2m100_1.2B-config.json': { bytes: 975, sha256: '5cfcd6201ef135a3c1b4eb347b8480233b82c58b0497e3f9cdb73b120d49f042' },
  'm2m100_1.2B-generation_config.json': { bytes: 228, sha256: '504ce33f9d06ecbbdac4a81777098a0e4ca7a6f12696d571b9205eb0e1067b19' },
  'm2m100_1.2B-tokenizer_config.json': { bytes: 1_813, sha256: 'bacfd4b9da25a61e01f17abe660465f616c9a1a3f5e23ab9ad3326c3788f2d9f' },
  'm2m100_1.2B-tokenizer.json': { bytes: 7_988_527, sha256: '03d9e111731c2d71f39a2c2a88499743e4c251385d07f0384b4349a23ba54363' },
  'm2m100_1.2B-encoder_model_quantized.onnx': { bytes: 642_465_668, sha256: '26a5de58617bcbafc5c4cacf3d0d21022fd073b96ed33d2c12d5540487f70e56' },
  'm2m100_1.2B-decoder_model_merged_quantized.onnx': { bytes: 881_293_982, sha256: '4a2ab043533fbc790b3f5f6605a4135fdddda9139debb074c023b4148e78f219' },
};

/**
 * HuggingFace 兜底源锁定的提交（键为 HF 仓库标识）。锁定后上游 main 再更新也不影响兜底下载的内容，
 * 各文件与 SELF_HOSTED_PINS 的字节数和 SHA-256 一致。
 */
export const HF_REVISIONS: Readonly<Record<string, string>> = {
  'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17': '2365baeacb507f821a0c8120fcee3d484dba7a07',
  'csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09': '906992d326ebf0c5171cde675aa0902be9e5bc6c',
  'csukuangfj/reazonspeech-k2-v2': '7ebed8f70b8ef67f656aa08e3084e5885202d0e6',
  'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8': '1ab9323565ddb038682214b292f588070a538ce2',
  'Xenova/m2m100_418M': '9c374f0b7aca709787cea97b047bfbbd1559d177',
};

/** 上游 HuggingFace 主机（web 端下载主源，可切换镜像；见 HF_MIRRORS）。 */
export const HF = {
  host: 'https://huggingface.co',
} as const;

/**
 * 可选的 HuggingFace 下载镜像，按序追加到主源之后作为 fallback（如国内 'https://hf-mirror.com'）。
 * 空数组表示无镜像兜底。**只影响下载源**，绝不影响 Transformers.js 缓存键（见 TRANSFORMERS_REMOTE_HOST）。
 */
export const HF_MIRRORS: readonly string[] = [];

/**
 * Transformers.js 浏览器端缓存键使用的固定主机（其 env.remoteHost 默认值）。web 翻译模型以
 * allowRemoteModels=false 离线加载时，Transformers.js 按此主机构造缓存键 cache.match，故此值
 * **不可变、绝不跟随 HF 下载镜像切换**——否则 web 下载落在镜像键、而离线加载按此主机键查找，缓存全 miss。
 * 与下载源（HF/HF_MIRRORS）解耦：下载走哪个镜像都行，缓存键恒为此主机。
 */
export const TRANSFORMERS_REMOTE_HOST = 'https://huggingface.co/';

/** 构造自托管 GitHub Release 资产的下载直链。asset 为已按约定命名的扁平资产名。 */
export function selfHostedAsset(asset: string): string {
  if (!SELF_HOSTED_PINS[asset]) throw new Error(`自托管资产未登记字节数与 SHA-256: ${asset}`);
  const { host, owner, repo, tag } = SELF_HOSTED;
  return `${host}/${owner}/${repo}/releases/download/${tag}/${asset}`;
}

/**
 * 构造某 HuggingFace 仓库某文件的上游 resolve 直链列表（主源 + 各镜像，按序，主源在首）。
 * @param repo 仓库标识，形如 'csukuangfj/sherpa-onnx-...' 或 'Xenova/m2m100_418M'
 * @param rel  仓内相对路径（含子目录，如 'onnx/encoder_model_quantized.onnx'）
 */
export function hfResolveUrls(repo: string, rel: string, revision = 'main'): string[] {
  return [HF.host, ...HF_MIRRORS].map((host) => `${host}/${repo}/resolve/${revision}/${rel}`);
}

/** Future mirror is opt-in; models-v1 in the Subline repository is not published yet. */
export function nativeModelUrls(asset: string, upstream: string[]): string[] {
  return SELF_HOSTED_ENABLED && SELF_HOSTED_PINS[asset]
    ? [selfHostedAsset(asset), ...upstream]
    : upstream;
}
