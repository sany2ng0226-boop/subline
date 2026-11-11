import Foundation

/// Leading-edge throttle with a latest-frame trailing update, never a resettable debounce.
struct LensCaptionScheduler {
    let interval: TimeInterval
    private(set) var sessionID: String?
    private(set) var ready = false
    private var lastSent: String?
    private var pending: String?
    private var nextAllowedAt: TimeInterval = 0

    init(interval: TimeInterval = 0.5) { self.interval = interval }

    mutating func begin(sessionID: String) {
        self.sessionID = sessionID
        ready = false; lastSent = nil; pending = nil; nextAllowedAt = 0
    }

    mutating func acknowledge(sessionID: String) -> Bool {
        guard self.sessionID == sessionID else { return false }
        ready = true
        return true
    }

    mutating func cancel() {
        sessionID = nil; ready = false; pending = nil; lastSent = nil; nextAllowedAt = 0
    }

    mutating func update(_ frame: String, now: TimeInterval) -> String? {
        guard sessionID != nil else { return nil }
        pending = frame == lastSent ? nil : frame
        return flush(now: now)
    }

    mutating func flush(now: TimeInterval) -> String? {
        guard ready, let frame = pending, now >= nextAllowedAt else { return nil }
        pending = nil; lastSent = frame; nextAllowedAt = now + interval
        return frame
    }

    func delay(now: TimeInterval) -> TimeInterval? {
        guard ready, pending != nil else { return nil }
        return max(0, nextAllowedAt - now)
    }
}
