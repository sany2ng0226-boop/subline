import AVFoundation
import Combine
import Foundation
import Speech
import Translation
import UIKit

@available(iOS 26.0, *)
@MainActor
final class AppleCaptionPipeline: ObservableObject {
    @Published private(set) var running = false
    @Published private(set) var pcmFrames = 0
    @Published private(set) var finalCount = 0
    @Published private(set) var translationCount = 0
    @Published private(set) var pendingTranslations = 0
    @Published private(set) var lastPCMAt: Date?
    @Published private(set) var lastTranslationAt: Date?

    var onSource: ((String) -> Void)?
    /// Called with the finalized Japanese text and its completed Chinese translation, in finalization order.
    var onTranslation: ((String, String) -> Void)?
    var onError: ((String) -> Void)?

    private var analyzer: SpeechAnalyzer?
    private var translator: TranslationSession?
    private var continuation: AsyncStream<AnalyzerInput>.Continuation?
    private let fixtureEnabled = ProcessInfo.processInfo.arguments.contains("--subline-glasses-fixture")
    private var fixtureTask: Task<Void, Never>?
    private var resultsTask: Task<Void, Never>?
    private var translationTask: Task<Void, Never>?
    private var targetFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var sourceRate: Double = 0
    private var acceptingPCM = false
    private var stopping = false
    private var starting = false
    private var generation = 0
    private var poisoned = false
    private var translationQueue: [String] = []
    private var recentSource: [String] = []

    func start() async throws {
        guard !starting, !running, !stopping else { throw Failure("识别正在启动或运行") }
        guard !poisoned else { throw Failure("系统处理超时，请重新打开应用后重试") }
        let fixture = fixtureEnabled ? try loadFixture() : nil
        starting = true
        defer { starting = false }
        let source = Locale.Language(identifier: "ja")
        let target = Locale.Language(identifier: "zh")
        guard await LanguageAvailability().status(from: source, to: target) == .installed else {
            throw Failure("请先在系统翻译中下载日语和中文语言包，再开始字幕")
        }
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "ja-JP")),
              await SpeechTranscriber.installedLocales.contains(locale) else {
            throw Failure("Apple 日语识别资源尚未准备，请先在 Subline 准备 Apple 日语模型")
        }
        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw Failure("无法取得 Apple 日语识别音频格式")
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        do {
            try await deadline(seconds: 8) { try await analyzer.prepareToAnalyze(in: format) }
        } catch {
            if error is DeadlineFailure { poisoned = true }
            Task { await analyzer.cancelAndFinishNow() }
            throw error
        }
        generation += 1
        let token = generation
        let (stream, input) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingOldest(64))
        self.analyzer = analyzer
        translator = TranslationSession(installedSource: source, target: target)
        targetFormat = format
        continuation = input
        converter = nil
        sourceRate = 0
        translationQueue = []
        recentSource = []
        pcmFrames = 0
        finalCount = 0
        translationCount = 0
        pendingTranslations = 0
        lastPCMAt = nil
        lastTranslationAt = nil
        running = true
        acceptingPCM = true
        resultsTask = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    guard let self, self.generation == token, !Task.isCancelled else { return }
                    let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { continue }
                    self.onSource?(text)
                    if result.isFinal {
                        self.finalCount += 1
                        self.fixtureDiagnostic("final")
                        self.enqueueTranslation(text, token: token)
                    }
                }
            } catch {
                guard let self, self.generation == token, !Task.isCancelled else { return }
                self.abort("Apple 识别已中断：\(error.localizedDescription)")
            }
        }
        do { try await analyzer.start(inputSequence: stream) }
        catch { abort("Apple 识别启动失败：\(error.localizedDescription)"); throw error }
        if let fixture, generation == token, running { startFixture(fixture, token: token) }
    }

    func appendPCM16(_ data: Data, sampleRate: Double = 16_000) {
        guard !fixtureEnabled else { return }
        consumePCM16(data, sampleRate: sampleRate)
    }

    private func consumePCM16(_ data: Data, sampleRate: Double = 16_000) {
        guard acceptingPCM, let targetFormat, let continuation else { return }
        guard !data.isEmpty else { return }
        guard data.count % 2 == 0, data.count <= 128_000, sampleRate.isFinite,
              (8_000...96_000).contains(sampleRate),
              let source = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate,
                                         channels: 1, interleaved: false) else {
            abort("眼镜音频格式无效，已停止字幕")
            return
        }
        if converter == nil || sourceRate != sampleRate {
            converter = AVAudioConverter(from: source, to: targetFormat)
            sourceRate = sampleRate
        }
        guard let converter,
              let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(data.count / 2)),
              let samples = input.int16ChannelData?[0] else {
            abort("无法准备眼镜音频转换器")
            return
        }
        input.frameLength = AVAudioFrameCount(data.count / 2)
        data.withUnsafeBytes { bytes in
            if let base = bytes.baseAddress { memcpy(samples, base, data.count) }
        }
        let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * targetFormat.sampleRate / sampleRate)) + 1024
        guard let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
            abort("眼镜音频缓冲分配失败")
            return
        }
        var supplied = false
        var conversionError: NSError?
        converter.convert(to: converted, error: &conversionError) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return input
        }
        guard conversionError == nil else {
            abort("眼镜音频转换失败：\(conversionError!.localizedDescription)")
            return
        }
        pcmFrames += Int(input.frameLength)
        lastPCMAt = Date()
        guard converted.frameLength > 0 else { return }
        switch continuation.yield(AnalyzerInput(buffer: converted)) {
        case .enqueued: break
        case .dropped: abort("眼镜音频处理积压，已停止字幕以避免静默漏音")
        case .terminated: if !stopping { abort("识别音频输入已结束") }
        @unknown default: abort("识别音频队列状态未知")
        }
    }

    func stop() async {
        guard running, !stopping else { return }
        stopping = true
        fixtureTask?.cancel()
        fixtureTask = nil
        acceptingPCM = false
        continuation?.finish()
        let token = generation
        let analyzer = analyzer
        let results = resultsTask
        do {
            try await deadline(seconds: 8) { [weak self] in
                try await analyzer?.finalizeAndFinishThroughEndOfInput()
                await results?.value
                await self?.translationTask?.value
            }
        } catch {
            if error is DeadlineFailure { poisoned = true }
            if generation == token { onError?("字幕收尾未完成：\(error.localizedDescription)") }
        }
        if generation == token { cleanUp() }
        stopping = false
    }

    private func enqueueTranslation(_ text: String, token: Int) {
        guard text.utf8.count <= 8_192, translationQueue.count < 32 else {
            abort("译文队列已满，已停止字幕以避免静默跳过内容")
            return
        }
        translationQueue.append(text)
        pendingTranslations = translationQueue.count + (translationTask == nil ? 0 : 1)
        guard translationTask == nil else { return }
        translationTask = Task { [weak self] in
            guard let self else { return }
            while !self.translationQueue.isEmpty, self.generation == token, !Task.isCancelled {
                let text = self.translationQueue.removeFirst()
                self.pendingTranslations = self.translationQueue.count + 1
                guard let session = self.translator else { break }
                let context = self.recentSource
                do {
                    let translated = try await self.deadline(seconds: 6) {
                        try await Self.translate(text, context: context, session: session)
                    }
                    guard self.generation == token, !Task.isCancelled else { return }
                    self.recentSource = Array((self.recentSource + [String(text.suffix(400))]).suffix(2))
                    self.translationCount += 1
                    self.lastTranslationAt = Date()
                    self.fixtureDiagnostic("translation")
                    self.onTranslation?(text, translated)
                } catch {
                    guard self.generation == token, !Task.isCancelled else { return }
                    if error is DeadlineFailure { self.poisoned = true }
                    self.abort("中文翻译失败：\(error.localizedDescription)")
                    return
                }
            }
            guard self.generation == token else { return }
            self.pendingTranslations = 0
            self.translationTask = nil
        }
    }

    private static func translate(_ text: String, context: [String], session: TranslationSession) async throws -> String {
        if #available(iOS 26.4, *), !context.isEmpty {
            let marker = URL(string: "https://subline.invalid/translation/current")!
            var input = AttributedString(context.joined(separator: " ") + " ")
            var current = AttributedString(text)
            current.link = marker
            input.append(current)
            do {
                let response = try await session.translate(input)
                if let target = response.attributedTargetText {
                    let translated = target.runs.filter { $0.link == marker }
                        .map { String(target[$0.range].characters) }.joined()
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if !translated.isEmpty { return translated }
                }
            } catch is CancellationError { throw CancellationError() }
            catch { }
        }
        let translated = try await session.translate(text).targetText
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !translated.isEmpty else { throw Failure("Apple 未返回译文") }
        return translated
    }

    private func abort(_ message: String) {
        cleanUp()
        onError?(message)
    }

    private func cleanUp() {
        generation += 1
        fixtureTask?.cancel()
        fixtureTask = nil
        acceptingPCM = false
        running = false
        continuation?.finish()
        continuation = nil
        resultsTask?.cancel()
        resultsTask = nil
        translationTask?.cancel()
        translationTask = nil
        translator?.cancel()
        translator = nil
        if let analyzer { Task { await analyzer.cancelAndFinishNow() } }
        analyzer = nil
        converter = nil
        targetFormat = nil
        translationQueue = []
        pendingTranslations = 0
    }

    private func loadFixture() throws -> Data {
        let url = URL.documentsDirectory.appendingPathComponent("subline-glasses-fixture.wav")
        let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatInt16, interleaved: false)
        guard file.fileFormat.streamDescription.pointee.mFormatID == kAudioFormatLinearPCM,
              file.fileFormat.sampleRate == 16_000, file.fileFormat.channelCount == 1,
              file.fileFormat.settings[AVLinearPCMBitDepthKey] as? Int == 16,
              file.length > 0, file.length <= 16_000 * 600,
              let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat,
                                            frameCapacity: AVAudioFrameCount(file.length)) else {
            throw Failure("测试音频须为不超过十分钟的 16 kHz 单声道 PCM16 WAV")
        }
        try file.read(into: buffer)
        guard let samples = buffer.int16ChannelData?[0], buffer.frameLength > 0 else {
            throw Failure("无法读取测试音频")
        }
        return Data(bytes: samples, count: Int(buffer.frameLength) * 2)
    }

    private func startFixture(_ data: Data, token: Int) {
        fixtureTask?.cancel()
        fixtureTask = Task { [weak self] in
            let clock = ContinuousClock()
            do { try await clock.sleep(for: .seconds(5)) } catch { return }
            let start = clock.now
            var offset = 0
            var tick = 0
            while !Task.isCancelled {
                guard let self, self.generation == token, self.acceptingPCM else { return }
                var chunk = Data()
                while chunk.count < 3_200 {
                    let length = min(3_200 - chunk.count, data.count - offset)
                    chunk.append(data[offset..<(offset + length)])
                    offset = (offset + length) % data.count
                }
                self.consumePCM16(chunk)
                tick += 1
                // Stay paced after delayed scheduling instead of flooding the analyzer with catch-up input.
                let deadline = max(start.advanced(by: .milliseconds(tick * 100)), clock.now.advanced(by: .milliseconds(100)))
                do { try await clock.sleep(until: deadline) } catch { return }
            }
        }
    }

    private func fixtureDiagnostic(_ event: String) {
        guard fixtureEnabled else { return }
        NSLog("[GlassesFixture] %@ time=%.3f protected=%@ foreground=%@", event,
              Date().timeIntervalSince1970,
              UIApplication.shared.isProtectedDataAvailable.description,
              (UIApplication.shared.applicationState == .active).description)
    }

    private func deadline<T>(seconds: Double, operation: @escaping @MainActor () async throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            let race = Completion<T>(continuation)
            race.work = Task { @MainActor in
                do { race.finish(.success(try await operation())) }
                catch { race.finish(.failure(error)) }
            }
            race.timer = Task { @MainActor in
                do { try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
                catch { return }
                race.work?.cancel()
                race.finish(.failure(DeadlineFailure()))
            }
        }
    }

    private struct Failure: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }

    private struct DeadlineFailure: LocalizedError {
        var errorDescription: String? { "系统处理超时" }
    }

    @MainActor private final class Completion<Value> {
        private var continuation: CheckedContinuation<Value, Error>?
        var work: Task<Void, Never>?
        var timer: Task<Void, Never>?
        init(_ continuation: CheckedContinuation<Value, Error>) { self.continuation = continuation }
        func finish(_ result: Result<Value, Error>) {
            guard let continuation else { return }
            self.continuation = nil
            timer?.cancel()
            timer = nil
            work = nil
            continuation.resume(with: result)
        }
    }
}
