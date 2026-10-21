import Foundation
import CoreBluetooth

final class RayNeoLink: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let service = CBUUID(string: "0000B81D-0000-1000-8000-00805F9B34FB")
    private static let outbound = CBUUID(string: "EA8B70D5-2BD3-49AB-9C31-9C38B2C3C4F9")
    private var central: CBCentralManager?
    private var candidates: [UUID: CBPeripheral] = [:]
    private var peripheral: CBPeripheral?
    private var writer: CBCharacteristic?
    private var scanTimer: DispatchWorkItem?
    private var sequence: UInt16 = 0
    private var pendingWrite = false
    private(set) var logs: [String] = []
    var onStatus: (([String: Any]) -> Void)?
    var onLog: ((String) -> Void)?
    private var state = "idle"
    var status: [String: Any] {
        ["state": state, "connected": peripheral?.state == .connected,
         "writable": writer != nil, "authenticated": false,
         "id": peripheral?.identifier.uuidString ?? "",
         "devices": candidates.values.map { ["id": $0.identifier.uuidString, "name": $0.name ?? ""] }]
    }
    private func log(_ message: String) {
        let entry = "\(Date().timeIntervalSince1970) \(message)"
        logs.append(entry); if logs.count > 500 { logs.removeFirst(logs.count - 500) }
        NSLog("RayNeo %@", message); onLog?(entry)
    }
    private func update(_ next: String) { state = next; onStatus?(status) }
    private func prepare() {
        if central == nil { central = CBCentralManager(delegate: self, queue: .main) }
    }
    func scan(timeoutMs: Int) throws {
        prepare()
        guard central?.state == .poweredOn else { throw RayNeoCodec.Failure.invalid("Bluetooth not poweredOn; retry after status event") }
        guard peripheral == nil else { throw RayNeoCodec.Failure.invalid("Disconnect before scanning") }
        scanTimer?.cancel(); candidates.removeAll()
        central?.scanForPeripherals(withServices: [Self.service], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        log("Scan ONLY \(Self.service)"); update("scanning")
        let timer = DispatchWorkItem { [weak self] in
            self?.central?.stopScan(); self?.log("Scan stopped"); self?.update("idle")
        }
        scanTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(max(100, min(timeoutMs, 60000))) / 1000, execute: timer)
    }
    func connect(id: String) throws {
        guard let uuid = UUID(uuidString: id), let chosen = candidates[uuid], central?.state == .poweredOn,
              peripheral == nil else { throw RayNeoCodec.Failure.invalid("Choose a scanned peripheral; disconnect existing link first") }
        scanTimer?.cancel(); central?.stopScan(); writer = nil; pendingWrite = false
        peripheral = chosen; chosen.delegate = self
        central?.connect(chosen); log("Connect \(id)"); update("connecting")
    }
    func disconnect() {
        scanTimer?.cancel(); central?.stopScan(); writer = nil; pendingWrite = false
        if let peripheral = peripheral { central?.cancelPeripheralConnection(peripheral); update("disconnecting") }
        else { update("idle") }
    }
    func sendExperimentalText(_ text: String, final: Bool, experimental: Bool, businessId: UInt8?) throws {
        guard experimental, let businessId = businessId else { throw RayNeoCodec.Failure.invalid("Explicit experimental=true and caller businessId required; wire ID unknown") }
        guard let peripheral = peripheral, peripheral.state == .connected,
              let characteristic = writer, characteristic.uuid == Self.outbound,
              characteristic.service?.uuid == Self.service else { throw RayNeoCodec.Failure.invalid("Outbound unavailable") }
        let type: CBCharacteristicWriteType
        if characteristic.properties.contains(.write) { type = .withResponse }
        else if characteristic.properties.contains(.writeWithoutResponse) { type = .withoutResponse }
        else { throw RayNeoCodec.Failure.invalid("Outbound has no write property") }
        guard !pendingWrite, type != .withoutResponse || peripheral.canSendWriteWithoutResponse else {
            throw RayNeoCodec.Failure.invalid("Write busy/backpressure; no queue")
        }
        // Flags=0 is an experimental candidate, not a verified voiceAssistant route.
        let frame = try RayNeoCodec.encodeFrame(.init(messageNumber: sequence, flags: 0, address: nil,
            sliceMetadata: Data(), businessID: businessId, payload: RayNeoCodec.assistantText(text, final: final)))
        guard frame.count <= peripheral.maximumWriteValueLength(for: type) else { throw RayNeoCodec.Failure.invalid("Frame exceeds CoreBluetooth write limit; no slicing") }
        sequence &+= 1; pendingWrite = type == .withResponse
        log("EXPERIMENTAL outbound \(frame.map { String(format: "%02X", $0) }.joined())")
        peripheral.writeValue(frame, for: characteristic, type: type)
        log("Submitted; no protocol/display ACK")
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        log("Bluetooth state \(central.state.rawValue)")
        if central.state != .poweredOn {
            scanTimer?.cancel(); writer = nil; pendingWrite = false
            peripheral = nil; candidates.removeAll(); update("unavailable")
        } else { update("idle") }
    }
    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        candidates[peripheral.identifier] = peripheral
        log("Discovered \(peripheral.identifier) name=\(peripheral.name ?? "") RSSI=\(RSSI) advertisement=\(advertisementData)")
        onStatus?(status)
    }
    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard self.peripheral === peripheral else { return }
        log("Connected; NOT authenticated"); update("connected")
        peripheral.discoverServices([Self.service])
    }
    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        finish(peripheral, error: error)
    }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        finish(peripheral, error: error)
    }
    private func finish(_ peripheral: CBPeripheral, error: Error?) {
        log("Link ended \(peripheral.identifier) \(String(describing: error))")
        guard self.peripheral === peripheral else { return }
        writer = nil; pendingWrite = false; self.peripheral = nil; update("idle")
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        log("Services error=\(String(describing: error))")
        guard self.peripheral === peripheral, error == nil else { return }
        for service in peripheral.services ?? [] {
            log("Service \(service.uuid)")
            if service.uuid == Self.service { peripheral.discoverCharacteristics(nil, for: service) }
        }
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        log("Characteristics \(service.uuid) error=\(String(describing: error))")
        guard self.peripheral === peripheral, service.uuid == Self.service, error == nil else { return }
        for characteristic in service.characteristics ?? [] {
            log("Characteristic \(characteristic.uuid) properties=\(characteristic.properties.rawValue)")
            if characteristic.uuid == Self.outbound,
               characteristic.properties.contains(.write) || characteristic.properties.contains(.writeWithoutResponse) {
                writer = characteristic
            }
            if characteristic.properties.contains(.notify) || characteristic.properties.contains(.indicate) {
                peripheral.setNotifyValue(true, for: characteristic)
            }
        }
        onStatus?(status)
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        log("Subscription \(characteristic.uuid) active=\(characteristic.isNotifying) error=\(String(describing: error))")
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        log("Notification \(characteristic.uuid) \((characteristic.value ?? Data()).map { String(format: "%02X", $0) }.joined()) error=\(String(describing: error))")
    }
    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        pendingWrite = false
        log("BLE write response \(characteristic.uuid) error=\(String(describing: error)); NOT display ACK")
    }
    func peripheral(_ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
        log("Services invalidated \(invalidatedServices.map { $0.uuid })"); disconnect()
    }
}
