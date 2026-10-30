import SwiftUI
import Foundation
import UIKit
import RayNeoProtocol
import AVFoundation

@main
struct GlassesCaptionApp: App {
    @StateObject private var model = GlassesCaptionModel()

    var body: some Scene {
        WindowGroup {
            CaptionScreen(model: model)
                .task { model.prepare() }
        }
    }
}

/// One screen, one job: show whether captions are running, the bilingual log, and a single start/stop control.
struct CaptionScreen: View {
    @ObservedObject var model: GlassesCaptionModel
    @State private var showingSettings = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            captionLog
            controls
        }
        .sheet(isPresented: $showingSettings) { DiagnosticsSheet(model: model) }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(model.connected ? "眼镜已连接" : "眼镜未连接", systemImage: "eyeglasses")
                    .font(.footnote)
                    .foregroundStyle(model.connected ? .secondary : .tertiary)
                Spacer()
                Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("连接与调试")
            }
            Text(model.headline)
                .font(.largeTitle.weight(.semibold))
                .accessibilityIdentifier("glasses-status")
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(model.detail(at: context.date))
                    .font(.subheadline)
                    .foregroundStyle(model.alert == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.red))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 16)
    }

    private var captionLog: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if model.history.isEmpty && model.pendingSource.isEmpty {
                        Text(model.hasActiveSession ? "说话后，日语原文和中文译文会出现在这里。" : "开始后，这里会按句记录日语原文和中文译文。")
                            .font(.subheadline)
                            .foregroundStyle(.tertiary)
                            .padding(.top, 24)
                    }
                    ForEach(model.history) { pair in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(pair.japanese).font(.subheadline).foregroundStyle(.secondary)
                            Text(pair.chinese).font(.body)
                        }
                    }
                    if !model.pendingSource.isEmpty {
                        Text(model.pendingSource)
                            .font(.subheadline)
                            .foregroundStyle(.tertiary)
                            .accessibilityIdentifier("glasses-source")
                    }
                    if model.chineseTruncated {
                        Text("镜片只显示了最新译文的开头")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
            }
            .onChange(of: model.history.count) { proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: model.source) { proxy.scrollTo("end", anchor: .bottom) }
        }
    }

    private var controls: some View {
        VStack(spacing: 8) {
            Button {
                Task {
                    if model.hasActiveSession { await model.stop() }
                    else { await model.start() }
                }
            } label: {
                Image(systemName: model.hasActiveSession ? "stop.fill" : "captions.bubble.fill")
                    .font(.title)
                    .foregroundStyle(model.hasActiveSession ? Color.white : Color(.systemBackground))
                    .frame(width: 72, height: 72)
                    .background(Circle().fill(model.hasActiveSession ? Color.red : Color(.label)))
            }
            .disabled(model.stopping)
            .accessibilityLabel(model.primaryActionTitle)
            .accessibilityIdentifier("glasses-primary-action")
            Text(model.primaryActionTitle)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 12)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }
}

/// Experimental inputs, first-time pairing, display tests and counters stay out of the main screen.
struct DiagnosticsSheet: View {
    @ObservedObject var model: GlassesCaptionModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("连接") {
                    Button("重连已绑定眼镜") { model.reconnect() }.disabled(model.hasActiveSession)
                    Button("发现新设备") { model.discover() }.disabled(model.hasActiveSession)
                    Button("连接发现的眼镜") { model.connect() }.disabled(model.hasActiveSession)
                }
                Section("收音来源") {
                    Picker("收音来源", selection: $model.inputMode) {
                        Text("iPhone 麦克风").tag(GlassesInputMode.phone)
                        Text("眼镜蓝牙麦克风（实验）").tag(GlassesInputMode.bluetooth)
                        Text("眼镜协议音频（实验）").tag(GlassesInputMode.protocolAudio)
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .disabled(model.hasActiveSession)
                }
                Section("镜片测试") {
                    Button("只打开字幕窗口") { model.openDisplay() }
                        .disabled(!model.connected || model.hasActiveSession)
                    Button("发送下一条测试字幕") { model.sendTest() }
                        .disabled(!model.displayReady || model.recording || model.starting || model.stopping)
                    Button("五行显示测试") { model.sendCapacityTest() }
                        .disabled(!model.displayReady || model.recording || model.starting || model.stopping)
                    Button("提醒查看聊天") { model.remindToCheckChat() }
                        .disabled(!model.displayReady || model.recording || model.starting || model.stopping)
                        .accessibilityIdentifier("glasses-remind-chat")
                }
                Section("诊断") {
                    Text(model.status).font(.footnote)
                    Text("音频包 \(model.audioPackets) · PCM \(model.pcmSamples) · 已发字幕 \(model.sentCount)")
                        .font(.caption).accessibilityIdentifier("glasses-counters")
                    Text(model.latestEvent).font(.caption).foregroundStyle(.secondary)
                    Text("测试版 · \(Bundle.main.object(forInfoDictionaryKey: "GlassesCommit") as? String ?? "local")")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("连接与调试")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}

struct CaptionPair: Identifiable {
    let id: Int
    let japanese: String
    let chinese: String
}

enum GlassesInputMode: String { case phone, bluetooth, protocolAudio }

@MainActor
final class GlassesCaptionModel: ObservableObject {
    @Published var inputMode = GlassesInputMode.phone
    @Published private(set) var connected = false
    @Published private(set) var displayReady = false
    @Published private(set) var recording = false
    @Published private(set) var starting = false
    @Published private(set) var stopping = false
    @Published private(set) var chineseTruncated = false
    @Published private(set) var status = "点击开始；只会重连已绑定的眼镜。"
    @Published private(set) var source = ""
    @Published private(set) var translation = ""
    @Published private(set) var latestEvent = "尚未启动"
    @Published private(set) var audioPackets = 0
    @Published private(set) var pcmSamples = 0
    @Published private(set) var sentCount = 0
    @Published private(set) var history: [CaptionPair] = []
    /// The reason the last session ended unexpectedly; cleared when a new session starts.
    @Published private(set) var alert: String?
    @Published private(set) var captionsStartedAt: Date?
    private(set) var sessionID: String?
    private var sessionDevice: String?
    private let controller = ProbeController()
    private var nativeDecoder = RNVoiceVADCreate()
    private let pipeline = AppleCaptionPipeline()
    private let microphone = GlassesBluetoothMicrophone()
    private let phoneMicrophone = PhoneMicrophone()
    private var timer: Timer?
    private var deadline: Task<Void, Never>?
    private var testIndex = 0
    private var lastAudioAt: TimeInterval?
    private var recognitionStartedAt: TimeInterval?
    private var lastDiagnosticAt = 0.0
    private var diagnosticCount = 0
    private var generation = 0
    private var lens = LensCaptionScheduler()
    private var lensTask: Task<Void, Never>?
    private var sourceUpdates = 0
    private var frameUpdateRequests = 0

    var hasActiveSession: Bool { starting || recording || stopping || sessionID != nil }
    var primaryActionTitle: String {
        if stopping { return "正在停止…" }
        if starting { return "取消启动" }
        return hasActiveSession ? "停止字幕" : "开始字幕"
    }

    /// Live Japanese still waiting for its translation; hidden once the same text is in the log.
    var pendingSource: String { history.last?.japanese == source ? "" : source }

    var headline: String {
        if stopping { return "正在停止" }
        if starting { return connected ? "正在打开字幕" : "正在连接眼镜" }
        if recording { return "字幕中" }
        if displayReady { return "字幕窗口已打开" }
        if alert != nil { return "字幕已停止" }
        return connected ? "准备好了" : "眼镜未连接"
    }

    func detail(at now: Date) -> String {
        if let alert, !hasActiveSession { return alert }
        if recording, let began = captionsStartedAt {
            let seconds = max(0, Int(now.timeIntervalSince(began)))
            let elapsed = seconds >= 3600
                ? String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
                : String(format: "%d:%02d", seconds / 60, seconds % 60)
            return "\(elapsed) · \(inputMode == .phone ? "手机麦克风" : "眼镜麦克风")"
        }
        if hasActiveSession || displayReady { return "" }
        return connected ? "开始后用手机麦克风听日语，中文显示在镜片上。" : "唤醒眼镜后点开始，会自动重连已绑定的眼镜。"
    }

    deinit { RNVoiceVADDestroy(nativeDecoder) }

    func prepare() {
        guard timer == nil else { return }
        // The inherited transport must not restore the companion's cloud voice workflow.
        UserDefaults.standard.set(false, forKey: "companion.autoVoice.v1")
        controller.companionBusiness = { [weak self] device, business, data in
            self?.receive(device: device, business: business, data: data)
        }
        controller.companionBusinessLoss = { [weak self] in
            self?.fail("音频或字幕消息接收溢出，请停止后重试。")
        }
        controller.companionLog = { [weak self] line in self?.latestEvent = String(line.prefix(200)) }
        pipeline.onSource = { [weak self] text in
            guard let self, self.recording || self.stopping else { return }
            self.source = text
            self.sourceUpdates += 1
            if self.recording && !self.stopping { self.queueFrame() }
        }
        pipeline.onTranslation = { [weak self] japanese, text in
            guard let self, self.recording || self.stopping else { return }
            self.translation = text
            self.history.append(CaptionPair(id: self.history.count, japanese: japanese, chinese: text))
            if self.recording && !self.stopping { self.queueFrame() }
            self.diagnostic("translation")
        }
        pipeline.onError = { [weak self] in self?.fail($0) }
        microphone.onPCM = { [weak self] pcm in
            guard let self, self.recording, self.inputMode == .bluetooth else { return }
            self.audioPackets += 1; self.pcmSamples += pcm.count / 2
            self.lastAudioAt = ProcessInfo.processInfo.systemUptime
            self.pipeline.appendPCM16(pcm, sampleRate: 16000)
        }
        microphone.onError = { [weak self] in self?.fail($0) }
        phoneMicrophone.onPCM = { [weak self] pcm in
            guard let self, self.recording, self.inputMode == .phone else { return }
            self.audioPackets += 1; self.pcmSamples += pcm.count / 2
            self.lastAudioAt = ProcessInfo.processInfo.systemUptime
            self.pipeline.appendPCM16(pcm, sampleRate: 16000)
        }
        phoneMicrophone.onError = { [weak self] in self?.fail($0) }
        controller.loadViewIfNeeded()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        tick()
    }

    func reconnect() { prepare(); controller.companionReconnectBonded(); tick() }
    func discover() { prepare(); controller.companionDiscover(); tick() }
    func connect() { prepare(); controller.companionConnect(); tick() }

    private func tick() {
        connected = controller.companionReady
        if let target = sessionDevice, controller.companionDeviceID != target {
            fail("眼镜连接已变化，停止本次字幕。")
        }
        let now = ProcessInfo.processInfo.systemUptime
        if recording, let began = recognitionStartedAt, now - (lastAudioAt ?? began) > 12 {
            fail(inputMode == .phone ? "手机麦克风音频已中断，字幕已停止。" : "未持续收到眼镜音频；不会切换到手机麦克风。")
        }
        if now - lastDiagnosticAt >= 5 { lastDiagnosticAt = now; diagnostic("heartbeat") }
    }

    private func send(_ business: UInt8, type: UInt32, json: [String: Any]) throws {
        guard controller.companionReady,
              sessionDevice == nil || controller.companionDeviceID == sessionDevice else {
            throw DeviceFeatureError.disconnected
        }
        try controller.companionSendBusiness(business, payload: DeviceBusinessWire.encode(type: type, json: json))
    }

    func openDisplay() {
        guard !hasActiveSession else { return }
        requestDisplay()
    }

    private func requestDisplay() {
        guard connected, sessionID == nil, !stopping, let device = controller.companionDeviceID else { return }
        let sid = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        cancelLensUpdates()
        source = ""; translation = ""
        sourceUpdates = 0; frameUpdateRequests = 0
        chineseTruncated = false
        lens.begin(sessionID: sid)
        sessionID = sid; sessionDevice = device; displayReady = false; testIndex = 0
        do {
            try send(19, type: 7, json: ["sid": sid, "force": false, "scope": "temporary", "config": [
                "font_size": 1, "content_width": 100, "max_lines": 5, "position": "center",
                "is_display": true, "straight_view": "original"
            ]])
            status = "字幕窗口请求已发出，等待眼镜确认。"
            diagnostic("display_requested")
            deadline = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                guard !Task.isCancelled, let self, self.sessionID == sid, !self.displayReady else { return }
                self.fail("眼镜没有确认字幕窗口；请确认镜片状态。")
            }
        } catch { fail("无法打开字幕窗口：\(error.localizedDescription)") }
    }

    func sendTest() {
        let messages = [("今日は日本語と中国語の字幕を確認します。", "今天确认日语和中文字幕。"),
                        ("長い文章でも表示が勝手に切り替わらないことを確認します。この字幕はそのまま残ります。", "这是一段较长的中文字幕，用来确认小号文字只保留最新译文的开头，并以省略号标出放不下的部分，不会再自动翻页。")]
        guard testIndex < messages.count else { status = "两条字幕已发送，请核对镜片覆盖更新后退出。"; return }
        let text = messages[testIndex]; testIndex += 1
        source = text.0; translation = text.1
        queueFrame()
    }

    func sendCapacityTest() {
        guard displayReady, !recording, !starting, !stopping else { return }
        source = ""
        translation = zip(["一", "二", "三", "四", "五"], ["①", "②", "③", "④", "⑤"])
            .map { String(repeating: $0.0, count: 19) + $0.1 }.joined()
        queueFrame()
        status = "请确认镜片五行均可见，最末一行为⑤；这只检查排版，不代表实时识别。"
    }

    func remindToCheckChat() {
        guard displayReady, let sid = sessionID, lens.sessionID == sid, lens.ready,
              !recording, !starting, !stopping else { return }
        source = "チャットをご確認ください。"
        translation = "请查看聊天，有一项需要确认。"
        status = "正在提醒你查看聊天…"
        queueFrame()
        diagnostic("chat_reminder_queued")
    }

    private func queueFrame() {
        guard displayReady, let sid = sessionID, lens.sessionID == sid, !stopping else { return }
        let frame = LensCaptionRenderer.render(japanese: source, chinese: translation)
        chineseTruncated = frame.chineseTruncated
        frameUpdateRequests += 1
        if let text = lens.update(frame.text, now: ProcessInfo.processInfo.systemUptime) { submitFrame(text) }
        armLensUpdate()
    }

    private func armLensUpdate() {
        guard lensTask == nil, !stopping, let sid = sessionID,
              let delay = lens.delay(now: ProcessInfo.processInfo.systemUptime) else { return }
        lensTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            catch { return }
            guard let self, self.sessionID == sid, self.lens.sessionID == sid, !self.stopping else { return }
            self.lensTask = nil
            if let text = self.lens.flush(now: ProcessInfo.processInfo.systemUptime) { self.submitFrame(text) }
            self.armLensUpdate()
        }
    }

    private func cancelLensUpdates() {
        lensTask?.cancel(); lensTask = nil; lens.cancel()
    }

    private func submitFrame(_ text: String) {
        guard displayReady, let sid = sessionID, lens.sessionID == sid, !stopping else { return }
        do {
            try send(19, type: 5, json: ["sid": sid, "mode": 3, "status": 0,
                                      "content": ["source_transcript": text]])
            sentCount += 1
            status = chineseTruncated ? "镜片省略了较长内容，手机保留完整译文。"
                : recording ? "正在显示日语与最近完成的中文。" : "双语字幕已提交，请核对镜片实际显示。"
            diagnostic("display_text")
        } catch { fail("字幕发送失败：\(error.localizedDescription)") }
    }

    func start() async {
        guard !hasActiveSession else { return }
        prepare()
        alert = nil; history = []
        starting = true; generation += 1
        let token = generation
        defer { starting = false }
        do {
            if !controller.companionReady {
                status = "正在重连已绑定眼镜…"
                controller.companionReconnectBonded()
                try await waitForStart(token, seconds: 15,
                    failure: "未连接到已绑定眼镜；请唤醒眼镜，首次连接可展开连接与调试。") {
                    self.controller.companionReady
                }
            }
            try checkStart(token)
            connected = controller.companionReady
            requestDisplay()
            try await waitForStart(token, seconds: 10, failure: "眼镜未确认字幕窗口，请结束眼镜其他任务后重试。") {
                self.displayReady
            }
            try checkStart(token)
            try await startRecognition(token)
        } catch {
            guard token == generation else { stopMicrophones(); await pipeline.stop(); return }
            let message = "无法开始：\(error.localizedDescription)"
            await stop()
            status = message; alert = message
        }
    }

    private func checkStart(_ token: Int) throws {
        guard token == generation, !stopping else { throw CancellationError() }
    }

    private func waitForStart(_ token: Int, seconds: TimeInterval, failure: String,
                              condition: () -> Bool) async throws {
        let until = ProcessInfo.processInfo.systemUptime + seconds
        while true {
            try checkStart(token)
            if condition() { return }
            guard ProcessInfo.processInfo.systemUptime < until else { throw StartFailure(message: failure) }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    private func startRecognition(_ token: Int) async throws {
        guard displayReady else { throw StartFailure(message: "字幕窗口尚未准备好。") }
        status = "正在准备 Apple 日语识别与中文翻译…"
        try await pipeline.start()
        try checkStart(token)
        RNVoiceVADReset(nativeDecoder)
        audioPackets = 0; pcmSamples = 0; lastAudioAt = nil
        recording = true
        if inputMode == .phone { try await phoneMicrophone.start() }
        else if inputMode == .bluetooth { try await microphone.start() }
        else { try send(13, type: 2, json: ["rc": 1]) }
        try checkStart(token)
        recognitionStartedAt = ProcessInfo.processInfo.systemUptime
        captionsStartedAt = Date()
        status = inputMode == .phone ? "正在使用手机麦克风，等待日语。" : "已请求眼镜收音，等待音频。"
        diagnostic("microphone_requested")
    }

    private struct StartFailure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    func stop() async {
        guard !stopping else { return }
        let cancelledBeforeDisplay = starting && sessionID == nil
        cancelLensUpdates()
        stopping = true; generation += 1; deadline?.cancel(); deadline = nil
        let wasRecording = recording; recording = false
        stopMicrophones()
        if wasRecording, inputMode == .protocolAudio { try? send(13, type: 2, json: ["rc": 2]) }
        await pipeline.stop()
        if let sid = sessionID { try? send(19, type: 3, json: ["sid": sid, "reason_code": 10, "text": ""]) }
        displayReady = false; sessionID = nil; sessionDevice = nil; recognitionStartedAt = nil
        captionsStartedAt = nil
        stopping = false
        status = cancelledBeforeDisplay ? "已取消启动。" : "已请求停止并退出；请确认眼镜已回到首页。"
        diagnostic("stopped")
    }

    private func stopMicrophones() {
        phoneMicrophone.stop()
        microphone.stop()
    }

    private func fail(_ message: String) {
        guard !stopping else { return }
        status = message; alert = message; diagnostic("error")
        if sessionID != nil || recording {
            Task { [weak self] in
                await self?.stop()
                self?.status = message
            }
        }
    }

    private func receive(device: String, business: UInt8, data: Data) {
        guard device == sessionDevice, let packet = try? DeviceBusinessWire(data) else { return }
        if business == 19 {
            guard packet.json["sid"] as? String == sessionID else { return }
            if packet.type == 8 {
                guard let value = DeviceBusinessWire.integer(packet.json, "code"), [1, 2].contains(value) else {
                    fail("眼镜拒绝字幕窗口，或返回了未知确认格式。"); return
                }
                deadline?.cancel(); deadline = nil; displayReady = true
                if let sid = sessionID { _ = lens.acknowledge(sessionID: sid) }
                status = starting ? "字幕窗口已准备，正在准备识别…" : "字幕窗口已准备，可发送测试文字。"
                diagnostic("display_ready")
            } else if packet.type == 3 {
                fail("眼镜结束了字幕会话，请重新打开。")
            } else if packet.type == 4 {
                fail("收到未验证的字幕音频格式，已停止本次实验。")
            }
        } else if business == 13, packet.type == 3, recording, inputMode == .protocolAudio,
                  !packet.bytes.isEmpty, packet.bytes.count <= 4096 {
            var samples = [Int16](repeating: 0, count: 1920)
            let frames = packet.bytes.withUnsafeBytes { bytes in
                samples.withUnsafeMutableBufferPointer { output in
                    RNVoiceDecodePCM(nativeDecoder, bytes.bindMemory(to: UInt8.self).baseAddress,
                                     bytes.count, output.baseAddress, output.count)
                }
            }
            guard frames > 0, frames <= 12 else { fail("眼镜音频解码失败，未输入识别。 "); return }
            let count = Int(frames) * 160
            let pcm = samples.withUnsafeBufferPointer { Data(buffer: UnsafeBufferPointer(start: $0.baseAddress, count: count)) }
            audioPackets += 1; pcmSamples += count; lastAudioAt = ProcessInfo.processInfo.systemUptime
            pipeline.appendPCM16(pcm, sampleRate: 16000)
        }
    }

    private func diagnostic(_ event: String) {
        guard diagnosticCount < 5000 else { return }
        diagnosticCount += 1
        let input = AVAudioSession.sharedInstance().currentRoute.inputs.first
        let row: [String: Any] = ["event": event, "timestamp": Date().timeIntervalSince1970,
            "foreground": UIApplication.shared.applicationState == .active,
            "protectedDataAvailable": UIApplication.shared.isProtectedDataAvailable,
            "audioPackets": audioPackets, "pcmSamples": pcmSamples, "sentCount": sentCount,
            "recording": recording, "displayReady": displayReady, "inputMode": inputMode.rawValue,
            "inputName": inputMode == .phone ? phoneMicrophone.inputName : microphone.inputName,
            "inputPortType": input?.portType.rawValue ?? "",
            "hardwareSampleRate": inputMode == .phone ? phoneMicrophone.sampleRate : microphone.sampleRate,
            "microphonePCMFrames": inputMode == .phone ? phoneMicrophone.pcmFrames : microphone.pcmFrames,
            "recognitionFinals": pipeline.finalCount, "translations": pipeline.translationCount,
            "pendingTranslations": pipeline.pendingTranslations, "sourceUpdates": sourceUpdates,
            "frameUpdateRequests": frameUpdateRequests, "displayMode": "small-bilingual-adaptive",
            "fontSize": 1, "maximumLines": LensCaptionRenderer.maximumLines,
            "fixtureInput": ProcessInfo.processInfo.arguments.contains("--subline-glasses-fixture"),
            "chineseTruncated": chineseTruncated]
        guard let data = try? JSONSerialization.data(withJSONObject: row) else { return }
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("glasses-caption-diagnostic.jsonl")
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        }
        if let file = try? FileHandle(forWritingTo: url) {
            defer { try? file.close() }
            do { try file.seekToEnd(); try file.write(contentsOf: data + Data([10])) } catch { }
        }
    }
}
