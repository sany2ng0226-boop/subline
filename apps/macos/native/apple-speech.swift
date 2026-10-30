import Foundation
import Speech
import AVFoundation
import Darwin

private final class FinishFailure: @unchecked Sendable {
  private let lock = NSLock()
  private var message: String?
  func set(_ value: String) { lock.lock(); message = value; lock.unlock() }
  func get() -> String? { lock.lock(); defer { lock.unlock() }; return message }
}

private enum Output {
  private static let lock = NSLock()
  static func send(_ value: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    data.append(0x0a)
    lock.lock()
    defer { lock.unlock() }
    try? FileHandle.standardOutput.write(contentsOf: data)
  }
}

@available(macOS 26.0, *)
private actor SpeechHost {
  private var language = "ja"
  private var sessionID = 0
  private var analyzer: SpeechAnalyzer?
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var resultsTask: Task<Void, Never>?
  private var sourceFormat: AVAudioFormat?
  private var targetFormat: AVAudioFormat?
  private var converter: AVAudioConverter?

  private func locale(for language: String) async throws -> Locale {
    let identifiers = ["ja": "ja-JP", "zh": "zh-CN", "en": "en-US", "ko": "ko-KR"]
    guard SpeechTranscriber.isAvailable, let identifier = identifiers[language],
          let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier)) else {
      throw failure("此设备不支持所选 Apple 识别语言，请选择日语、中文、英语或韩语")
    }
    return locale
  }

  private func failure(_ text: String) -> NSError {
    NSError(domain: "SublineAppleSpeech", code: -1, userInfo: [NSLocalizedDescriptionKey: text])
  }

  func handle(_ value: [String: Any]) async {
    let kind = value["type"] as? String ?? ""
    do {
      switch kind {
      case "setup":
        let requestedLanguage = value["language"] as? String ?? language
        let selectedLocale = try await locale(for: requestedLanguage)
        if value["download"] as? Bool == true {
          let module = SpeechTranscriber(locale: selectedLocale, preset: .progressiveTranscription)
          if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
            try await request.downloadAndInstall()
          }
        }
        let ready = await SpeechTranscriber.installedLocales.contains(selectedLocale)
        Output.send(["type": "setup", "supported": true, "asrReady": ready])
      case "init":
        language = value["language"] as? String ?? "ja"
        let selectedLocale = try await locale(for: language)
        guard await SpeechTranscriber.installedLocales.contains(selectedLocale) else {
          throw failure("Apple 识别语言包尚未安装，请先在设置中准备系统语言模型")
        }
        Output.send(["type": "ready"])
      case "reset":
        _ = await finish(cancel: true)
        sessionID = value["sessionId"] as? Int ?? sessionID + 1
        try await begin()
      case "audio":
        guard let encoded = value["samples"] as? String, let data = Data(base64Encoded: encoded),
              !data.isEmpty, data.count % 4 == 0, data.count <= 256_000 else {
          throw failure("Apple 识别收到无效音频数据")
        }
        try accept(data)
      case "flush":
        if let error = await finish(cancel: false) { throw failure(error) }
        Output.send(["type": "flushed", "requestId": value["requestId"] ?? NSNull()])
      default:
        throw failure("未知 Apple 识别命令")
      }
    } catch {
      if kind == "setup" {
        Output.send(["type": "setup", "supported": false, "asrReady": false, "error": error.localizedDescription])
      } else {
        Output.send(["type": "error", "message": error.localizedDescription, "sessionId": sessionID])
      }
    }
  }

  private func begin() async throws {
    let selectedLocale = try await locale(for: language)
    let transcriber = SpeechTranscriber(locale: selectedLocale, preset: .progressiveTranscription)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let source = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000,
                               channels: 1, interleaved: false)!
    guard let target = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber], considering: source) else {
      throw failure("无法准备 Apple 识别音频格式")
    }
    let conversion = source == target ? nil : AVAudioConverter(from: source, to: target)
    guard source == target || conversion != nil else { throw failure("无法转换 Apple 识别音频格式") }
    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingOldest(256))
    self.analyzer = analyzer
    self.input = continuation
    sourceFormat = source
    targetFormat = target
    converter = conversion
    let currentSession = sessionID
    let currentLanguage = language
    resultsTask = Task {
      var id = 0
      do {
        for try await result in transcriber.results {
          let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
          guard !text.isEmpty else { continue }
          if result.isFinal {
            id += 1
            Output.send(["type": "segment", "sessionId": currentSession, "id": id,
                         "text": text, "lang": currentLanguage,
                         "start": result.range.start.seconds, "duration": result.range.duration.seconds])
            Output.send(["type": "partial", "sessionId": currentSession, "text": ""])
          } else {
            Output.send(["type": "partial", "sessionId": currentSession, "text": text])
          }
        }
      } catch {
        if !Task.isCancelled {
          Output.send(["type": "error", "message": error.localizedDescription, "sessionId": currentSession])
        }
      }
    }
    do {
      try await analyzer.prepareToAnalyze(in: target)
      try await analyzer.start(inputSequence: stream)
    } catch {
      _ = await finish(cancel: true)
      throw error
    }
  }

  private func yield(_ buffer: AVAudioPCMBuffer) throws {
    guard buffer.frameLength > 0, let input else { return }
    if case .dropped = input.yield(AnalyzerInput(buffer: buffer)) {
      throw failure("Apple 识别处理音频过慢，请停止录音后重试")
    }
  }

  private func accept(_ data: Data) throws {
    guard let source = sourceFormat, let target = targetFormat, input != nil else {
      throw failure("Apple 识别会话尚未开始")
    }
    let frames = AVAudioFrameCount(data.count / 4)
    guard let buffer = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: frames),
          let channel = buffer.floatChannelData?[0] else { throw failure("无法分配识别音频缓冲") }
    buffer.frameLength = frames
    data.withUnsafeBytes { bytes in _ = memcpy(channel, bytes.baseAddress!, data.count) }
    guard let converter else { try yield(buffer); return }
    let capacity = AVAudioFrameCount(ceil(Double(frames) * target.sampleRate / source.sampleRate)) + 1024
    guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
      throw failure("无法分配转换音频缓冲")
    }
    var supplied = false
    var error: NSError?
    converter.convert(to: converted, error: &error) { _, status in
      if supplied { status.pointee = .noDataNow; return nil }
      supplied = true
      status.pointee = .haveData
      return buffer
    }
    if let error { throw error }
    try yield(converted)
  }

  private func finish(cancel: Bool) async -> String? {
    guard let analyzer else { return nil }
    let failure = FinishFailure()
    if !cancel, let converter, let target = targetFormat,
       let tail = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: 2048) {
      var error: NSError?
      converter.convert(to: tail, error: &error) { _, status in status.pointee = .endOfStream; return nil }
      if error == nil { try? yield(tail) }
    }
    input?.finish()
    input = nil
    if cancel {
      resultsTask?.cancel()
      await analyzer.cancelAndFinishNow()
    } else {
      let deadline = Task {
        do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch { return }
        failure.set("Apple 识别收尾超时，请重试")
        await analyzer.cancelAndFinishNow()
      }
      do { try await analyzer.finalizeAndFinishThroughEndOfInput() }
      catch { failure.set(error.localizedDescription); await analyzer.cancelAndFinishNow() }
      await resultsTask?.value
      deadline.cancel()
    }
    await resultsTask?.value
    resultsTask = nil
    self.analyzer = nil
    converter = nil
    sourceFormat = nil
    targetFormat = nil
    return failure.get()
  }

  func shutdown() async { _ = await finish(cancel: true) }
}

@main
private struct AppleSpeechMain {
  static func main() async {
    guard #available(macOS 26.0, *) else {
      Output.send(["type": "error", "message": "Apple 语音识别需要 macOS 26 或更新版本"])
      return
    }
    let parentPID = getppid()
    let parentWatchdog = Task.detached(priority: .background) {
      while !Task.isCancelled {
        do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
        // EOF cannot interrupt an in-flight system model download if the parent is killed.
        if parentPID <= 1 || getppid() != parentPID { Darwin._exit(EXIT_FAILURE) }
      }
    }
    let host = SpeechHost()
    let (lines, continuation) = AsyncStream<String>.makeStream(bufferingPolicy: .bufferingOldest(64))
    let reader = Task.detached {
      while let line = readLine() {
        guard line.utf8.count <= 512_000 else {
          Output.send(["type": "error", "message": "识别音频消息过大"])
          break
        }
        if case .dropped = continuation.yield(line) {
          Output.send(["type": "error", "message": "识别音频队列已满"])
          break
        }
      }
      continuation.finish()
    }
    for await line in lines {
      guard let data = line.data(using: .utf8),
            let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        Output.send(["type": "error", "message": "识别命令格式无效"])
        continue
      }
      await host.handle(value)
    }
    reader.cancel()
    await host.shutdown()
    parentWatchdog.cancel()
  }
}
