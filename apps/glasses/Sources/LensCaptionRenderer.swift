import Foundation

struct LensChinesePage: Equatable {
    let first: String
    let second: String
}

struct LensCaptionFrame {
    let text: String
    let japaneseWindowed: Bool
}

enum LensCaptionRenderer {
    static let maximumUTF8Bytes = 384
    static let lineCharacters = 16
    private static let lineBytes = 95

    static func chinesePages(_ text: String) -> [LensChinesePage] {
        let normalized = normalizeWhitespace(text)
        let characters = Array(normalized.isEmpty ? "等待译文" : normalized)
        var estimate = 1
        while true {
            let suffix = " \(estimate)/\(estimate)"
            var offset = 0
            var pages: [LensChinesePage] = []
            while offset < characters.count {
                // Reserve warning space so backlog notices do not reflow existing pages.
                let first = take(characters, offset: &offset, count: 13, bytes: 88)
                let second = take(characters, offset: &offset,
                                  count: max(1, lineCharacters - suffix.count),
                                  bytes: max(3, lineBytes - suffix.utf8.count))
                pages.append(LensChinesePage(first: first, second: second))
            }
            if String(pages.count).count <= String(estimate).count { return pages }
            estimate = pages.count
        }
    }

    static func render(japanese: String, page: LensChinesePage, pageIndex: Int,
                       pageCount: Int, backlog: Bool) -> LensCaptionFrame {
        let normalized = normalizeWhitespace(japanese)
        let characters = Array(normalized.isEmpty ? "等待日语" : normalized)
        var start = max(0, characters.count - 30)
        var first = "", second = ""
        while true {
            let content = (start > 0 ? "…" : "") + String(characters.dropFirst(start))
            first = "日 " + String(content.prefix(14))
            second = String(content.dropFirst(14))
            if first.utf8.count <= lineBytes && second.utf8.count <= lineBytes && second.count <= 16 { break }
            guard start < characters.count else { first = "日 …"; second = ""; break }
            start += 1
        }
        let prefix = backlog ? "中! " : "中 "
        let suffix = " \(pageIndex)/\(pageCount)"
        return LensCaptionFrame(text: [first, second, prefix + page.first, page.second + suffix].joined(separator: "\n"),
                                japaneseWindowed: start > 0)
    }

    static func normalizeWhitespace(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    private static func take(_ characters: [Character], offset: inout Int, count: Int, bytes: Int) -> String {
        var result = ""
        while offset < characters.count && result.count < count {
            let next = String(characters[offset])
            if result.utf8.count + next.utf8.count > bytes {
                if result.isEmpty { offset += 1; return "…" }
                break
            }
            result += next; offset += 1
        }
        return result
    }
}
