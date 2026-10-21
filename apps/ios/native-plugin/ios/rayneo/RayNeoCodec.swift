// Independent implementation from io-spec-for-impl.md facts only.
import Foundation
import CryptoKit

enum RayNeoCodec {
    enum Failure: Error { case invalid(String) }
    struct TLV: Equatable { let tag: UInt8; let value: Data }
    struct Frame: Equatable {
        let messageNumber: UInt16
        let flags: UInt8
        let address: UInt8?
        let sliceMetadata: Data
        let businessID: UInt8
        let payload: Data
    }
    static func crc(_ data: Data) -> UInt16 {
        var value: UInt16 = 0
        for byte in data {
            value ^= UInt16(byte) << 8
            for _ in 0..<8 { value = value & 0x8000 != 0 ? (value &<< 1) ^ 0x1021 : value &<< 1 }
        }
        return value
    }
    private static func word(_ value: Int) -> [UInt8] { [UInt8(value >> 8), UInt8(value & 255)] }
    static func encodeTLV(_ fields: [TLV]) throws -> Data {
        var result = Data()
        for field in fields {
            guard field.value.count <= 65535 else { throw Failure.invalid("TLV too long") }
            result.append(field.tag); result.append(contentsOf: word(field.value.count)); result.append(field.value)
        }
        return result
    }
    static func decodeTLV(_ data: Data) throws -> [TLV] {
        let bytes = Array(data); var offset = 0; var fields: [TLV] = []
        while offset < bytes.count {
            guard bytes.count - offset >= 3 else { throw Failure.invalid("Truncated TLV header") }
            let length = Int(bytes[offset + 1]) * 256 + Int(bytes[offset + 2])
            guard length <= bytes.count - offset - 3 else { throw Failure.invalid("Truncated TLV value") }
            fields.append(TLV(tag: bytes[offset], value: Data(bytes[(offset + 3)..<(offset + 3 + length)])))
            offset += 3 + length
        }
        return fields
    }
    static func encodeFrame(_ frame: Frame) throws -> Data {
        guard frame.flags < 32, frame.sliceMetadata.count <= 7,
              (frame.flags & 2 != 0) == (frame.address != nil), frame.payload.count <= 65524 else {
            throw Failure.invalid("Invalid frame fields")
        }
        var body = Data(word(Int(frame.messageNumber)))
        body.append(frame.flags | UInt8(frame.sliceMetadata.count << 5))
        if let address = frame.address { body.append(address) }
        body.append(frame.sliceMetadata); body.append(frame.businessID); body.append(frame.payload)
        guard body.count <= 65535 else { throw Failure.invalid("Frame too long") }
        var result = Data([0xAA, 0x55] + word(body.count))
        result.append(body); result.append(contentsOf: word(Int(crc(body))))
        return result
    }
    static func decodeFrame(_ data: Data) throws -> Frame {
        let b = Array(data)
        guard b.count >= 10, b.count <= 65541, b[0] == 0xAA, b[1] == 0x55,
              Int(b[2]) * 256 + Int(b[3]) == b.count - 6 else { throw Failure.invalid("Invalid frame length/magic") }
        guard crc(Data(b[4..<(b.count - 2)])) == UInt16(b[b.count - 2]) << 8 | UInt16(b[b.count - 1]) else {
            throw Failure.invalid("CRC mismatch")
        }
        let flags = b[6] & 31; let slices = Int(b[6] >> 5)
        var offset = 7; var address: UInt8?
        if flags & 2 != 0 { address = b[offset]; offset += 1 }
        guard offset + slices + 1 <= b.count - 2 else { throw Failure.invalid("Truncated metadata") }
        let metadata = Data(b[offset..<(offset + slices)]); offset += slices
        let business = b[offset]; offset += 1
        let payload = Data(b[offset..<(b.count - 2)])
        guard payload.count <= 65524 else { throw Failure.invalid("Payload too long") }
        return Frame(messageNumber: UInt16(b[4]) << 8 | UInt16(b[5]), flags: flags,
                     address: address, sliceMetadata: metadata, businessID: business, payload: payload)
    }
    // Caller supplies identity; this is not a hardware MAC lookup or a handshake.
    static func versionExchange(phoneID: Data, phoneName: String, model: String, relationship: UInt8?) throws -> Data {
        guard phoneID.count == 6, !phoneName.isEmpty, !model.isEmpty,
              phoneName.utf8.count <= 1024, model.utf8.count <= 1024,
              relationship == nil || relationship == 1 || relationship == 2 else { throw Failure.invalid("Invalid version fields") }
        var fields = [TLV(tag: 0x10, value: Data([1])), TLV(tag: 0x11, value: phoneID),
                      TLV(tag: 0x12, value: Data(phoneName.utf8)), TLV(tag: 0x13, value: Data([1])),
                      TLV(tag: 0x16, value: Data("iPhone".utf8)), TLV(tag: 0x17, value: Data(model.utf8))]
        if let relationship = relationship { fields.append(TLV(tag: 0x1B, value: Data([relationship]))) }
        return try encodeTLV([TLV(tag: 0x11, value: encodeTLV(fields))])
    }
    private static let salt = Data([0x07,0x12,0xC8,0xAD,0x27,0x74,0x41,0x95,0xDE,0x5F,0xA1,0xEA,0x6D,0x02,0x5F,0xB8])
    static func proof(random: Data, phoneID: Data, glassAddress: Data) -> Data {
        Data(SHA256.hash(data: random + phoneID + glassAddress + salt))
    }
    static func sessionKey(phoneRandom: Data, glassRandom: Data, phoneID: Data, glassAddress: Data, glassProof: Data) throws -> Data {
        let expected = proof(random: glassRandom, phoneID: phoneID, glassAddress: glassAddress)
        guard glassProof.count == expected.count else { throw Failure.invalid("Invalid proof length") }
        var difference: UInt8 = 0
        for (a, b) in zip(expected, glassProof) { difference |= a ^ b }
        guard difference == 0 else { throw Failure.invalid("Glass proof mismatch") }
        return Data(SHA256.hash(data: phoneRandom + glassRandom + phoneID + glassAddress + salt))
    }
    static func assistantText(_ text: String, final: Bool) throws -> Data {
        guard text.utf8.count <= 512 else { throw Failure.invalid("Text exceeds 512 UTF-8 bytes") }
        // JSONEncoder provides escaping; assemble keys explicitly for deterministic wire bytes.
        let escaped = try JSONEncoder().encode(text)
        var json = Data("{\"final\":\(final ? "true" : "false"),\"text\":".utf8)
        json.append(escaped); json.append(0x7D)
        var result = Data([0x08, 0x01, 0x10, 0x05, 0x1A]); var length = json.count
        repeat { var byte = UInt8(length & 127); length >>= 7; if length > 0 { byte |= 128 }; result.append(byte) } while length > 0
        result.append(json); return result
    }
}
