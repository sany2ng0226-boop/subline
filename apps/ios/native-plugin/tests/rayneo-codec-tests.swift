import Foundation

@main
struct CodecTests {
    static func check(_ condition: @autoclosure () throws -> Bool) throws {
        let result = try condition(); precondition(result)
    }
    static func rejects(_ action: () throws -> Void) {
        do { try action(); fatalError("Expected rejection") } catch { }
    }
    static func main() throws {
        assert(RayNeoCodec.crc(Data("123456789".utf8)) == 0x31C3)
        let expected: [UInt8] = [0x08,0x01,0x10,0x05,0x1A,0x19,0x7B,0x22,0x66,0x69,0x6E,0x61,0x6C,0x22,0x3A,0x74,0x72,0x75,0x65,0x2C,0x22,0x74,0x65,0x78,0x74,0x22,0x3A,0x22,0x41,0x22,0x7D]
        try check(try RayNeoCodec.assistantText("A", final: true) == Data(expected))
        for address: UInt8? in [nil, 7] {
            for count in 0...7 {
                let frame = RayNeoCodec.Frame(messageNumber: 0xABCD, flags: address == nil ? 0 : 2,
                    address: address, sliceMetadata: Data(repeating: 9, count: count), businessID: 0xEF, payload: Data([0, 255, 3]))
                let encoded = try RayNeoCodec.encodeFrame(frame)
                try check(try RayNeoCodec.decodeFrame(encoded) == frame)
                assert(Int(encoded[2]) * 256 + Int(encoded[3]) == encoded.count - 6)
                var bad = encoded; bad[bad.count - 1] ^= 1
                rejects { _ = try RayNeoCodec.decodeFrame(bad) }
                for end in 0..<encoded.count { rejects { _ = try RayNeoCodec.decodeFrame(encoded.prefix(end)) } }
            }
        }
        let fields = [RayNeoCodec.TLV(tag: 1, value: Data()), .init(tag: 2, value: Data(repeating: 255, count: 300))]
        try check(try RayNeoCodec.decodeTLV(RayNeoCodec.encodeTLV(fields)) == fields)
        rejects { _ = try RayNeoCodec.decodeTLV(Data([1, 0, 2, 0])) }
        rejects { _ = try RayNeoCodec.assistantText(String(repeating: "界", count: 171), final: false) }
        _ = try RayNeoCodec.assistantText(String(repeating: "a", count: 512), final: false)
        let text = "引号\"\\\n\t\u{0000}😀"
        let payload = try RayNeoCodec.assistantText(text, final: false)
        var offset = 5
        while payload[offset] & 128 != 0 { offset += 1 }
        offset += 1
        let json = try JSONSerialization.jsonObject(with: payload.suffix(from: offset)) as! [String: Any]
        assert(json["text"] as? String == text && json["final"] as? Bool == false)
        let version = try RayNeoCodec.decodeTLV(RayNeoCodec.versionExchange(phoneID: Data(repeating: 1, count: 6), phoneName: "Phone", model: "Model", relationship: 2))
        assert(version[0].tag == 0x11)
        try check(try RayNeoCodec.decodeTLV(version[0].value).map { $0.tag } == [0x10,0x11,0x12,0x13,0x16,0x17,0x1B])
        let p = Data([1,2,3,4,5,6]), g = Data([6,5,4,3,2,1]), r = Data([1,2,3,4])
        let proof = RayNeoCodec.proof(random: r, phoneID: p, glassAddress: g)
        assert(proof.map { String(format: "%02x", $0) }.joined() == "611134a41e292e1a06775893caa470e5fbeb23d7d44c1355c81f82c6ce59fb6d")
        try check(try RayNeoCodec.sessionKey(phoneRandom: r, glassRandom: r, phoneID: p, glassAddress: g, glassProof: proof).count == 32)
        let key = try RayNeoCodec.sessionKey(phoneRandom: r, glassRandom: r, phoneID: p, glassAddress: g, glassProof: proof)
        assert(key.map { String(format: "%02x", $0) }.joined() == "7346a29323daa142be05e520b2597608d0eca940b63bc1a060c70ab90728ab16")
        rejects { _ = try RayNeoCodec.sessionKey(phoneRandom: r, glassRandom: r, phoneID: p, glassAddress: g, glassProof: Data(repeating: 0, count: 32)) }
        print("RayNeo codec tests passed")
    }
}
