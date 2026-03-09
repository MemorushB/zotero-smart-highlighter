import Foundation
#if canImport(CoreML)
import CoreML
#endif

/// Core ML inference wrapper for cross-encoder reranking.
///
/// Phase 3a.4: Handles model loading and batch prediction.
/// The model expects BERT-style inputs (input_ids, attention_mask, token_type_ids)
/// and outputs a logit score per input pair.
final class CoreMLInferenceEngine {
    #if canImport(CoreML)
    private var model: MLModel?
    #endif
    private let tokenizer: WordPieceTokenizer
    private let batchSize: Int

    var isLoaded: Bool {
        #if canImport(CoreML)
        return model != nil
        #else
        return false
        #endif
    }

    init(tokenizer: WordPieceTokenizer, batchSize: Int = 32) {
        self.tokenizer = tokenizer
        self.batchSize = batchSize
    }

    func loadModel(from path: String) throws {
        #if canImport(CoreML)
        let url = URL(fileURLWithPath: path)
        let config = MLModelConfiguration()
        config.computeUnits = .all  // ANE > GPU > CPU
        model = try MLModel(contentsOf: url, configuration: config)
        #else
        throw NSError(
            domain: "ZPHReranker",
            code: 10,
            userInfo: [NSLocalizedDescriptionKey: "CoreML not available"]
        )
        #endif
    }

    /// Rerank candidates against a query.
    /// Returns raw logit scores (higher = more relevant).
    func rerank(query: String, candidates: [String], maxLength: Int = 512) -> [Double] {
        guard !candidates.isEmpty else {
            return []
        }

        #if canImport(CoreML)
        guard model != nil else {
            return fallbackScoring(query: query, candidates: candidates)
        }

        var allScores: [Double] = []
        allScores.reserveCapacity(candidates.count)

        for batchStart in stride(from: 0, to: candidates.count, by: batchSize) {
            let batchEnd = min(batchStart + batchSize, candidates.count)
            let batch = Array(candidates[batchStart..<batchEnd])
            let batchScores = predictBatch(query: query, candidates: batch, maxLength: maxLength)
            allScores.append(contentsOf: batchScores)
        }

        return allScores
        #else
        return fallbackScoring(query: query, candidates: candidates)
        #endif
    }

    #if canImport(CoreML)
    private func predictBatch(query: String, candidates: [String], maxLength: Int) -> [Double] {
        _ = candidates.map { tokenizer.encodePair(query: query, candidate: $0) }
        _ = maxLength

        // TODO: Implement actual Core ML batch prediction.
        // This requires:
        // 1. Tokenize each (query, candidate) pair.
        // 2. Create MLMultiArray inputs for input_ids, attention_mask, token_type_ids.
        // 3. Run model.prediction().
        // 4. Extract logit from output.

        return fallbackScoring(query: query, candidates: candidates)
    }
    #endif

    /// Fallback scoring using simple term overlap (Jaccard similarity).
    /// Used when Core ML model is not available or not loaded.
    private func fallbackScoring(query: String, candidates: [String]) -> [Double] {
        let queryTerms = Set(query.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { $0.count > 2 })

        return candidates.map { candidate in
            let candidateTerms = Set(candidate.lowercased()
                .components(separatedBy: CharacterSet.alphanumerics.inverted)
                .filter { $0.count > 2 })

            let intersection = queryTerms.intersection(candidateTerms).count
            let union = queryTerms.union(candidateTerms).count
            return union > 0 ? Double(intersection) / Double(union) : 0.0
        }
    }
}
