import Foundation

/// Minimal WordPiece tokenizer for BERT-style models.
///
/// Phase 3a.3: This is a placeholder implementation.
/// Full implementation will use HuggingFace swift-tokenizers
/// or a custom WordPiece implementation with vocab.txt.
final class WordPieceTokenizer {
    private let vocabPath: String?
    private var vocab: [String: Int] = [:]
    private let maxLength: Int

    // Special token IDs (BERT defaults)
    let clsTokenId = 101   // [CLS]
    let sepTokenId = 102   // [SEP]
    let padTokenId = 0     // [PAD]
    let unkTokenId = 100   // [UNK]

    init(vocabPath: String? = nil, maxLength: Int = 512) {
        self.vocabPath = vocabPath
        self.maxLength = maxLength

        if let path = vocabPath {
            loadVocab(from: path)
        }
    }

    private func loadVocab(from path: String) {
        guard let content = try? String(contentsOfFile: path, encoding: .utf8) else {
            fputs("Warning: Could not load vocab from \(path)\n", stderr)
            return
        }

        let lines = content.components(separatedBy: "\n")
        for (index, line) in lines.enumerated() {
            let token = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if !token.isEmpty {
                vocab[token] = index
            }
        }

        fputs("Loaded \(vocab.count) vocab entries\n", stderr)
    }

    /// Encode a query-candidate pair for cross-encoder input.
    /// Returns (input_ids, attention_mask, token_type_ids)
    func encodePair(query: String, candidate: String) -> (inputIds: [Int], attentionMask: [Int], tokenTypeIds: [Int]) {
        // TODO: Implement proper WordPiece tokenization.
        // For now, use simple whitespace tokenization with UNK fallback.

        let queryTokens = tokenize(query)
        let candidateTokens = tokenize(candidate)

        // BERT pair format: [CLS] query_tokens [SEP] candidate_tokens [SEP]
        let maxQueryLen = (maxLength - 3) / 2
        let maxCandidateLen = maxLength - 3 - min(queryTokens.count, maxQueryLen)

        let truncatedQuery = Array(queryTokens.prefix(maxQueryLen))
        let truncatedCandidate = Array(candidateTokens.prefix(maxCandidateLen))

        var inputIds = [clsTokenId] + truncatedQuery + [sepTokenId] + truncatedCandidate + [sepTokenId]
        var attentionMask = [Int](repeating: 1, count: inputIds.count)
        var tokenTypeIds = [Int](repeating: 0, count: 1 + truncatedQuery.count + 1)
        tokenTypeIds += [Int](repeating: 1, count: truncatedCandidate.count + 1)

        let padCount = maxLength - inputIds.count
        if padCount > 0 {
            inputIds += [Int](repeating: padTokenId, count: padCount)
            attentionMask += [Int](repeating: 0, count: padCount)
            tokenTypeIds += [Int](repeating: 0, count: padCount)
        }

        return (inputIds, attentionMask, tokenTypeIds)
    }

    private func tokenize(_ text: String) -> [Int] {
        let words = text.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }

        return words.map { word in
            vocab[word] ?? unkTokenId
        }
    }
}
