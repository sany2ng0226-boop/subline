import Capacitor
import UIKit

// Capacitor 7 只自动注册 pod 形式的插件（capacitor.config.json 的 packageClassList）。
// RealtimeAsr / RealtimeTranslate 直接编进 App target、不是 pod，故在此手动注册。
class MainViewController: CAPBridgeViewController {
  private var testMetricsTimer: Timer?
  private var previousBatteryMonitoring = false

  override open func capacitorDidLoad() {
    bridge?.registerPluginInstance(RealtimeAsrPlugin())
    // RealtimeTranslate 类在所有版本都可编译，方法内部用 #available(iOS 18) 自行降级
    // （iOS<18 调用返回 unavailable，不崩溃），故无条件注册。
    bridge?.registerPluginInstance(RealtimeTranslatePlugin())
    if ProcessInfo.processInfo.arguments.contains("--subline-test-metrics") {
      startTestMetrics()
    }
  }

  // Opt-in local test data; keep charging and thermal pressure distinct from battery drain/temperature.
  private func startTestMetrics() {
    previousBatteryMonitoring = UIDevice.current.isBatteryMonitoringEnabled
    UIDevice.current.isBatteryMonitoringEnabled = true
    let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let url = directory.appendingPathComponent("subline-test-metrics-\(Int(Date().timeIntervalSince1970)).jsonl")
    FileManager.default.createFile(atPath: url.path, contents: nil,
                                  attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    let sample: () -> Void = {
      let device = UIDevice.current
      let data: [String: Any] = [
        "timestamp": Date().timeIntervalSince1970,
        "batteryLevel": device.batteryLevel >= 0 ? device.batteryLevel as Any : NSNull(),
        "batteryState": device.batteryState.rawValue,
        "thermalState": ProcessInfo.processInfo.thermalState.rawValue,
        "appActive": UIApplication.shared.applicationState == .active,
      ]
      do {
        var encoded = try JSONSerialization.data(withJSONObject: data, options: [.sortedKeys])
        encoded.append(0x0a)
        let file = try FileHandle(forWritingTo: url)
        defer { try? file.close() }
        try file.seekToEnd()
        try file.write(contentsOf: encoded)
      } catch { print("[test-metrics] \(error.localizedDescription)") }
    }
    sample()
    testMetricsTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { _ in sample() }
  }

  deinit {
    testMetricsTimer?.invalidate()
    if testMetricsTimer != nil { UIDevice.current.isBatteryMonitoringEnabled = previousBatteryMonitoring }
  }
}
