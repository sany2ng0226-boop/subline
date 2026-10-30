import AVFoundation
import Combine
import Foundation

@MainActor
final class GlassesBluetoothMicrophone: ObservableObject {
    @Published private(set) var running = false
    @Published private(set) var inputName = ""
    @Published private(set) var sampleRate: Double = 0
    @Published private(set) var pcmFrames = 0

    var onPCM: ((Data) -> Void)?
    var onError: ((String) -> Void)?

    private var engine: AVAudioEngine?
    private var inputUID: String?
    private var observers: [NSObjectProtocol] = []
    private var generation = 0
    private var starting = false
    private var sessionActive = false
    private var gate: DeliveryGate?

    func start() async throws {
        guard !starting, !running else { throw Failure("眼镜麦克风正在启动或运行") }
        starting = true
        generation += 1
        let token = generation
        defer { starting = false }
        let permission = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard permission else { throw Failure("请允许麦克风权限以使用眼镜收音") }
        guard token == generation else { throw CancellationError() }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetoothHFP])
            try session.setActive(true)
            sessionActive = true
            let matches = (session.availableInputs ?? []).filter {
                $0.portType == .bluetoothHFP && ($0.portName.localizedCaseInsensitiveContains("rayneo") || $0.portName.contains("雷鸟"))
            }
            guard matches.count == 1, let input = matches.first else {
                throw Failure(matches.isEmpty
                    ? "未找到雷鸟眼镜蓝牙麦克风；请确认眼镜音频蓝牙已连接，不会改用手机麦克风"
                    : "发现多副雷鸟眼镜麦克风，请只连接目标眼镜后重试")
            }
            inputUID = input.uid
            try session.setPreferredInput(input)
            for _ in 0..<20 {
                guard token == generation else { throw CancellationError() }
                if Self.isSelected(session.currentRoute, uid: input.uid) { break }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            guard token == generation else { throw CancellationError() }
            guard Self.isSelected(session.currentRoute, uid: input.uid) else {
                throw Failure("系统未切换到雷鸟眼镜麦克风，未开始采集")
            }
            let engine = AVAudioEngine()
            let source = engine.inputNode.outputFormat(forBus: 0)
            guard source.sampleRate > 0, source.channelCount > 0,
                  let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000,
                                             channels: 1, interleaved: false),
                  let converter = AVAudioConverter(from: source, to: target) else {
                throw Failure("无法转换雷鸟蓝牙麦克风音频")
            }
            let gate = DeliveryGate()
            self.gate = gate
            engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: source) { [weak self] buffer, _ in
                guard gate.isActive else { return }
                guard buffer.format.sampleRate == source.sampleRate,
                      buffer.format.channelCount == source.channelCount else {
                    if gate.failOnce() {
                        Task { @MainActor [weak self] in
                            guard let self, self.generation == token else { return }
                            self.fail("蓝牙麦克风音频格式发生变化，请重新开始字幕")
                        }
                    }
                    return
                }
                guard gate.acquire() else {
                    if gate.failOnce() {
                        Task { @MainActor [weak self] in
                            guard let self, self.generation == token else { return }
                            self.fail("眼镜音频交付积压，已停止以避免静默漏音")
                        }
                    }
                    return
                }
                let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16_000 / source.sampleRate)) + 1024
                guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
                    gate.release()
                    if gate.failOnce() {
                        Task { @MainActor [weak self] in
                            guard let self, self.generation == token else { return }
                            self.fail("蓝牙麦克风音频缓冲分配失败")
                        }
                    }
                    return
                }
                var supplied = false
                var error: NSError?
                converter.convert(to: output, error: &error) { _, status in
                    if supplied { status.pointee = .noDataNow; return nil }
                    supplied = true
                    status.pointee = .haveData
                    return buffer
                }
                if let error {
                    gate.release()
                    if gate.failOnce() {
                        let message = error.localizedDescription
                        Task { @MainActor [weak self] in
                            guard let self, self.generation == token else { return }
                            self.fail("蓝牙麦克风音频转换失败：\(message)")
                        }
                    }
                    return
                }
                guard output.frameLength > 0, let samples = output.int16ChannelData?[0] else {
                    gate.release()
                    return
                }
                let frames = Int(output.frameLength)
                let data = Data(bytes: samples, count: frames * MemoryLayout<Int16>.size)
                Task { @MainActor [weak self] in
                    defer { gate.release() }
                    guard let self, self.generation == token, self.running,
                          Self.isSelected(AVAudioSession.sharedInstance().currentRoute, uid: input.uid) else {
                        if let self, self.running, self.generation == token {
                            self.fail("雷鸟眼镜麦克风路由已断开，已停止；不会切换到手机麦克风")
                        }
                        return
                    }
                    self.pcmFrames += frames
                    self.onPCM?(data)
                }
            }
            self.engine = engine
            inputName = input.portName
            sampleRate = source.sampleRate
            pcmFrames = 0
            observe(session)
            engine.prepare()
            try engine.start()
            guard Self.isSelected(session.currentRoute, uid: input.uid) else {
                throw Failure("启动时雷鸟麦克风路由变化，已停止")
            }
            running = true
        } catch {
            stop()
            throw error
        }
    }

    func stop() {
        generation += 1
        running = false
        gate?.deactivate()
        gate = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
        inputUID = nil
        if sessionActive {
            sessionActive = false
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        }
    }

    private func observe(_ session: AVAudioSession) {
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification,
                                                               object: session, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.running, let uid = self.inputUID else { return }
                if !Self.isSelected(session.currentRoute, uid: uid) {
                    self.fail("雷鸟眼镜麦克风已断开，字幕已停止；不会改用手机麦克风")
                }
            }
        })
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification,
                                                               object: session, queue: .main) { [weak self] event in
            guard let value = event.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: value) == .began else { return }
            Task { @MainActor [weak self] in
                guard let self, self.running else { return }
                self.fail("音频被系统中断，字幕已停止，请手动重新开始")
            }
        })
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification,
                                                               object: session, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.running else { return }
                self.fail("系统音频服务已重置，字幕已停止")
            }
        })
    }

    private func fail(_ message: String) {
        stop()
        onError?(message)
    }

    private static func isSelected(_ route: AVAudioSessionRouteDescription, uid: String) -> Bool {
        route.inputs.count == 1 && route.inputs[0].portType == .bluetoothHFP && route.inputs[0].uid == uid
    }

    private struct Failure: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }

    private final class DeliveryGate: @unchecked Sendable {
        private let lock = NSLock()
        private var active = true
        private var failed = false
        private let slots = DispatchSemaphore(value: 8)
        var isActive: Bool { lock.lock(); defer { lock.unlock() }; return active }
        func acquire() -> Bool { slots.wait(timeout: .now()) == .success }
        func release() { slots.signal() }
        func deactivate() { lock.lock(); active = false; lock.unlock() }
        func failOnce() -> Bool {
            lock.lock(); defer { lock.unlock() }
            guard active, !failed else { return false }
            failed = true
            active = false
            return true
        }
    }
}
