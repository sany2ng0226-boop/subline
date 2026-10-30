import Foundation

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    precondition(condition(), message)
}

func verifyLayout(japanese: String, chinese: String) {
    let pages = LensCaptionRenderer.chinesePages(chinese)
    let normalized = LensCaptionRenderer.normalizeWhitespace(chinese)
    check(pages.map { $0.first + $0.second }.joined() == (normalized.isEmpty ? "等待译文" : normalized),
          "Paging must preserve all representable Chinese characters")
    for (index, page) in pages.enumerated() {
        let frame = LensCaptionRenderer.render(japanese: japanese, page: page, pageIndex: index + 1,
                                               pageCount: pages.count, backlog: true)
        let lines = frame.text.components(separatedBy: "\n")
        check(lines.count == 4, "Display must always have two Japanese and two Chinese lines")
        check(lines.allSatisfy { $0.count <= 16 && $0.utf8.count <= 95 }, "Labels, page numbers and warnings fit each line")
        check(frame.text.utf8.count <= 384, "The complete four-line frame fits the device packet budget")
        check(!frame.text.contains("\r") && !frame.text.contains("\t"), "Input whitespace cannot create hidden rows")
        check(lines[3].hasSuffix("\(index + 1)/\(pages.count)"), "Every Chinese page has an explicit index")
    }
}
verifyLayout(japanese: "今日は授業です。", chinese: "今天有课。")
verifyLayout(japanese: "\n今日は\r\n\t授業です。  ", chinese: "  今天\t有课。\r\n请注意。\n")
verifyLayout(japanese: "\r\n\t \u{00a0}", chinese: "\t \n\r")
verifyLayout(japanese: String(repeating: "前の文章。", count: 40) + "最後の日本語です。",
             chinese: String(repeating: "这是完整中文，English text 123。", count: 100))
let family = "👩‍👩‍👧‍👦"
verifyLayout(japanese: String(repeating: family, count: 50), chinese: String(repeating: family + "e\u{301}", count: 100))

var pager = LensChinesePager()
let longChinese = String(repeating: "完整中文不会被下一条直接替换。", count: 4)
check(pager.enqueue(longChinese, now: 0), "First translation opens its first page")
let firstPage = pager.page
for index in 0...20 {
    _ = LensCaptionRenderer.render(japanese: "变化\(index)", page: pager.page, pageIndex: pager.pageIndex,
                                   pageCount: pager.pageCount, backlog: false)
}
check(pager.page == firstPage && pager.delay(now: 1.5) == 1.5, "Japanese partial rendering cannot reset Chinese dwell")
check(pager.enqueue("下一句一", now: 0.1) && pager.enqueue("下一句二", now: 0.2), "Two pending translations are retained")
check(!pager.enqueue("溢出的新句", now: 0.3), "A full queue explicitly rejects overflow rather than replacing unread pages")
check(pager.pendingCount == 2 && pager.overflowCount == 1 && pager.page == firstPage, "Backlog is bounded and visible")
check(!pager.advance(now: 2.99) && pager.advance(now: 3), "A page keeps its three-second dwell")
var now = 3.0
while pager.pageIndex < pager.pageCount { now += 3; check(pager.advance(now: now), "Every active page remains readable") }
check(pager.pendingCount == 2, "The next translation waits until the last old page has had its dwell")
now += 3
check(pager.advance(now: now) && pager.pageIndex == 1 && pager.page.first == "下一句一", "Next translation starts only after the old final page")
pager.reset()
check(pager.delay(now: 100) == nil && pager.pendingCount == 0 && pager.overflowCount == 0, "Stop/new session clears all pager state")
check(pager.enqueue(longChinese, now: 100) && pager.page == firstPage, "Restart can show the same translation from page one")

var gate = LensCaptionScheduler()
gate.begin(sessionID: "first")
check(gate.update("pending A", now: 0) == nil, "Nothing is sent before a subtitle ACK")
check(gate.update("pending B", now: 0.1) == nil, "Pre-ACK updates must only keep the newest frame")
check(!gate.acknowledge(sessionID: "wrong"), "An unrelated session cannot unlock sends")
check(gate.flush(now: 1) == nil, "The wrong ACK must have no effect")
check(gate.acknowledge(sessionID: "first"), "The matching session can become ready")
check(gate.flush(now: 1) == "pending B", "Only the latest pre-ACK frame may be delivered")
check(gate.update("pending B", now: 1.1) == nil, "Identical delivered text is not resent")
check(gate.flush(now: 2) == nil, "An identical update must not leave a delayed duplicate")
check(gate.update("new Japanese", now: 2) == "new Japanese", "A new frame can be delivered after the interval")
check(gate.update("intermediate", now: 2.1) == nil, "Intermediate partials are coalesced")
check(gate.update("new Japanese", now: 2.2) == nil, "Returning to the last visible frame cancels stale pending text")
check(gate.flush(now: 3) == nil, "An obsolete intermediate partial must never appear later")

var live = LensCaptionScheduler()
live.begin(sessionID: "live")
_ = live.acknowledge(sessionID: "live")
check(live.update("日 最初\n中 前一句", now: 0) != nil, "The leading update is immediate")
for index in 1...49 {
    let chinese = index < 25 ? "前一句" : "新译文"
    check(live.update("日 \(index)\n中 \(chinese)", now: Double(index) / 100) == nil,
          "Continuous partials must not bypass the throttle")
}
check(live.flush(now: 0.499) == nil, "A trailing update cannot send early")
check(live.flush(now: 0.5) == "日 49\n中 新译文", "Continuous partials cannot starve a completed translation")
check(live.update("queued", now: 0.6) == nil, "A later frame waits for its allowed time")
live.cancel()
check(live.flush(now: 10) == nil && live.delay(now: 10) == nil, "Stop clears delayed frames and scheduling")
live.begin(sessionID: "restarted")
check(!live.acknowledge(sessionID: "live"), "A previous session ACK cannot authorize a restart")
_ = live.acknowledge(sessionID: "restarted")
check(live.update("日 49\n中 新译文", now: 10) != nil, "A new session may display the same text again")

var rate = LensCaptionScheduler()
rate.begin(sessionID: "rate")
_ = rate.acknowledge(sessionID: "rate")
var emissions: [Double] = []
for index in 0...100 {
    let now = Double(index) / 50
    if rate.update("frame \(index)", now: now) != nil { emissions.append(now) }
}
for (a, b) in zip(emissions, emissions.dropFirst()) {
    check(b - a >= 0.5 - 0.000_001, "Every send must obey the half-second interval")
}
check(emissions.count <= 5, "A hundred updates cannot build a hundred-send queue")
print("PASS bilingual renderer and lifecycle throttle checks")
