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
            NavigationStack {
                List {
                    Section {
                        Label(model.connected ? "眼镜已连接" : "等待连接眼镜", systemImage: "eyeglasses")
                        Text("手机收音 · 日语 → 中文")
                            .font(.subheadline).foregroundStyle(.secondary)
                        Button(model.primaryActionTitle) {
                            Task {
                                if model.hasActiveSession { await model.stop() }
                                else { await model.start() }
                            }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.stopping)
                        .accessibilityIdentifier("glasses-primary-action")
                        Text(model.status).font(.footnote).accessibilityIdentifier("glasses-status")
                    }
                    Section("中文") {
                        Text(model.translation.isEmpty ? "等待译文" : model.translation)
                            .accessibilityIdentifier("glasses-translation")
                        if model.displayTruncated {
                            Text("镜片显示不完整，以上保留完整译文。")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Section {
                        DisclosureGroup("连接与调试") {
                            Button("重连已绑定眼镜") { model.reconnect() }.disabled(model.hasActiveSession)
                            Button("发现新设备") { model.discover() }.disabled(model.hasActiveSession)
                            Button("连接发现的眼镜") { model.connect() }.disabled(model.hasActiveSession)
                            Picker("收音来源", selection: $model.inputMode) {
                                Text("iPhone 麦克风").tag(GlassesInputMode.phone)
                                Text("眼镜蓝牙麦克风（实验）").tag(GlassesInputMode.bluetooth)
                                Text("眼镜协议音频（实验）").tag(GlassesInputMode.protocolAudio)
                            }.disabled(model.hasActiveSession)
                            Button("只测试字幕窗口") { model.openDisplay() }
                                .disabled(!model.connected || model.hasActiveSession)
                            Button("发送下一条字幕测试") { model.sendTest() }
                                .disabled(!model.displayReady || model.recording || model.starting || model.stopping)
                            Text(model.source.isEmpty ? "等待日语原文" : model.source)
                                .accessibilityIdentifier("glasses-source")
                            Text("音频包 \(model.audioPackets) · PCM \(model.pcmSamples) · 已发字幕 \(model.sentCount)")
                                .font(.caption).accessibilityIdentifier("glasses-counters")
                            Text(model.latestEvent).font(.caption).foregroundStyle(.secondary)
                            Text("测试版 · \(Bundle.main.object(forInfoDictionaryKey: "GlassesCommit") as? String ?? "local")")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                .navigationTitle("Subline Glasses")
                .task { model.prepare() }
            }
        }
    }
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
    @Published private(set) var displayTruncated = false
    @Published private(set) var status = "点击开始；只会重连已绑定的眼镜。"
    @Published private(set) var source = ""
    @Published private(set) var translation = ""
    @Published private(set) var latestEvent = "尚未启动"
    @Published private(set) var audioPackets = 0
    @Published private(set) var pcmSamples = 0
    @Published private(set) var sentCount = 0
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

    var hasActiveSession: Bool { starting || recording || stopping || sessionID != nil }
    var primaryActionTitle: String {
        if stopping { return "正在停止…" }
        if starting { return "取消启动" }
        return hasActiveSession ? "停止字幕" : "开始字幕"
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
        }
        pipeline.onTranslation = { [weak self] text in
            guard let self, self.recording || self.stopping else { return }
            self.translation = text
            if self.recording && !self.stopping { self.sendText(text) }
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
        sessionID = sid; sessionDevice = device; displayReady = false; testIndex = 0
        do {
            try send(19, type: 7, json: ["sid": sid, "force": false, "scope": "temporary", "config": [
                "font_size": 2, "content_width": 100, "max_lines": 5, "position": "center",
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
        let messages = ["字幕测试一：我们正在验证中文连续显示。", "字幕测试二：这句话应替换上一句话，不是弹出新通知。"]
        guard testIndex < messages.count else { status = "两条字幕已发送，请核对镜片覆盖更新后退出。"; return }
        let text = messages[testIndex]; testIndex += 1
        translation = text; sendText(text)
    }

    private func sendText(_ text: String) {
        guard displayReady, let sid = sessionID, !text.isEmpty, !stopping else { return }
        // One bounded display frame; the phone retains the complete current translation.
        var visible = text
        displayTruncated = visible.utf8.count > 384
        if displayTruncated {
            let suffix = "…（未完）"
            while visible.utf8.count + suffix.utf8.count > 384 { visible.removeLast() }
            visible += suffix
        }
        do {
            try send(19, type: 5, json: ["sid": sid, "mode": 3, "status": 0,
                                      "content": ["source_transcript": visible]])
            sentCount += 1
            status = displayTruncated ? "镜片显示不完整，手机保留完整译文。"
                : recording ? "正在听日语并显示中文。" : "字幕已提交，请核对镜片实际显示。"
            diagnostic("display_text")
        } catch { fail("字幕发送失败：\(error.localizedDescription)") }
    }

    func start() async {
        guard !hasActiveSession else { return }
        prepare()
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
            status = message
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
        stopping = true; generation += 1; deadline?.cancel(); deadline = nil
        let wasRecording = recording; recording = false
        stopMicrophones()
        if wasRecording, inputMode == .protocolAudio { try? send(13, type: 2, json: ["rc": 2]) }
        await pipeline.stop()
        if let sid = sessionID { try? send(19, type: 3, json: ["sid": sid, "reason_code": 10, "text": ""]) }
        displayReady = false; sessionID = nil; sessionDevice = nil; recognitionStartedAt = nil
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
        status = message; diagnostic("error")
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
            "pendingTranslations": pipeline.pendingTranslations]
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
