import Foundation

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    precondition(condition(), message)
}

let initial = LensCaptionRenderer.render(japanese: "今日は", chinese: "今天")
check(initial.text == "日 今日は\n中 今天", "Both languages must share one verified display field")
let partial = LensCaptionRenderer.render(japanese: "今日は授業です", chinese: "今天")
check(partial.text.contains("日 今日は授業です"), "A partial replaces the Japanese portion")
check(partial.text.hasSuffix("中 今天"), "A new partial preserves the latest completed translation")
let translated = LensCaptionRenderer.render(japanese: "今日は授業です", chinese: "今天有课")
check(translated.text == "日 今日は授業です\n中 今天有课", "A translation updates Chinese without replacing Japanese")

let multiline = LensCaptionRenderer.render(japanese: "\n今日は\r\n\t授業です。  ", chinese: "  今天\t有课。\r\n请注意。\n")
check(multiline.text == "日 今日は 授業です。\n中 今天 有课。 请注意。", "Input whitespace must not create extra lens lines")
check(multiline.text.filter { $0 == "\n" }.count == 1, "Only the renderer's language separator may remain")
let blank = LensCaptionRenderer.render(japanese: "\r\n\t  \u{00a0}", chinese: "\t \n\r")
check(blank.text == "日 等待日语\n中 等待译文", "Whitespace-only input uses the waiting labels")
let longMultiline = LensCaptionRenderer.render(japanese: String(repeating: "日本語\r\n", count: 100),
                                            chinese: String(repeating: "中文\t\n", count: 300))
check(longMultiline.text.utf8.count <= 384 && longMultiline.text.filter { $0 == "\n" }.count == 1,
      "Normalized multiline text must still obey the whole-frame byte budget")

let longJapanese = String(repeating: "前の文章。", count: 40) + "最後の日本語です。"
let longChinese = String(repeating: "这是完整中文。", count: 100)
let bounded = LensCaptionRenderer.render(japanese: longJapanese, chinese: longChinese)
check(bounded.text.utf8.count <= 384, "The complete bilingual frame including labels and warnings must fit")
check(bounded.japaneseWindowed && bounded.chineseTruncated, "Both bounded portions must report their limits")
check(bounded.text.contains("最後の日本語です。\n中 "), "Japanese must retain its latest tail")
check(bounded.text.hasSuffix("…（未完）"), "Chinese truncation must be visible")
check(bounded.text.hasPrefix("日 …"), "A Japanese tail window must visibly mark the omitted prefix")

let family = "👩‍👩‍👧‍👦"
let graphemes = LensCaptionRenderer.render(japanese: String(repeating: family, count: 50),
                                         chinese: String(repeating: "e\u{301}", count: 300))
check(graphemes.text.utf8.count <= 384, "Complex graphemes still obey the UTF-8 budget")
let jpLine = String(graphemes.text.split(separator: "\n")[0]).dropFirst(3)
check(jpLine.allSatisfy { String($0) == family }, "A family emoji must never be split into separate people")
check(graphemes.text.hasSuffix("…（未完）"), "Combining-character truncation must remain marked")

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
