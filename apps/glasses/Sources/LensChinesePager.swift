import Foundation

struct LensChinesePager {
    let dwell: TimeInterval
    let maximumPending: Int
    private struct Entry { let text: String; let pages: [LensChinesePage] }
    private var active: Entry?
    private var pending: [Entry] = []
    private var index = 0
    private var shownAt: TimeInterval = 0
    private(set) var overflowCount = 0

    init(dwell: TimeInterval = 3, maximumPending: Int = 2) {
        self.dwell = dwell; self.maximumPending = maximumPending
    }

    var page: LensChinesePage { active?.pages[index] ?? LensChinesePage(first: "等待译文", second: "") }
    var pageIndex: Int { index + 1 }
    var pageCount: Int { active?.pages.count ?? 1 }
    var pendingCount: Int { pending.count }

    mutating func enqueue(_ text: String, now: TimeInterval) -> Bool {
        let normalized = LensCaptionRenderer.normalizeWhitespace(text)
        guard !normalized.isEmpty else { return true }
        if normalized == pending.last?.text || (pending.isEmpty && normalized == active?.text) { return true }
        let entry = Entry(text: normalized, pages: LensCaptionRenderer.chinesePages(normalized))
        if active == nil || (pending.isEmpty && index == pageCount - 1 && now - shownAt >= dwell) {
            active = entry; index = 0; shownAt = now; return true
        }
        guard pending.count < maximumPending else { overflowCount += 1; return false }
        pending.append(entry)
        return true
    }

    mutating func advance(now: TimeInterval) -> Bool {
        guard active != nil, now - shownAt >= dwell else { return false }
        if index + 1 < pageCount { index += 1; shownAt = now; return true }
        if !pending.isEmpty { active = pending.removeFirst(); index = 0; shownAt = now; return true }
        return false
    }

    func delay(now: TimeInterval) -> TimeInterval? {
        guard active != nil, index + 1 < pageCount || !pending.isEmpty else { return nil }
        return max(0, shownAt + dwell - now)
    }

    mutating func reset() {
        active = nil; pending = []; index = 0; shownAt = 0; overflowCount = 0
    }
}
