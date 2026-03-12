import Foundation
#if canImport(CoreML)
import CoreML
#endif

enum CoreMLInferenceError: Error {
	case modelUnavailable
	case unsupportedModelInterface(String)
	case missingOutput
	case invalidCompiledModelPath(String)
}

func compileModelPackage(sourceModelPath: String, compiledModelPath: String) throws -> String {
	#if canImport(CoreML)
	let fileManager = FileManager.default
	let sourceURL = URL(fileURLWithPath: sourceModelPath)
	let destinationURL = URL(fileURLWithPath: compiledModelPath)
	let destinationParentURL = destinationURL.deletingLastPathComponent()

	guard fileManager.fileExists(atPath: sourceModelPath) else {
		throw NSError(domain: "ZPHReranker", code: 20, userInfo: [NSLocalizedDescriptionKey: "Source model not found at \(sourceModelPath)"])
	}

	try fileManager.createDirectory(at: destinationParentURL, withIntermediateDirectories: true, attributes: nil)
	if fileManager.fileExists(atPath: compiledModelPath) {
		try fileManager.removeItem(at: destinationURL)
	}

	let compiledTemporaryURL = try MLModel.compileModel(at: sourceURL)
	try fileManager.copyItem(at: compiledTemporaryURL, to: destinationURL)
	return destinationURL.path
	#else
	throw NSError(domain: "ZPHReranker", code: 21, userInfo: [NSLocalizedDescriptionKey: "CoreML not available"])
	#endif
}

func smokeLoadCompiledModel(at path: String) throws {
	#if canImport(CoreML)
	let url = URL(fileURLWithPath: path)
	let configuration = MLModelConfiguration()
	configuration.computeUnits = .all
	_ = try MLModel(contentsOf: url, configuration: configuration)
	#else
	throw NSError(domain: "ZPHReranker", code: 22, userInfo: [NSLocalizedDescriptionKey: "CoreML not available"])
	#endif
}

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
		guard path.hasSuffix(".mlmodelc") else {
			throw CoreMLInferenceError.invalidCompiledModelPath("Runtime model path must point to a compiled .mlmodelc bundle: \(path)")
		}

		let url = URL(fileURLWithPath: path)
		let configuration = MLModelConfiguration()
		configuration.computeUnits = .all
		model = try MLModel(contentsOf: url, configuration: configuration)
		#else
		throw NSError(domain: "ZPHReranker", code: 10, userInfo: [NSLocalizedDescriptionKey: "CoreML not available"])
		#endif
	}

	func rerank(query: String, candidates: [String], maxLength: Int = 512) throws -> [Double] {
		guard !candidates.isEmpty else {
			return []
		}

		#if canImport(CoreML)
		guard model != nil else {
			throw CoreMLInferenceError.modelUnavailable
		}

		var allScores: [Double] = []
		allScores.reserveCapacity(candidates.count)

		for batchStart in stride(from: 0, to: candidates.count, by: batchSize) {
			let batchEnd = min(batchStart + batchSize, candidates.count)
			let batch = Array(candidates[batchStart..<batchEnd])
			let batchScores = try predictBatch(query: query, candidates: batch, maxLength: maxLength)
			allScores.append(contentsOf: batchScores)
		}

		return allScores
		#else
		throw CoreMLInferenceError.modelUnavailable
		#endif
	}

	#if canImport(CoreML)
	private func predictBatch(query: String, candidates: [String], maxLength: Int) throws -> [Double] {
		guard let loadedModel = model else {
			throw CoreMLInferenceError.modelUnavailable
		}

		return try candidates.map { candidate in
			let encoded = tokenizer.encodePair(query: query, candidate: candidate)
			let provider = try makeFeatureProvider(for: encoded, maxLength: maxLength)
			let prediction = try loadedModel.prediction(from: provider)
			return try extractLogit(from: prediction)
		}
	}

	private func makeFeatureProvider(
		for encoded: (inputIds: [Int], attentionMask: [Int], tokenTypeIds: [Int]),
		maxLength: Int
	) throws -> MLFeatureProvider {
		guard encoded.inputIds.count == maxLength,
				encoded.attentionMask.count == maxLength,
				encoded.tokenTypeIds.count == maxLength else {
			throw CoreMLInferenceError.unsupportedModelInterface("Tokenizer produced a sequence length that does not match maxLength=\(maxLength)")
		}

		let inputIds = try makeInt32Array(encoded.inputIds)
		let attentionMask = try makeInt32Array(encoded.attentionMask)
		let tokenTypeIds = try makeInt32Array(encoded.tokenTypeIds)
		return try MLDictionaryFeatureProvider(dictionary: [
			"input_ids": MLFeatureValue(multiArray: inputIds),
			"attention_mask": MLFeatureValue(multiArray: attentionMask),
			"token_type_ids": MLFeatureValue(multiArray: tokenTypeIds),
		])
	}

	private func makeInt32Array(_ values: [Int]) throws -> MLMultiArray {
		let multiArray = try MLMultiArray(shape: [1, NSNumber(value: values.count)], dataType: .int32)
		for (index, value) in values.enumerated() {
			multiArray[index] = NSNumber(value: value)
		}
		return multiArray
	}

	private func extractLogit(from prediction: MLFeatureProvider) throws -> Double {
		for preferredName in ["logits", "scores", "output", "Identity"] {
			if let featureValue = prediction.featureValue(for: preferredName), let score = numericValue(from: featureValue) {
				return score
			}
		}

		for featureName in prediction.featureNames.sorted() {
			if let featureValue = prediction.featureValue(for: featureName), let score = numericValue(from: featureValue) {
				return score
			}
		}

		throw CoreMLInferenceError.missingOutput
	}

	private func numericValue(from featureValue: MLFeatureValue) -> Double? {
		if featureValue.type == .double {
			return featureValue.doubleValue
		}
		if featureValue.type == .int64 {
			return Double(featureValue.int64Value)
		}

		guard featureValue.type == .multiArray, let multiArray = featureValue.multiArrayValue, multiArray.count > 0 else {
			return nil
		}

		switch multiArray.dataType {
		case .double, .float32, .float16, .int8, .int32:
			return multiArray[0].doubleValue
		@unknown default:
			return multiArray[0].doubleValue
		}
	}
	#endif
}
