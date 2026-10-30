import Foundation

struct LensCaptionFrame {
    let text: String
    let japaneseWindowed: Bool
    let chineseTruncated: Bool
}

enum LensCaptionRenderer {
    static let maximumUTF8Bytes = 384
    static let maximumLines = 5
    static let lineCharacters = 20
    private static let lineBytes = (maximumUTF8Bytes - maximumLines) / maximumLines

    static func render(japanese: String, chinese: String) -> LensCaptionFrame {
        let original = Array(normalizeWhitespace(japanese))
        let translated = Array(normalizeWhitespace(chinese))
        let japaneseNeed = requiredLines(original)
        let chineseNeed = requiredLines(translated)
        var japaneseRows = chineseNeed == 0 ? japaneseNeed : min(2, japaneseNeed)
        let chineseRows = min(chineseNeed, maximumLines - japaneseRows)
        japaneseRows = min(japaneseNeed, maximumLines - chineseRows)

        var start = max(0, original.count - japaneseRows * lineCharacters)
        var japaneseLines: [String] = []
        while japaneseRows > 0 {
            let visible = Array((start > 0 ? "…" : "") + String(original.dropFirst(start)))
            let wrapped = wrap(visible, rows: japaneseRows)
            japaneseLines = wrapped.lines
            if wrapped.consumed == visible.count { break }
            start += 1
        }
        // No language reserves empty rows: short originals leave more room for the translation.
        var chineseLines = wrap(translated, rows: chineseRows)
        let truncated = chineseLines.consumed < translated.count
        if truncated, !chineseLines.lines.isEmpty {
            let last = chineseLines.lines.count - 1
            while chineseLines.lines[last].count + 1 > lineCharacters ||
                    chineseLines.lines[last].utf8.count + "…".utf8.count > lineBytes {
                chineseLines.lines[last].removeLast()
            }
            chineseLines.lines[last] += "…"
        }
        let text = (japaneseLines + chineseLines.lines).joined(separator: "\n")
        return LensCaptionFrame(text: text, japaneseWindowed: start > 0, chineseTruncated: truncated)
    }

    static func normalizeWhitespace(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    private static func requiredLines(_ characters: [Character]) -> Int {
        guard !characters.isEmpty else { return 0 }
        let wrapped = wrap(characters, rows: maximumLines)
        return wrapped.consumed < characters.count ? maximumLines : wrapped.lines.count
    }

    private static func wrap(_ characters: [Character], rows: Int) -> (lines: [String], consumed: Int) {
        var offset = 0
        var result: [String] = []
        for _ in 0..<rows {
            guard offset < characters.count else { break }
            var line = ""
            while offset < characters.count && line.count < lineCharacters {
                let next = String(characters[offset])
                guard line.utf8.count + next.utf8.count <= lineBytes else { break }
                line += next
                offset += 1
            }
            result.append(line)
            if line.isEmpty { break }
        }
        return (result, offset)
    }
}
