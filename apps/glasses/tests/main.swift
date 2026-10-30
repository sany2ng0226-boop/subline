import Foundation

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    precondition(condition(), message)
}

func verifyLayout(japanese: String, chinese: String) -> LensCaptionFrame {
    let frame = LensCaptionRenderer.render(japanese: japanese, chinese: chinese)
    let lines = frame.text.isEmpty ? [] : frame.text.components(separatedBy: "\n")
    check(lines.count <= 5, "Text uses no more than the requested five rows")
    check(lines.allSatisfy { $0.count <= 20 && $0.utf8.count <= 75 }, "Each row has bounded glyphs and UTF-8 bytes")
    check(frame.text.utf8.count < LensCaptionRenderer.maximumUTF8Bytes, "The entire frame stays within its budget")
    check(!frame.text.contains("\r") && !frame.text.contains("\t"), "Whitespace cannot create hidden rows")
    return frame
}
let short = verifyLayout(japanese: "今日は授業です。", chinese: "今天有课。")
check(short.text == "今日は授業です。\n今天有课。", "Short text does not reserve empty language rows")
check(!short.chineseTruncated && !short.japaneseWindowed, "Short text is complete")
check(verifyLayout(japanese: " \r\n", chinese: "\t").text.isEmpty, "Empty input leaves an empty frame")
let longCN = "重要结论在这里。" + String(repeating: "接下来是完整的中文内容。", count: 100)
let oneJP = verifyLayout(japanese: "短い原文です。", chinese: longCN)
let oneJPRows = oneJP.text.components(separatedBy: "\n")
check(oneJPRows.count == 5 && oneJPRows[1].hasPrefix("重要结论"), "Short Japanese leaves four rows for Chinese")
check(oneJPRows.dropFirst().joined().count == 80 && oneJP.chineseTruncated && oneJP.text.hasSuffix("…"), "Long Chinese uses eighty visible characters including omission marker")
let onlyCN = verifyLayout(japanese: "", chinese: longCN)
check(onlyCN.text.components(separatedBy: "\n").count == 5 && onlyCN.text.replacingOccurrences(of: "\n", with: "").count == 100, "One language can use all five rows")
let longJP = String(repeating: "前の文章。", count: 40) + "最後の日本語です。"
let long = verifyLayout(japanese: longJP, chinese: longCN)
let longRows = long.text.components(separatedBy: "\n")
check(long.japaneseWindowed && longRows.prefix(2).joined().hasSuffix("最後の日本語です。"), "Long bilingual text keeps the most recent two Japanese rows")
check(longRows[2].hasPrefix("重要结论"), "Long Chinese gets three rows instead of two")
let moreJP = verifyLayout(japanese: longJP, chinese: "短译文。")
check(moreJP.text.components(separatedBy: "\n").count == 5 && moreJP.text.hasSuffix("短译文。"), "Short Chinese leaves four original rows")
let exact = String(repeating: "日", count: 40)
check(!verifyLayout(japanese: exact, chinese: longCN).japaneseWindowed, "Exactly fitting Japanese must not lose a character to an unnecessary ellipsis")
let family = "👩‍👩‍👧‍👦"
let unicode = verifyLayout(japanese: String(repeating: family, count: 50), chinese: String(repeating: family + "e\u{301}", count: 100))
for line in unicode.text.components(separatedBy: "\n") {
    check(line.replacingOccurrences(of: "…", with: "").allSatisfy { String($0) == family || String($0) == "e\u{301}" }, "Grapheme clusters remain intact")
}
let giant = "a" + String(repeating: "\u{301}", count: 150)
_ = verifyLayout(japanese: giant, chinese: giant)
_ = verifyLayout(japanese: "\n今日は\t授業です。", chinese: "今天\r\n有课。")

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
