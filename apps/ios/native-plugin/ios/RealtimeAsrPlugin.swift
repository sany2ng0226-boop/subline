//
//  RealtimeAsrPlugin.swift
//  Realtime Translator — iOS on-device ASR Capacitor plugin.
//
//  On-device speech-to-text using sherpa-onnx (k2-fsa) v1.13.3:
//    - Silero VAD segments speech from a 16 kHz mono Float32 mic stream.
//    - SenseVoice (multilingual: zh/en/ja/ko/yue) offline-recognizes each segment.
//  Mirrors the macOS reference pipeline (apps/macos/src/main/pipeline.ts): partial
//  result while speaking (best-effort) + a finalized segment when the VAD closes a
//  speech chunk. Audio capture is AVAudioEngine; conversion to 16 kHz mono Float32 is
//  done with AVAudioConverter.
//
//  Depends on the vendored sherpa-onnx Swift wrapper (SherpaOnnx.swift) + the
//  sherpa-onnx.xcframework / onnxruntime.xcframework. See ../INTEGRATION.md for the
//  exact Xcode wiring (these are NOT auto-linked by `cap sync`).
//
//  Contract (must match ../definitions.ts):
//    Methods : start({modelId,language}), stop(), prewarm({modelId,language}),
//              getSetupStatus({modelId}), downloadModels({modelId}), listModels(),
//              deleteModel({id}), getMicStatus(), openMicSettings()
//    Events  : "partial"  -> { text: String }
//              "segment"  -> { id: Int, text: String, lang: String, start: Double, duration: Double }
//              "status"   -> { state: "loading"|"running"|"error"|"stopped", error?: String }
//              "setupProgress" -> { loaded: Int, total: Int }
//

import Foundation
import CryptoKit
import AVFoundation
import UIKit
import Capacitor

@objc(RealtimeAsrPlugin)
public class RealtimeAsrPlugin: CAPPlugin, CAPBridgedPlugin {
  // Capacitor 6+ 通过 CAPBridgedPlugin 发现插件（取代旧的 .m / CAP_PLUGIN 宏）
  public let identifier = "RealtimeAsrPlugin"
  public let jsName = "RealtimeAsr"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "prewarm", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getSetupStatus", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "downloadModels", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "listModels", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "deleteModel", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "cancelDownload", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getMicStatus", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "openPermissionSettings", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "openMicSettings", returnType: CAPPluginReturnPromise),
  ]

  /// Register AVAudioSession lifecycle observers once, when Capacitor loads the plugin.
  /// Interruptions (call/Siri/other audio), the current input becoming unavailable
  /// (e.g. headphones unplugged) and a media-services reset all stop the engine out of
  /// band; without handling them the UI would stay stuck "running" while capture is dead.
  override public func load() {
    lastMicPermission = currentMicPermission()
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(handleDidBecomeActive),
                       name: UIApplication.didBecomeActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(handleInterruption(_:)),
                       name: AVAudioSession.interruptionNotification, object: nil)
    center.addObserver(self, selector: #selector(handleRouteChange(_:)),
                       name: AVAudioSession.routeChangeNotification, object: nil)
    center.addObserver(self, selector: #selector(handleMediaServicesReset(_:)),
                       name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false }
  }

  // MARK: - Tunables (mirror apps/macos/src/main/pipeline.ts intent)

  /// SenseVoice / Silero VAD expect 16 kHz mono Float32.
  private let sampleRate = 16_000
  /// Silero VAD frame size (samples) — sherpa-onnx requires fixed 512-sample windows.
  private let vadWindowSize = 512
  /// VAD ring-buffer length (seconds). Matches macOS (long enough for whole utterances).
  private let vadBufferSeconds: Float = 120
  /// Min continuous silence before a segment is closed (s). Smaller = snappier finals.
  private let minSilenceSeconds: Float = 0.35
  /// Earlier speech onset to avoid clipping the first syllable.
  private let vadThreshold: Float = 0.35
  private let minSpeechSeconds: Float = 0.25
  /// Hard cap enforced by this plugin so a non-stop talker cannot grow an unbounded decode window.
  private let maxSpeechSeconds: Float = 7.0
  /// How often to run a best-effort partial over the in-progress speech buffer (s).
  private let partialIntervalSeconds: Double = 0.6

  // MARK: - Capacitor / threading state

  private let audioEngine = AVAudioEngine()
  /// All recognizer + VAD work runs here, off the audio render thread.
  private let asrQueue = DispatchQueue(label: "io.github.baijunjie.realtimetranslator.asr")

  private var recognizer: SherpaOnnxOfflineRecognizer?
  private var vad: SherpaOnnxVoiceActivityDetectorWrapper?
  /// Which model id / SenseVoice language the loaded recognizer was built for. start()/prewarm()
  /// rebuild the recognizer when either differs, so a settings change (model or forced language)
  /// takes effect on the next session. Both are only touched on asrQueue.
  private var loadedModelId: String?
  private var loadedLanguage: String?

  // 后台下载的取消协调（下载跑在 asrQueue 上、被信号量阻塞，故取消必须从别的线程操作这两个字段）：
  // downloadLock 保护跨线程访问；cancelDownload 置 downloadCancelled 并 cancel 在途 task 以解除阻塞。
  private let downloadLock = NSLock()
  private var downloadCancelled = false
  private var currentDownloadTask: URLSessionDataTask?

  private var isRunning = false
  /// Tracks whether an input tap is currently installed on the engine's bus. installTap on a
  /// bus that already has a tap raises an uncaught NSException, and a tap can outlive the engine
  /// when the system stops it (interruption / route loss), so removeTap must key off this flag
  /// rather than `audioEngine.isRunning`.
  private var tapInstalled = false
  private var segmentId = 0

  /// Carry-over of <512-sample remainders between buffers so VAD always gets full windows.
  private var pendingSamples: [Float] = []
  /// Raw 16 kHz samples since the current speech segment (best-effort) started — used for partials.
  private var speechBuffer: [Float] = []
  private struct RecognitionCandidate {
    let text: String
    let lang: String
  }
  /// Consecutive partial decodes provide the evidence used to protect a final from model collapse.
  /// Text and language stay atomic because auto LID may change between decodes.
  private var previousPartial: RecognitionCandidate?
  private var stablePartial: RecognitionCandidate?
  private var wasSpeechDetected = false
  /// Total 16 kHz samples consumed since start() — used for partial throttling.
  private var totalSamples = 0
  private var lastPartialAtSamples = 0

  // MARK: - Capacitor methods (match ../definitions.ts)

  /// Start on-device ASR: ensure the requested model is loaded, request mic, open capture, begin
  /// recognition. modelId + language come from the current settings (bridge.ts); defaults keep the
  /// method usable when called without options.
  @objc func start(_ call: CAPPluginCall) {
    let modelId = call.getString("modelId") ?? AsrModels.defaultModelId
    let language = call.getString("language") ?? "auto"
    requestMicPermission { [weak self] granted in
      guard let self = self else { return }
      guard granted else {
        let msg = "microphone permission denied"
        self.notifyListeners("status", data: ["state": "error", "error": msg, "code": "mic-permission"])
        call.resolve(["ok": false, "error": msg, "code": "mic-permission"])
        return
      }
      // Build recognizer/VAD + open the mic on the ASR queue (model load can take seconds).
      self.asrQueue.async {
        // Reentrancy guard: start/stop and the running flag are only touched on asrQueue, so
        // the serial queue makes this check cover both an already-running session and one still
        // in the (multi-second) model-load / startCapture phase — no double installTap.
        guard !self.isRunning else {
          self.notifyListeners("status", data: ["state": "running"])
          call.resolve(["ok": true])
          return
        }
        // Report "loading" only when a (re)build is actually needed — a cold start or a
        // model/language change. After prewarm with the same model+language the reuse path is
        // sub-second and flashing a model-loading hint would be misleading.
        if !self.engineMatches(modelId, language) {
          self.notifyListeners("status", data: ["state": "loading"])
        }
        do {
          try self.ensureEngineLoaded(modelId, language: language)
          self.resetPipelineState()
          try self.startCapture()
          self.isRunning = true
          self.notifyListeners("status", data: ["state": "running"])
          call.resolve(["ok": true])
        } catch {
          self.stopCapture()
          let msg = error.localizedDescription
          self.notifyListeners("status", data: ["state": "error", "error": msg, "code": "asr-init-failed"])
          call.resolve(["ok": false, "error": msg, "code": "asr-init-failed"])
        }
      }
    }
  }

  /// Stop capture + recognition, flush any trailing segment, release the audio session.
  /// stopCapture runs on asrQueue so it serializes with a still-pending startCapture (whose
  /// first run loads the model for seconds); otherwise a stop racing ahead of start would clear
  /// isRunning while the mic kept capturing.
  @objc func stop(_ call: CAPPluginCall) {
    asrQueue.async { [weak self] in
      guard let self = self else { call.resolve(["ok": true]); return }
      self.stopCapture()
      self.flushTrailingSegment()
      self.isRunning = false
      self.notifyListeners("partial", data: ["text": ""])
      self.notifyListeners("status", data: ["state": "stopped"])
      call.resolve(["ok": true])
    }
  }

  /// Prewarm the recognizer/VAD into memory without touching the microphone or requesting any
  /// permission. Idempotent. Resolves immediately while the load runs on the serial asrQueue,
  /// so a following start() enqueues behind it and its model-load phase becomes a no-op once
  /// loaded. The UI disables the record button before calling; every path except an active
  /// capture session must therefore end with a terminal "stopped" status to re-enable it.
  @objc func prewarm(_ call: CAPPluginCall) {
    let modelId = call.getString("modelId") ?? AsrModels.defaultModelId
    let language = call.getString("language") ?? "auto"
    call.resolve()
    asrQueue.async { [weak self] in
      guard let self = self else { return }
      // Active capture session: leave the "running" state untouched.
      guard !self.isRunning else { return }
      // Models not downloaded yet (the setup/download flow handles fetching), or the requested
      // engine is already loaded: nothing to load, just release the record button.
      guard self.modelsReady(modelId), !self.engineMatches(modelId, language) else {
        self.notifyListeners("status", data: ["state": "stopped"])
        return
      }
      self.notifyListeners("status", data: ["state": "loading"])
      do {
        try self.ensureEngineLoaded(modelId, language: language)
        self.notifyListeners("status", data: ["state": "stopped"])
      } catch {
        print("[prewarm] ASR engine load failed: \(error.localizedDescription)")
        self.notifyListeners("status", data: ["state": "stopped"])
      }
    }
  }

  // MARK: - AVAudioSession lifecycle (interruption / route change / media reset)

  /// Tear capture down in response to an out-of-band audio event (the engine is already stopped
  /// or invalid by this point). Flush any open segment, clear state, and push a terminal status
  /// so the UI leaves the running state. No auto-resume — the user restarts manually.
  private func abortCapture(reason: String?) {
    asrQueue.async { [weak self] in
      guard let self = self, self.isRunning else { return }
      self.stopCapture()
      self.flushTrailingSegment()
      self.isRunning = false
      self.notifyListeners("partial", data: ["text": ""])
      if let reason = reason {
        self.notifyListeners("status", data: ["state": "error", "error": reason, "code": "audio-interrupted"])
      } else {
        self.notifyListeners("status", data: ["state": "stopped"])
      }
    }
  }

  @objc private func handleInterruption(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
    // Interruption began (incoming call, Siri, another app took the session): the engine has
    // been stopped by the system. Reflect it as stopped rather than a stuck "running".
    if type == .began {
      abortCapture(reason: nil)
    }
  }

  @objc private func handleRouteChange(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
    // The active input went away (e.g. wired/Bluetooth mic unplugged). Its format no longer
    // matches the installed tap, so stop instead of risking an NSException on the stale tap.
    if reason == .oldDeviceUnavailable {
      abortCapture(reason: nil)
    }
  }

  @objc private func handleMediaServicesReset(_ note: Notification) {
    // The media server reset; every audio object (engine, tap, session) is now invalid.
    abortCapture(reason: "audio media services were reset")
  }

  /// Report whether the requested model's files (+ shared VAD) are present in the writable dir.
  @objc func getSetupStatus(_ call: CAPPluginCall) {
    let modelId = call.getString("modelId") ?? AsrModels.defaultModelId
    call.resolve(["asrReady": modelsReady(modelId)])
  }

  /// Ensure the requested model is available; download (model files + Silero VAD) on first run.
  /// Progress is reported via the "setupProgress" event; resolves when complete.
  @objc func downloadModels(_ call: CAPPluginCall) {
    let modelId = call.getString("modelId") ?? AsrModels.defaultModelId
    if modelsReady(modelId) {
      call.resolve(["ok": true])
      return
    }
    asrQueue.async { [weak self] in
      guard let self = self else { return }
      do {
        try self.downloadAllModels(modelId)
        call.resolve(["ok": true])
      } catch {
        call.resolve(["ok": false, "error": error.localizedDescription])
      }
    }
  }

  /// List each ASR model's on-disk state: files present (VAD + model files all intact) and the
  /// summed byte size. inUse is decided JS-side from settings, so it is not reported here.
  @objc func listModels(_ call: CAPPluginCall) {
    asrQueue.async { [weak self] in
      guard let self = self else { call.resolve(["models": []]); return }
      let root = self.modelsDir()
      var out: [[String: Any]] = []
      for spec in AsrModels.models {
        var downloaded = true
        var sizeBytes = 0
        for file in AsrModels.requiredFiles(id: spec.id) {
          let rel = file.dir.isEmpty ? file.filename : "\(file.dir)/\(file.filename)"
          let path = root.appendingPathComponent(rel).path
          if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
             let bytes = attrs[.size] as? Int {
            sizeBytes += bytes
            if !self.fileIsIntact(file, at: path) { downloaded = false }
          } else {
            downloaded = false
          }
        }
        out.append(["id": spec.id, "sizeBytes": sizeBytes, "downloaded": downloaded])
      }
      call.resolve(["models": out])
    }
  }

  /// Delete a downloaded ASR model. Refused while recording. Removes only the model's own files
  /// (the shared Silero VAD is left in place); releases the recognizer if the model being deleted
  /// is the one currently loaded, so the next start() rebuilds from disk (and finds it missing).
  @objc func deleteModel(_ call: CAPPluginCall) {
    guard let modelId = call.getString("id") else {
      call.resolve(["ok": false, "error": "missing model id"])
      return
    }
    asrQueue.async { [weak self] in
      guard let self = self else { call.resolve(["ok": false, "error": "plugin released"]); return }
      guard !self.isRunning else {
        call.resolve(["ok": false, "error": "cannot delete a model while recording"])
        return
      }
      guard let spec = AsrModels.model(id: modelId) else {
        call.resolve(["ok": false, "error": "unknown model id: \(modelId)"])
        return
      }
      // Drop the in-memory recognizer/VAD when deleting the currently loaded model.
      if self.loadedModelId == modelId {
        self.recognizer = nil
        self.vad = nil
        self.loadedModelId = nil
        self.loadedLanguage = nil
      }
      let root = self.modelsDir()
      do {
        if spec.dir.isEmpty {
          // Model files sit directly under models/: delete each one (never the whole root).
          for file in spec.files {
            let path = root.appendingPathComponent(file.filename).path
            if FileManager.default.fileExists(atPath: path) {
              try FileManager.default.removeItem(atPath: path)
            }
          }
        } else {
          let dir = root.appendingPathComponent(spec.dir, isDirectory: true)
          if FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.removeItem(at: dir)
          }
        }
        call.resolve(["ok": true])
      } catch {
        call.resolve(["ok": false, "error": error.localizedDescription])
      }
    }
  }

  /// Cancel the in-flight download of a model (if any) and delete its residue (back to not-downloaded).
  /// Must run OFF asrQueue: the download occupies asrQueue blocked on a semaphore, so we cancel the
  /// URLSession task here (unblocking it) and queue the file deletion behind the now-unwinding download.
  @objc func cancelDownload(_ call: CAPPluginCall) {
    guard let modelId = call.getString("id") else {
      call.resolve(["ok": true])
      return
    }
    downloadLock.lock()
    downloadCancelled = true
    let task = currentDownloadTask
    downloadLock.unlock()
    task?.cancel()
    // Delete residue on asrQueue so it runs after the cancelled download unwinds (no file-op race).
    asrQueue.async { [weak self] in
      guard let self = self else {
        call.resolve(["ok": true])
        return
      }
      if let spec = AsrModels.model(id: modelId) {
        let root = self.modelsDir()
        if spec.dir.isEmpty {
          for file in spec.files {
            try? FileManager.default.removeItem(atPath: root.appendingPathComponent(file.filename).path)
          }
        } else {
          try? FileManager.default.removeItem(at: root.appendingPathComponent(spec.dir, isDirectory: true))
        }
      }
      call.resolve(["ok": true])
    }
  }

  private var lastMicPermission: String = "unknown"

  @objc private func handleDidBecomeActive() {
    let state = currentMicPermission()
    guard state != lastMicPermission else { return }
    lastMicPermission = state
    notifyListeners("permissionChange", data: ["kind": "microphone", "state": state])
  }

  /// Map native permissions to the shared PermissionState enum.
  @objc func getMicStatus(_ call: CAPPluginCall) {
    let state = currentMicPermission()
    call.resolve(["state": state, "status": state])
  }

  /// Open the app's iOS Settings page so the user can grant microphone access.
  @objc func openMicSettings(_ call: CAPPluginCall) {
    openPermissionSettings(call)
  }

  @objc func openPermissionSettings(_ call: CAPPluginCall) {
    DispatchQueue.main.async {
      if let url = URL(string: UIApplication.openSettingsURLString) {
        UIApplication.shared.open(url)
      }
      call.resolve()
    }
  }

  // MARK: - Mic permission (iOS 17+ uses AVAudioApplication; older uses AVAudioSession)

  private func requestMicPermission(_ completion: @escaping (Bool) -> Void) {
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission { completion($0) }
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission { completion($0) }
    }
  }

  private func currentMicPermission() -> String {
    // AVAudioApplication.recordPermission (iOS 17+) and AVAudioSession.RecordPermission are
    // distinct enum types, so map each in its own branch rather than via a shared variable.
    if #available(iOS 17.0, *) {
      switch AVAudioApplication.shared.recordPermission {
      case .granted: return "granted"
      case .denied: return "denied"
      case .undetermined: return "not-determined"
      @unknown default: return "unknown"
      }
    } else {
      switch AVAudioSession.sharedInstance().recordPermission {
      case .granted: return "granted"
      case .denied: return "denied"
      case .undetermined: return "not-determined"
      @unknown default: return "unknown"
      }
    }
  }

  // MARK: - Audio capture (AVAudioEngine -> 16 kHz mono Float32)

  private func startCapture() throws {
    let session = AVAudioSession.sharedInstance()
    // .measurement minimizes system DSP for cleaner ASR input.
    try session.setCategory(.record, mode: .measurement, options: [])
    try session.setActive(true, options: [])

    let input = audioEngine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)

    guard let targetFormat = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: Double(sampleRate),
      channels: 1,
      interleaved: false
    ) else {
      throw asrError("cannot create 16kHz target format")
    }
    guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
      throw asrError("cannot create audio converter")
    }

    // Clear any tap left behind by a prior/interrupted session before installing a new one
    // (installing over an existing tap raises an uncaught NSException).
    if tapInstalled {
      input.removeTap(onBus: 0)
      tapInstalled = false
    }
    input.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { [weak self] buffer, _ in
      guard let self = self else { return }
      guard let samples = self.convertToTargetSamples(buffer, converter: converter,
                                                       targetFormat: targetFormat) else { return }
      // Hand off to the ASR queue — never block the realtime audio thread.
      self.asrQueue.async { self.processSamples(samples) }
    }
    tapInstalled = true

    audioEngine.prepare()
    try audioEngine.start()
    DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = true }
  }

  private func stopCapture() {
    DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = false }
    // Remove the tap based on our own flag, not audioEngine.isRunning: a system interruption
    // can stop the engine while leaving the tap installed, and the next start would then crash.
    if tapInstalled {
      audioEngine.inputNode.removeTap(onBus: 0)
      tapInstalled = false
    }
    if audioEngine.isRunning {
      audioEngine.stop()
    }
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
  }

  /// Convert one hardware buffer to 16 kHz mono Float32 samples.
  private func convertToTargetSamples(_ buffer: AVAudioPCMBuffer,
                                      converter: AVAudioConverter,
                                      targetFormat: AVAudioFormat) -> [Float]? {
    let ratio = targetFormat.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
    guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
      return nil
    }

    var fed = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
      if fed {
        status.pointee = .noDataNow
        return nil
      }
      fed = true
      status.pointee = .haveData
      return buffer
    }
    if error != nil { return nil }
    guard out.frameLength > 0, let channel = out.floatChannelData?[0] else { return nil }
    return Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
  }

  // MARK: - Recognition (sherpa-onnx: Silero VAD -> SenseVoice). Runs on asrQueue.

  private func resetPipelineState() {
    segmentId = 0
    pendingSamples.removeAll(keepingCapacity: true)
    speechBuffer.removeAll(keepingCapacity: true)
    previousPartial = nil
    stablePartial = nil
    wasSpeechDetected = false
    totalSamples = 0
    lastPartialAtSamples = 0
    vad?.reset()
  }

  /// Push 16 kHz samples through the VAD, emit partials while speaking, finalize
  /// segments the VAD closes (min-silence or max-speech). Mirrors macOS intent.
  private func processSamples(_ samples: [Float]) {
    guard isRunning, let vad = vad else { return }

    totalSamples += samples.count

    // Feed VAD in fixed 512-sample windows; carry the remainder to the next buffer.
    pendingSamples.append(contentsOf: samples)
    var offset = 0
    while offset + vadWindowSize <= pendingSamples.count {
      let window = Array(pendingSamples[offset..<(offset + vadWindowSize)])
      vad.acceptWaveform(samples: window)
      offset += vadWindowSize
    }
    if offset > 0 {
      pendingSamples.removeFirst(offset)
    }

    // Drain finalized segments FIRST, so a finalized segment (+ its trailing partial:"") is
    // emitted before any new-utterance partial from this same buffer. If a new utterance has
    // already begun when the VAD closes the previous one, emitting the new partial first lets
    // onSegment clobber it in the renderer and flicker the recognition→confirmation handoff.
    while !vad.isEmpty() {
      let segment = vad.front()
      vad.pop()
      finalizeSegment(samples: segment.samples, startSample: segment.start)
      // A real final landed; clear the in-progress partial.
      notifyListeners("partial", data: ["text": ""])
      speechBuffer.removeAll(keepingCapacity: true)
      lastPartialAtSamples = 0
    }

    let speaking = vad.isSpeechDetected()
    if speaking {
      if !wasSpeechDetected {
        // Onset of a new speech run.
        wasSpeechDetected = true
        speechBuffer.removeAll(keepingCapacity: true)
        previousPartial = nil
        stablePartial = nil
        lastPartialAtSamples = 0
      }
      speechBuffer.append(contentsOf: samples)
      if speechBuffer.count >= Int(maxSpeechSeconds * Float(sampleRate)) {
        forceFinalizeSpeechBuffer()
      } else {
        maybeEmitPartial()
      }
    } else if wasSpeechDetected {
      // Silence resumed — wait for the VAD to close the segment(s) above.
      wasSpeechDetected = false
    }
  }

  /// Best-effort live partial over the in-progress speech buffer (throttled).
  private func maybeEmitPartial() {
    guard let recognizer = recognizer, !speechBuffer.isEmpty else { return }
    let gap = Int(partialIntervalSeconds * Double(sampleRate))
    if totalSamples - lastPartialAtSamples < gap { return }
    lastPartialAtSamples = totalSamples

    let result = recognizer.decode(samples: speechBuffer, sampleRate: sampleRate)
    let text = cleanAsrText(result.text)
    if !text.isEmpty {
      let current = RecognitionCandidate(text: text, lang: normalizeLang(result.lang))
      if let previous = previousPartial {
        let agreed = trimTrailingUnstable(commonPrefix(previous.text, current.text))
        if !agreed.isEmpty && previous.lang == current.lang {
          if let stable = stablePartial,
             stable.lang != current.lang || !stable.text.hasPrefix(agreed) {
            stablePartial = RecognitionCandidate(text: agreed, lang: current.lang)
          } else if agreed.count > (stablePartial?.text.count ?? 0) {
            stablePartial = RecognitionCandidate(text: agreed, lang: current.lang)
          }
        }
      }
      previousPartial = current
      notifyListeners("partial", data: ["text": text])
    }
  }

  /// Ask VAD to close its current segment so continuous speech cannot make every subsequent partial
  /// re-decode an ever-growing window. Flushing preserves the VAD's pre-roll audio and sample clock;
  /// resetting here would clip the next segment's onset and make its timestamp jump backwards.
  private func forceFinalizeSpeechBuffer() {
    guard !speechBuffer.isEmpty, let vad = vad else { return }
    vad.flush()
    while !vad.isEmpty() {
      let segment = vad.front()
      vad.pop()
      finalizeSegment(samples: segment.samples, startSample: segment.start)
    }
    notifyListeners("partial", data: ["text": ""])
    speechBuffer.removeAll(keepingCapacity: true)
    wasSpeechDetected = false
    lastPartialAtSamples = totalSamples
  }

  /// On stop(): flush the VAD and finalize any segment still buffered.
  private func flushTrailingSegment() {
    guard let vad = vad else { return }
    vad.flush()
    while !vad.isEmpty() {
      let segment = vad.front()
      vad.pop()
      finalizeSegment(samples: segment.samples, startSample: segment.start)
    }
    speechBuffer.removeAll(keepingCapacity: true)
    previousPartial = nil
    stablePartial = nil
    wasSpeechDetected = false
  }

  /// Recognize one finalized speech segment and emit it.
  /// `startSample` is the VAD's index relative to the start of the session.
  private func finalizeSegment(samples: [Float], startSample: Int) {
    guard let recognizer = recognizer, !samples.isEmpty else { return }
    let result = recognizer.decode(samples: samples, sampleRate: sampleRate)
    let decodedText = cleanAsrText(result.text)
    let decoded = RecognitionCandidate(text: decodedText, lang: normalizeLang(result.lang))
    // Only a prefix supported by consecutive partials may override a collapsed final. This avoids
    // turning one transient long hallucination into permanent confirmed text.
    let chosen: RecognitionCandidate
    if let stable = stablePartial, stable.text.count > decoded.text.count {
      chosen = stable
    } else {
      chosen = decoded
    }
    previousPartial = nil
    stablePartial = nil
    // Skip empty / punctuation-only segments (short noises often decode to "。").
    guard hasLetterOrNumber(chosen.text) else { return }

    let id = segmentId
    segmentId += 1
    let start = Double(startSample) / Double(sampleRate)
    let duration = Double(samples.count) / Double(sampleRate)
    notifyListeners("segment", data: [
      "id": id,
      "text": chosen.text,
      // SenseVoice lang short code: zh/en/ja/yue/ko. Defensively strip any <|..|>
      "lang": chosen.lang,
      "start": start,
      "duration": duration,
    ])
  }

  // MARK: - Engine setup

  /// True when the recognizer+VAD are loaded for exactly this model id and SenseVoice language.
  /// Only touched on asrQueue (same as loadedModelId / loadedLanguage / recognizer / vad).
  private func engineMatches(_ modelId: String, _ language: String) -> Bool {
    return recognizer != nil && vad != nil
      && loadedModelId == modelId && loadedLanguage == language
  }

  /// Absolute path of a model file selected by its role within a spec, or nil if absent.
  private func filePath(root: URL, spec: AsrModelSpec, role: String) -> String? {
    guard let file = spec.files.first(where: { $0.role == role }) else { return nil }
    let rel = file.dir.isEmpty ? file.filename : "\(file.dir)/\(file.filename)"
    return root.appendingPathComponent(rel).path
  }

  /// (Re)build the recognizer + VAD for the requested model id and SenseVoice language. No-op when
  /// already loaded for the same pair; otherwise the previous recognizer is released on reassign.
  /// iOS ships only the SenseVoice engine; other engines are rejected defensively.
  private func ensureEngineLoaded(_ modelId: String, language: String) throws {
    if engineMatches(modelId, language) { return }
    guard modelsReady(modelId) else {
      throw asrError("ASR models missing; call downloadModels() first")
    }
    guard let spec = AsrModels.model(id: modelId) else {
      throw asrError("unknown ASR model: \(modelId)")
    }
    let root = modelsDir()
    guard spec.engine == "senseVoice",
          let senseVoiceModel = filePath(root: root, spec: spec, role: "model"),
          let tokens = filePath(root: root, spec: spec, role: "tokens") else {
      throw asrError("unsupported ASR engine for \(modelId): \(spec.engine)")
    }
    let vadModel = root.appendingPathComponent(AsrModels.vad.filename).path

    // ---- SenseVoice offline recognizer (multilingual, ITN on). ----
    // language is a SenseVoice-native code: auto / zh / en / ja / ko / yue ("auto" auto-detects).
    let featConfig = sherpaOnnxFeatureConfig(sampleRate: sampleRate, featureDim: 80)
    let senseVoice = sherpaOnnxOfflineSenseVoiceModelConfig(
      model: senseVoiceModel,
      language: language,
      useInverseTextNormalization: true
    )
    let modelConfig = sherpaOnnxOfflineModelConfig(
      tokens: tokens,
      numThreads: 2,
      debug: 0,
      senseVoice: senseVoice
    )
    var recognizerConfig = sherpaOnnxOfflineRecognizerConfig(
      featConfig: featConfig,
      modelConfig: modelConfig
    )
    recognizer = SherpaOnnxOfflineRecognizer(config: &recognizerConfig)

    // ---- Silero VAD. ----
    let sileroConfig = sherpaOnnxSileroVadModelConfig(
      model: vadModel,
      threshold: vadThreshold,
      minSilenceDuration: minSilenceSeconds,
      minSpeechDuration: minSpeechSeconds,
      windowSize: vadWindowSize,
      maxSpeechDuration: maxSpeechSeconds
    )
    var vadConfig = sherpaOnnxVadModelConfig(
      sileroVad: sileroConfig,
      sampleRate: Int32(sampleRate),
      numThreads: 1,
      debug: 0
    )
    vad = SherpaOnnxVoiceActivityDetectorWrapper(config: &vadConfig,
                                                 buffer_size_in_seconds: vadBufferSeconds)

    loadedModelId = modelId
    loadedLanguage = language

    // Warm up: ONNX's first inference does graph optimization / thread-pool / allocation
    // (can take seconds). Run it now (during "loading") so the first real utterance isn't slow.
    if let recognizer = recognizer {
      _ = recognizer.decode(samples: [Float](repeating: 0, count: sampleRate), sampleRate: sampleRate)
    }
  }

  // MARK: - Models on disk (download-on-first-run; consumes @rt/core registry via AsrModels.swift)

  /// Below this fraction of a file's registered approxBytes it is treated as truncated/corrupt.
  /// approxBytes come from the shared @rt/core registry (packages/core/src/models.ts, mirrored
  /// into AsrModels.swift) and are only approximate, so the bound is deliberately generous.
  private let minModelSizeFraction = 0.8
  /// Files registered below this size (e.g. tokens.txt) carry no meaningful size floor; for them
  /// we only require a non-empty file rather than a fraction of an approximate byte count.
  private let smallModelFileThreshold = 1_000_000

  /// Writable models root: Application Support/models (created on demand, excluded from iCloud backup).
  private func modelsDir() -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    var dir = base.appendingPathComponent("models", isDirectory: true)
    if !FileManager.default.fileExists(atPath: dir.path) {
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    // Model files are large and re-downloadable; keep them out of iCloud / device backups.
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? dir.setResourceValues(values)
    return dir
  }

  /// True when a downloaded file is present and at least its lower-bound size. A file that fails
  /// (missing or truncated) fails this check so callers treat it as "needs (re)download".
  private func fileIsIntact(_ file: AsrModelFile, at path: String) -> Bool {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
          let bytes = attrs[.size] as? Int else { return false }
    let minBytes = file.approxBytes >= smallModelFileThreshold
      ? Int(Double(file.approxBytes) * minModelSizeFraction)
      : 1  // small files: just non-empty
    guard bytes >= minBytes else { return false }
    if let expected = file.expectedBytes, bytes != expected { return false }
    if let expectedHash = file.sha256 {
      guard let handle = try? FileHandle(forReadingFrom: URL(fileURLWithPath: path)) else { return false }
      defer { try? handle.close() }
      var hash = SHA256()
      do {
        while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty { hash.update(data: chunk) }
      } catch { return false }
      return hash.finalize().map { String(format: "%02x", $0) }.joined() == expectedHash.lowercased()
    }
    return true
  }

  /// Integrity precheck standing in for a real checksum: every registry file must exist and clear
  /// its size floor. A corrupt/truncated file is deleted here so the next downloadModels()
  /// re-fetches it (the downloader skips files that already exist), and getSetupStatus / start
  /// see "not ready" and route to re-download / error instead of letting the sherpa-onnx wrapper
  /// fatalError on a bad model.
  private func modelsReady(_ modelId: String) -> Bool {
    let root = modelsDir()
    var ready = true
    for file in AsrModels.requiredFiles(id: modelId) {
      let rel = file.dir.isEmpty ? file.filename : "\(file.dir)/\(file.filename)"
      let path = root.appendingPathComponent(rel).path
      if !FileManager.default.fileExists(atPath: path) {
        ready = false
        continue
      }
      if !fileIsIntact(file, at: path) {
        try? FileManager.default.removeItem(atPath: path)
        ready = false
      }
    }
    return ready
  }

  /// Download the requested model's files (+ shared VAD) into the writable models dir, smallest
  /// first so the dominant file (the ~228MB SenseVoice int8 model) finishes last and the byte
  /// progress climbs smoothly to 100%.
  private func downloadAllModels(_ modelId: String) throws {
    // 本次下载开始，清除上一次可能残留的取消标志。
    downloadLock.lock()
    downloadCancelled = false
    downloadLock.unlock()
    let root = modelsDir()
    let files = AsrModels.requiredFiles(id: modelId).sorted { $0.approxBytes < $1.approxBytes }
    let totalBytes = files.reduce(0) { $0 + $1.approxBytes }
    var completedBytes = 0

    for file in files {
      if isDownloadCancelled() { throw asrError("download cancelled") }
      let destDir = file.dir.isEmpty ? root : root.appendingPathComponent(file.dir, isDirectory: true)
      try FileManager.default.createDirectory(at: destDir, withIntermediateDirectories: true)
      let dest = destDir.appendingPathComponent(file.filename)
      if FileManager.default.fileExists(atPath: dest.path) {
        completedBytes += file.approxBytes
        continue
      }
      let baseCompleted = completedBytes
      try downloadFile(file, to: dest) { loadedThisFile, speed in
        self.notifyListeners("setupProgress", data: [
          "kind": "asr",
          "id": modelId,
          "loaded": baseCompleted + loadedThisFile,
          "bytesPerSec": speed,
          "total": totalBytes,
        ])
      }
      completedBytes += file.approxBytes
    }

    guard modelsReady(modelId) else {
      throw asrError("ASR model verification failed after download")
    }
    notifyListeners("setupProgress", data: ["kind": "asr", "id": modelId, "loaded": totalBytes, "total": totalBytes])
  }

  /// Download `dest` from an ordered list of sources, trying each once until one succeeds; throws an
  /// aggregate error only if all fail. `urls` is the native-side ordered list (self-hosted GitHub
  /// Release first, optional HF upstream fallback — see @rt/core AsrModelFile.nativeUrls). Each attempt
  /// retains partial data on transport failures. asrQueue serializes all destination writes (including VAD).
  private func downloadFile(_ file: AsrModelFile, to dest: URL,
                            onBytes: @escaping (Int, Double) -> Void) throws {
    let urls = file.urls
    guard !urls.isEmpty else {
      throw asrError("no download source for \(dest.lastPathComponent)")
    }
    var errors: [String] = []
    for urlString in urls {
      // 用户取消：立即停止，不再尝试后续源。
      if isDownloadCancelled() { throw asrError("download cancelled") }
      do {
        try downloadFromURL(urlString, file: file, to: dest, onBytes: onBytes)
        return
      } catch {
        errors.append("\(urlString) → \(error.localizedDescription)")
      }
    }
    // All sources exhausted: surface the aggregated per-source failures to the retry UI.
    throw asrError("all download sources failed for \(dest.lastPathComponent):\n"
                   + errors.joined(separator: "\n"))
  }

  /// 线程安全读取取消标志（cancelDownload 在别的线程置位）。
  private func isDownloadCancelled() -> Bool {
    downloadLock.lock()
    defer { downloadLock.unlock() }
    return downloadCancelled
  }

  /// Blocking only on asrQueue; the URLSession delegate streams on its own serial queue.
  private func downloadFromURL(_ urlString: String, file: AsrModelFile, to dest: URL,
                               onBytes: @escaping (Int, Double) -> Void) throws {
    guard let url = URL(string: urlString) else { throw asrError("invalid model URL") }
    if isDownloadCancelled() { throw asrError("download cancelled") }
    let part = URL(fileURLWithPath: dest.path + ".part")
    let metadata = URL(fileURLWithPath: dest.path + ".part.json")
    let delegate = ModelDownloadDelegate(part: part, metadata: metadata, source: urlString, onBytes: onBytes)
    var request = URLRequest(url: url)
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    if delegate.offset > 0, let etag = delegate.etag {
      request.setValue("bytes=\(delegate.offset)-", forHTTPHeaderField: "Range")
      request.setValue(etag, forHTTPHeaderField: "If-Range")
    }
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 60
    let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    let task = session.dataTask(with: request)
    downloadLock.lock()
    currentDownloadTask = task
    let cancelled = downloadCancelled
    downloadLock.unlock()
    if cancelled { task.cancel() }
    task.resume()
    delegate.done.wait()
    downloadLock.lock()
    currentDownloadTask = nil
    downloadLock.unlock()
    session.finishTasksAndInvalidate()
    if let error = delegate.failure { throw error }
    let size = (try FileManager.default.attributesOfItem(atPath: part.path)[.size] as? Int) ?? 0
    guard (delegate.total.map { size == $0 } ?? true), fileIsIntact(file, at: part.path) else {
      try? FileManager.default.removeItem(at: part)
      try? FileManager.default.removeItem(at: metadata)
      throw asrError("model verification failed: \(dest.lastPathComponent)")
    }
    try FileManager.default.moveItem(at: part, to: dest)
    try? FileManager.default.removeItem(at: metadata)
  }

  // MARK: - Text post-processing (mirror apps/macos/src/main/pipeline.ts: cleanAsrText)

  /// SenseVoice emits CJK token-by-token with spaces between; strip spaces between CJK chars.
  private func stripCjkSpaces(_ text: String) -> String {
    let scalars = Array(text.unicodeScalars)
    var out = String.UnicodeScalarView()
    var i = 0
    while i < scalars.count {
      let s = scalars[i]
      if s == " ", i > 0, i + 1 < scalars.count,
         isCjk(scalars[i - 1]), isCjk(scalars[i + 1]) {
        i += 1
        continue
      }
      out.append(s)
      i += 1
    }
    return String(out)
  }

  private func isCjk(_ s: Unicode.Scalar) -> Bool {
    let v = s.value
    return (0x3040...0x30ff).contains(v)   // hiragana / katakana
      || (0x3400...0x9fff).contains(v)     // CJK ext-A + unified ideographs
      || (0xf900...0xfaff).contains(v)     // compatibility ideographs
      || (0xff66...0xff9f).contains(v)     // half-width katakana
  }

  /// Collapse degenerate ASR repetition (1..4-char unit repeated >=4x -> keep 2).
  private func collapseRepeats(_ text: String) -> String {
    var chars = Array(text)
    let repeatMin = 4, repeatKeep = 2, maxUnit = 4
    var unit = 1
    while unit <= maxUnit {
      if chars.count >= unit * repeatMin {
        var out: [Character] = []
        var i = 0
        while i < chars.count {
          if i + unit > chars.count { out.append(chars[i]); i += 1; continue }
          var count = 1
          var j = i + unit
          while j + unit <= chars.count && gramEqual(chars, i, j, unit) {
            count += 1
            j += unit
          }
          if count >= repeatMin {
            for k in 0..<(repeatKeep * unit) { out.append(chars[i + k]) }
            i = j
          } else {
            out.append(chars[i]); i += 1
          }
        }
        chars = out
      }
      unit += 1
    }
    return String(chars)
  }

  private func gramEqual(_ chars: [Character], _ a: Int, _ b: Int, _ unit: Int) -> Bool {
    for k in 0..<unit where chars[a + k] != chars[b + k] { return false }
    return true
  }

  private func cleanAsrText(_ text: String) -> String {
    return collapseRepeats(stripCjkSpaces(text.trimmingCharacters(in: .whitespacesAndNewlines)))
  }

  private func commonPrefix(_ lhs: String, _ rhs: String) -> String {
    var result: [Character] = []
    for (a, b) in zip(lhs, rhs) {
      if a != b { break }
      result.append(a)
    }
    return String(result)
  }

  private func trimTrailingUnstable(_ text: String) -> String {
    var chars = Array(text)
    while let last = chars.last,
          last.unicodeScalars.allSatisfy({
            CharacterSet.whitespacesAndNewlines.contains($0)
              || CharacterSet.punctuationCharacters.contains($0)
              || CharacterSet.symbols.contains($0)
          }) {
      chars.removeLast()
    }
    return String(chars)
  }

  private func hasLetterOrNumber(_ text: String) -> Bool {
    return text.unicodeScalars.contains { CharacterSet.alphanumerics.contains($0) }
  }

  /// SenseVoice language tag may surface as a bare code (zh/en/ja/yue/ko) or wrapped
  /// (<|zh|>) depending on binding/version; strip <, |, > to match macOS's normalized form.
  private func normalizeLang(_ lang: String) -> String {
    return lang.filter { $0 != "<" && $0 != "|" && $0 != ">" }
  }

  // MARK: - Helpers

  private func asrError(_ message: String) -> NSError {
    return NSError(domain: "RealtimeAsr", code: -1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}

/// Delegate state is confined to URLSession's serial delegate queue until `done` signals.
private final class ModelDownloadDelegate: NSObject, URLSessionDataDelegate {
  let done = DispatchSemaphore(value: 0)
  private(set) var failure: Error?
  private(set) var total: Int?
  private(set) var offset = 0
  private(set) var etag: String?
  private let part: URL
  private let metadata: URL
  private let source: String
  private let onBytes: (Int, Double) -> Void
  private var handle: FileHandle?
  private var received = 0
  private let started = ProcessInfo.processInfo.systemUptime

  init(part: URL, metadata: URL, source: String, onBytes: @escaping (Int, Double) -> Void) {
    self.part = part
    self.metadata = metadata
    self.source = source
    self.onBytes = onBytes
    super.init()
    if let data = try? Data(contentsOf: metadata),
       let saved = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       saved["source"] as? String == source,
       let tag = saved["etag"] as? String, !tag.hasPrefix("W/"),
       let attrs = try? FileManager.default.attributesOfItem(atPath: part.path) {
      offset = attrs[.size] as? Int ?? 0
      etag = tag
    }
  }

  private func fail(_ message: String) {
    failure = NSError(domain: "RealtimeAsr", code: -1, userInfo: [NSLocalizedDescriptionKey: message])
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                  didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let http = response as? HTTPURLResponse else {
      fail("non-HTTP model response"); completionHandler(.cancel); return
    }
    let tag = http.value(forHTTPHeaderField: "ETag")
    let range = http.value(forHTTPHeaderField: "Content-Range") ?? ""
    if http.statusCode == 416 {
      guard offset > 0, range.hasPrefix("bytes */"),
            let size = Int(range.dropFirst(8)), size >= 0,
            tag == nil || tag == etag else {
        fail("invalid unsatisfied model range"); completionHandler(.cancel); return
      }
      total = size
      completionHandler(.allow)
      return
    }
    guard http.statusCode == 200 || http.statusCode == 206 else {
      fail("model download HTTP \(http.statusCode)"); completionHandler(.cancel); return
    }
    if http.statusCode == 206 {
      let fields = range.replacingOccurrences(of: "bytes ", with: "").split(separator: "/")
      let bounds = fields.first?.split(separator: "-") ?? []
      guard offset > 0, etag != nil, range.hasPrefix("bytes "), fields.count == 2, bounds.count == 2,
            Int(bounds[0]) == offset, let end = Int(bounds[1]), let size = Int(fields[1]),
            end >= offset, end < size, tag == nil || tag == etag else {
        fail("invalid model Content-Range or ETag"); completionHandler(.cancel); return
      }
      total = size
    } else {
      offset = 0
      total = response.expectedContentLength >= 0 ? Int(response.expectedContentLength) : nil
    }
    do {
      if offset == 0 {
        if !FileManager.default.fileExists(atPath: part.path) {
          guard FileManager.default.createFile(atPath: part.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
          }
        }
        handle = try FileHandle(forWritingTo: part)
        try handle?.truncate(atOffset: 0)
      } else {
        handle = try FileHandle(forWritingTo: part)
        try handle?.seekToEnd()
      }
      var saved: [String: Any] = ["source": source]
      if let tag = tag, !tag.hasPrefix("W/") { saved["etag"] = tag }
      else if http.statusCode == 206, let etag = etag { saved["etag"] = etag }
      try JSONSerialization.data(withJSONObject: saved).write(to: metadata, options: .atomic)
      onBytes(offset, 0)
      completionHandler(.allow)
    } catch {
      failure = error
      completionHandler(.cancel)
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    // A 416 body is an error document, never model bytes.
    guard let handle = handle, failure == nil else { return }
    do {
      try handle.write(contentsOf: data)
      received += data.count
      onBytes(offset + received, Double(received) / max(0.001, ProcessInfo.processInfo.systemUptime - started))
    } catch {
      failure = error
      dataTask.cancel()
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    do { try handle?.close() } catch { if failure == nil { failure = error } }
    if failure == nil { failure = error }
    done.signal()
  }
}
