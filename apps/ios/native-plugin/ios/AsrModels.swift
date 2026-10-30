// AsrModels.swift — GENERATED, do not edit by hand.
//
// 由 apps/ios/native-plugin/scripts/gen-asr-models-swift.mjs 从 @rt/core 的共享
// ASR 模型登记表（packages/core/src/models.ts）生成。登记表变更后请重跑：
//   pnpm --filter @rt/ios gen:models
//
// 与 macOS 端 (apps/macos/src/main/model-downloader.ts) 消费同一份登记表，保证
// URL/文件名/目录/角色/校验清单不漂移。只含 platforms 含 'ios' 的模型 + 公共依赖 Silero VAD。

import Foundation

/// 单个需下载的 ASR 模型文件（对应 @rt/core 的 AsrModelFile）。
struct AsrModelFile {
  /// 注册表提供的下载源有序列表（默认上游；自托管须显式启用）。下载器按序尝试、每个只试一次，
  /// 全部失败才判失败；URLSession 自动跟随重定向。
  let urls: [String]
  /// 落地文件名。
  let filename: String
  /// 目标子目录（相对 models 根目录）。空串表示直接放在 models 根目录下。
  let dir: String
  /// 该文件在识别器配置中的角色（model/tokens/encoder/decoder/joiner）；公共依赖 VAD 为空串。
  let role: String
  /// 近似大小（字节），用于下载进度估算，非精确值。
  let approxBytes: Int
  /// 精确大小与 SHA-256 可选；没有 pin 的新模型仍可下载。
  let expectedBytes: Int?
  let sha256: String?
}

/// 一个可选用的 ASR 模型规格（对应 @rt/core 的 AsrModelSpec，已按平台过滤为仅含 iOS 支持者）。
struct AsrModelSpec {
  /// 注册表 id（设置 asr.model 存的就是它）。
  let id: String
  /// 模型文件所在子目录（相对 models 根目录）。
  let dir: String
  /// 识别引擎类型，用于选择 sherpa-onnx 或系统识别管线。
  let engine: String
  /// 该模型的全部需下载文件（不含公共依赖 Silero VAD）。
  let files: [AsrModelFile]
  /// 该模型全部文件合计近似字节。
  let approxBytes: Int
}

enum AsrModels {
  /// 默认 ASR 模型 id（多语种、全平台可用）。
  static let defaultModelId = "sense-voice"

  /// Silero VAD：下载型 ASR 的语音端点检测依赖；系统识别管线无需该文件。
  static let vad = AsrModelFile(urls: ["https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"], filename: "silero_vad.onnx", dir: "", role: "", approxBytes: 643854, expectedBytes: 643854, sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6")

  /// iOS 支持的全部 ASR 模型规格（platforms 含 'ios'）。
  static let models: [AsrModelSpec] = [
    AsrModelSpec(
      id: "apple-speech",
      dir: "",
      engine: "appleSpeech",
      files: [

      ],
      approxBytes: 0
    ),
    AsrModelSpec(
      id: "sense-voice",
      dir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
      engine: "senseVoice",
      files: [
        AsrModelFile(urls: ["https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx"], filename: "model.int8.onnx", dir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", role: "model", approxBytes: 239233841, expectedBytes: 239233841, sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"),
        AsrModelFile(urls: ["https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt"], filename: "tokens.txt", dir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17", role: "tokens", approxBytes: 315894, expectedBytes: 315894, sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"),
      ],
      approxBytes: 239549735
    ),
  ]

  /// 按 id 取模型规格。
  static func model(id: String) -> AsrModelSpec? {
    return models.first { $0.id == id }
  }

  /// 某模型的全部必需文件（公共依赖 Silero VAD + 该模型自身文件）；未知 id 仅返回 VAD。
  static func requiredFiles(id: String) -> [AsrModelFile] {
    return [vad] + (model(id: id)?.files ?? [])
  }
}
