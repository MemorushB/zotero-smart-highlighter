import Foundation

enum TokenizerError: Error {
    case missingVocabulary(String)
    case invalidVocabulary(String)
}

final class WordPieceTokenizer {
    private let vocabPath: String
    private let vocab: [String: Int]
    private let maxLength: Int

    // Special token IDs (BERT defaults)
    let clsTokenId: Int
    let sepTokenId: Int
    let padTokenId: Int
    let unkTokenId: Int

    init(vocabPath: String, maxLength: Int = 512) throws {
        self.vocabPath = vocabPath
        self.maxLength = maxLength

        let loadedVocab = try Self.loadVocabulary(from: vocabPath)
        guard
            let clsTokenId = loadedVocab["[CLS]"],
            let sepTokenId = loadedVocab["[SEP]"],
            let padTokenId = loadedVocab["[PAD]"],
            let unkTokenId = loadedVocab["[UNK]"]
        else {
            throw TokenizerError.invalidVocabulary("Vocabulary is missing one or more required special tokens")
        }

        self.vocab = loadedVocab
        self.clsTokenId = clsTokenId
        self.sepTokenId = sepTokenId
        self.padTokenId = padTokenId
        self.unkTokenId = unkTokenId
    }

    private static func loadVocabulary(from path: String) throws -> [String: Int] {
        guard FileManager.default.fileExists(atPath: path) else {
            throw TokenizerError.missingVocabulary("Vocabulary not found at \(path)")
        }

        let content = try String(contentsOfFile: path, encoding: .utf8)
        var vocabulary: [String: Int] = [:]

        let lines = content.components(separatedBy: "\n")
        for (index, line) in lines.enumerated() {
            let token = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if !token.isEmpty {
                vocabulary[token] = index
            }
        }

        if vocabulary.isEmpty {
            throw TokenizerError.invalidVocabulary("Vocabulary at \(path) is empty")
        }

        fputs("Loaded \(vocabulary.count) vocab entries from \(path)\n", stderr)
        return vocabulary
    }

    func encodePair(query: String, candidate: String) -> (inputIds: [Int], attentionMask: [Int], tokenTypeIds: [Int]) {
        var queryTokens = tokenizeToWordPieces(query)
        var candidateTokens = tokenizeToWordPieces(candidate)
        truncatePair(queryTokens: &queryTokens, candidateTokens: &candidateTokens)

        var inputIds = [clsTokenId] + queryTokens + [sepTokenId] + candidateTokens + [sepTokenId]
        var attentionMask = [Int](repeating: 1, count: inputIds.count)
        var tokenTypeIds = [Int](repeating: 0, count: 1 + queryTokens.count + 1)
        tokenTypeIds += [Int](repeating: 1, count: candidateTokens.count + 1)

        let padCount = maxLength - inputIds.count
        if padCount > 0 {
            inputIds += [Int](repeating: padTokenId, count: padCount)
            attentionMask += [Int](repeating: 0, count: padCount)
            tokenTypeIds += [Int](repeating: 0, count: padCount)
        }

        return (inputIds, attentionMask, tokenTypeIds)
    }

    private func truncatePair(queryTokens: inout [Int], candidateTokens: inout [Int]) {
        let maxPairLength = max(0, maxLength - 3)
        while queryTokens.count + candidateTokens.count > maxPairLength {
            if queryTokens.count > candidateTokens.count {
                queryTokens.removeLast()
                continue
            }

            candidateTokens.removeLast()
        }
    }

    private func tokenizeToWordPieces(_ text: String) -> [Int] {
        return basicTokenize(text).flatMap { token in
            encodeWordPiece(token)
        }
    }

    private func basicTokenize(_ text: String) -> [String] {
        let normalized = stripAccents(text.lowercased())
        var tokens: [String] = []
        var currentToken = ""

        for scalar in normalized.unicodeScalars {
            let character = String(scalar)
            if CharacterSet.whitespacesAndNewlines.contains(scalar) {
                flushCurrentToken(into: &tokens, currentToken: &currentToken)
                continue
            }

            if isCJKScalar(scalar) || isPunctuationScalar(scalar) {
                flushCurrentToken(into: &tokens, currentToken: &currentToken)
                tokens.append(character)
                continue
            }

            currentToken.append(character)
        }

        flushCurrentToken(into: &tokens, currentToken: &currentToken)
        return tokens.filter { !$0.isEmpty }
    }

    private func encodeWordPiece(_ token: String) -> [Int] {
        if token.count > 100 {
            return [unkTokenId]
        }

        if let wholeTokenId = vocab[token] {
            return [wholeTokenId]
        }

        let characters = Array(token)
        var startIndex = 0
        var tokenIds: [Int] = []

        while startIndex < characters.count {
            var endIndex = characters.count
            var matchedTokenId: Int?

            while endIndex > startIndex {
                let piece = String(characters[startIndex..<endIndex])
                let candidate = startIndex == 0 ? piece : "##\(piece)"
                if let tokenId = vocab[candidate] {
                    matchedTokenId = tokenId
                    break
                }
                endIndex -= 1
            }

            guard let tokenId = matchedTokenId else {
                return [unkTokenId]
            }

            tokenIds.append(tokenId)
            startIndex = endIndex
        }

        return tokenIds
    }

    private func flushCurrentToken(into tokens: inout [String], currentToken: inout String) {
        guard !currentToken.isEmpty else {
            return
        }

        tokens.append(currentToken)
        currentToken.removeAll(keepingCapacity: true)
    }

    private func stripAccents(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .widthInsensitive], locale: Locale(identifier: "en_US_POSIX"))
    }

    private func isPunctuationScalar(_ scalar: UnicodeScalar) -> Bool {
        CharacterSet.punctuationCharacters.contains(scalar) || CharacterSet.symbols.contains(scalar)
    }

    private func isCJKScalar(_ scalar: UnicodeScalar) -> Bool {
        switch scalar.value {
        case 0x4E00...0x9FFF,
             0x3400...0x4DBF,
             0x20000...0x2A6DF,
             0x2A700...0x2B73F,
             0x2B740...0x2B81F,
             0x2B820...0x2CEAF,
             0xF900...0xFAFF,
             0x2F800...0x2FA1F,
             0x3040...0x309F,
             0x30A0...0x30FF,
             0xAC00...0xD7AF:
            return true
        default:
            return false
        }
    }
}
