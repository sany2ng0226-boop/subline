import Capacitor
import Foundation

@objc(RayNeoPlugin)
public class RayNeoPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RayNeoPlugin"
    public let jsName = "RayNeo"
    public let pluginMethods: [CAPPluginMethod] = ["scan", "connect", "disconnect", "getStatus", "getLog", "sendText"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private let link = RayNeoLink()
    public override func load() {
        link.onStatus = { [weak self] in self?.notifyListeners("rayneoStatus", data: $0) }
        link.onLog = { [weak self] in self?.notifyListeners("rayneoLog", data: ["message": $0]) }
    }
    private func perform(_ call: CAPPluginCall, _ action: @escaping () throws -> [String: Any]) {
        DispatchQueue.main.async {
            do { call.resolve(try action()) } catch { call.reject(String(describing: error)) }
        }
    }
    @objc func scan(_ call: CAPPluginCall) {
        perform(call) { try self.link.scan(timeoutMs: call.getInt("timeoutMs") ?? 15000); return self.link.status }
    }
    @objc func connect(_ call: CAPPluginCall) {
        perform(call) {
            guard let id = call.getString("id") else { throw RayNeoCodec.Failure.invalid("id required") }
            try self.link.connect(id: id); return self.link.status
        }
    }
    @objc func disconnect(_ call: CAPPluginCall) { perform(call) { self.link.disconnect(); return self.link.status } }
    @objc func getStatus(_ call: CAPPluginCall) { perform(call) { self.link.status } }
    @objc func getLog(_ call: CAPPluginCall) { perform(call) { ["entries": self.link.logs] } }
    @objc func sendText(_ call: CAPPluginCall) {
        perform(call) {
            guard let text = call.getString("text"), let final = call.getBool("final"),
                  let number = call.getDouble("businessId"), number.isFinite, number.rounded() == number,
                  number >= 0, number <= 255 else { throw RayNeoCodec.Failure.invalid("text, final and integer businessId (0...255) required") }
            try self.link.sendExperimentalText(text, final: final, experimental: call.getBool("experimental") == true, businessId: UInt8(number))
            return ["submitted": true, "displayVerified": false]
        }
    }
}
