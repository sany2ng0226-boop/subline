import Foundation

struct LensCaptionFrame {
    let text: String
    let japaneseWindowed: Bool
    let chineseTruncated: Bool
}

enum LensCaptionRenderer {
    static let maximumUTF8Bytes = 384
    static let lineCharacters = 20
    private static let lineBytes = 95

    /// Japanese always occupies the top two lines and Chinese the bottom two, so position alone
    /// tells the languages apart; empty input leaves its lines blank instead of showing a placeholder.
    static func render(japanese: String, chinese: String) -> LensCaptionFrame {
        let original = Array(normalizeWhitespace(japanese))
        var start = max(0, original.count - (lineCharacters * 2 - 1))
        var japaneseLines: (first: String, second: String, consumed: Int)
        while true {
            let visible = Array((start > 0 ? "…" : "") + String(original.dropFirst(start)))
            japaneseLines = lines(visible)
            if japaneseLines.consumed == visible.count { break }
            start += 1
        }

        let translated = Array(normalizeWhitespace(chinese))
        var chineseLines = lines(translated)
        let truncated = chineseLines.consumed < translated.count
        if truncated {
            while chineseLines.second.count + 1 > lineCharacters || chineseLines.second.utf8.count + "…".utf8.count > lineBytes {
                chineseLines.second.removeLast()
            }
            chineseLines.second += "…"
        }
        let text = [japaneseLines.first, japaneseLines.second, chineseLines.first, chineseLines.second].joined(separator: "\n")
        return LensCaptionFrame(text: text, japaneseWindowed: start > 0, chineseTruncated: truncated)
    }

    static func normalizeWhitespace(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    private static func lines(_ characters: [Character]) -> (first: String, second: String, consumed: Int) {
        var offset = 0
        let first = take(characters, offset: &offset, count: lineCharacters, bytes: lineBytes)
        let second = take(characters, offset: &offset, count: lineCharacters, bytes: lineBytes)
        return (first, second, offset)
    }

    private static func take(_ characters: [Character], offset: inout Int, count: Int, bytes: Int) -> String {
        var result = ""
        while offset < characters.count && result.count < count {
            let next = String(characters[offset])
            guard result.utf8.count + next.utf8.count <= bytes else { break }
            result += next; offset += 1
        }
        return result
    }
}
