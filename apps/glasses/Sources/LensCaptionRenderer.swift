import Foundation

struct LensCaptionFrame {
    let text: String
    let japaneseWindowed: Bool
    let chineseTruncated: Bool
}

enum LensCaptionRenderer {
    static let maximumUTF8Bytes = 384
    private static let japaneseBudget = 112
    private static let incomplete = "…（未完）"

    static func render(japanese: String, chinese: String) -> LensCaptionFrame {
        let normalizedJapanese = normalizeWhitespace(japanese)
        let normalizedChinese = normalizeWhitespace(chinese)
        let original = normalizedJapanese.isEmpty ? "等待日语" : normalizedJapanese
        var tail = original
        let windowed = tail.utf8.count > japaneseBudget
        if windowed {
            while tail.utf8.count + "…".utf8.count > japaneseBudget { tail.removeFirst() }
            tail = "…" + tail
        }
        let heading = "日 " + tail + "\n中 "
        let translated = normalizedChinese.isEmpty ? "等待译文" : normalizedChinese
        let budget = maximumUTF8Bytes - heading.utf8.count
        var visible = translated
        let truncated = visible.utf8.count > budget
        if truncated {
            while visible.utf8.count + incomplete.utf8.count > budget { visible.removeLast() }
            visible += incomplete
        }
        return LensCaptionFrame(text: heading + visible, japaneseWindowed: windowed, chineseTruncated: truncated)
    }

    private static func normalizeWhitespace(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }
}
