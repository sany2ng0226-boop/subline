import Foundation

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    precondition(condition(), message)
}

func verifyLayout(japanese: String, chinese: String) -> LensCaptionFrame {
    let frame = LensCaptionRenderer.render(japanese: japanese, chinese: chinese)
    let lines = frame.text.components(separatedBy: "\n")
    check(lines.count == 4, "Display always has two Japanese and two Chinese lines")
    check(lines.allSatisfy { $0.count <= 20 && $0.utf8.count <= 95 }, "Labels and truncation markers fit each line")
    check(frame.text.utf8.count <= 383, "The complete four-line frame fits the device packet budget")
    check(!frame.text.contains("\r") && !frame.text.contains("\t"), "Input whitespace cannot create hidden rows")
    return frame
}
let short = verifyLayout(japanese: "今日は授業です。", chinese: "今天有课。")
check(short.text == "日 今日は授業です。\n\n中 今天有课。\n", "Short bilingual text is shown completely without page numbers")
check(!short.chineseTruncated && !short.japaneseWindowed, "Short text has no omission warnings")
_ = verifyLayout(japanese: "\n今日は\r\n\t授業です。  ", chinese: "  今天\t有课。\r\n请注意。\n")
let blank = verifyLayout(japanese: "\r\n\t \u{00a0}", chinese: "\t \n\r")
check(blank.text.contains("等待日语") && blank.text.contains("等待译文"), "Whitespace-only input uses waiting labels")
let longJP = String(repeating: "前の文章。", count: 40) + "最後の日本語です。"
let longCN = "重要结论在这里。" + String(repeating: "后续完整中文与English 123。", count: 100)
let long = verifyLayout(japanese: longJP, chinese: longCN)
check(long.japaneseWindowed && long.text.hasPrefix("日 …"), "Japanese uses a visibly marked latest tail window")
check(long.text.components(separatedBy: "\n").prefix(2).joined().hasSuffix("最後の日本語です。"), "Japanese keeps the current utterance ending")
check(long.chineseTruncated && long.text.hasSuffix("…"), "Long Chinese has an explicit omission marker")
check(long.text.contains("中 重要结论在这里。"), "Chinese keeps the newest completed translation beginning")
let family = "👩‍👩‍👧‍👦"
let unicode = verifyLayout(japanese: String(repeating: family, count: 50), chinese: String(repeating: family + "e\u{301}", count: 100))
check(unicode.chineseTruncated, "Large UTF-8 graphemes must remain within the same bounded view")
for line in unicode.text.components(separatedBy: "\n") {
    let body = line.replacingOccurrences(of: "日 ", with: "").replacingOccurrences(of: "中 ", with: "").replacingOccurrences(of: "…", with: "")
    check(body.allSatisfy { String($0) == family || String($0) == "e\u{301}" }, "Emoji families and combining characters are never split")
}
let giant = "a" + String(repeating: "\u{301}", count: 150)
_ = verifyLayout(japanese: giant, chinese: giant)

var stable = LensCaptionScheduler()
stable.begin(sessionID: "static")
_ = stable.acknowledge(sessionID: "static")
check(stable.update(long.text, now: 0) == long.text, "The latest long translation has one static display frame")
for now in [3.0, 6.0, 60.0] {
    check(stable.flush(now: now) == nil, "Waiting alone never pages Japanese or Chinese automatically")
}
let changed = LensCaptionRenderer.render(japanese: "新しい原文です。", chinese: "这是新完成的译文。")
check(stable.update(changed.text, now: 61) == changed.text, "A new completed translation replaces the old view directly")

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
