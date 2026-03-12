import Dispatch
import Foundation
import Darwin

private let sidecarVersion = "0.2.0"
private let supportedSequenceLength = 512

enum RunMode {
	case server(ServerConfig)
	case compile(CompileConfig)
	case validate(ValidateConfig)
}

struct ServerConfig {
	let modelPath: String
	let vocabPath: String
	let authToken: String
	let port: UInt16
	let pluginDataRoot: String
	let portRange: UInt16
}

struct CompileConfig {
	let sourceModelPath: String
	let compiledModelPath: String
}

struct ValidateConfig {
	let compiledModelPath: String
}

struct CommandLineParser {
	static func parse() -> RunMode {
		var modelPath: String?
		var vocabPath: String?
		var authToken: String?
		var pluginDataRoot: String?
		var port: UInt16 = 23516
		var portRange: UInt16 = 5
		var compileMode = false
		var validateMode = false
		var sourceModelPath: String?
		var compiledModelPath: String?

		let args = CommandLine.arguments
		var index = 1
		while index < args.count {
			switch args[index] {
			case "--compile-model":
				compileMode = true
			case "--validate-model":
				validateMode = true
			case "--source-model-path":
				index += 1
				if index < args.count {
					sourceModelPath = args[index]
				}
			case "--compiled-model-path":
				index += 1
				if index < args.count {
					compiledModelPath = args[index]
				}
			case "--model-path":
				index += 1
				if index < args.count {
					modelPath = args[index]
				}
			case "--vocab-path":
				index += 1
				if index < args.count {
					vocabPath = args[index]
				}
			case "--plugin-data-root":
				index += 1
				if index < args.count {
					pluginDataRoot = args[index]
				}
			case "--auth-token":
				index += 1
				if index < args.count {
					authToken = args[index]
				}
			case "--port":
				index += 1
				if index < args.count {
					port = UInt16(args[index]) ?? 23516
				}
			case "--port-range":
				index += 1
				if index < args.count {
					portRange = UInt16(args[index]) ?? 5
				}
			default:
				break
			}
			index += 1
		}

		if compileMode {
			guard let sourceModelPath else {
				fputs("Error: --source-model-path is required with --compile-model\n", stderr)
				exit(1)
			}
			guard let compiledModelPath else {
				fputs("Error: --compiled-model-path is required with --compile-model\n", stderr)
				exit(1)
			}
			return .compile(CompileConfig(sourceModelPath: sourceModelPath, compiledModelPath: compiledModelPath))
		}

		if validateMode {
			guard let compiledModelPath else {
				fputs("Error: --compiled-model-path is required with --validate-model\n", stderr)
				exit(1)
			}
			return .validate(ValidateConfig(compiledModelPath: compiledModelPath))
		}

		guard let modelPath else {
			fputs("Error: --model-path is required\n", stderr)
			exit(1)
		}
		guard let vocabPath else {
			fputs("Error: --vocab-path is required\n", stderr)
			exit(1)
		}
		guard let pluginDataRoot else {
			fputs("Error: --plugin-data-root is required\n", stderr)
			exit(1)
		}
		guard let authToken else {
			fputs("Error: --auth-token is required\n", stderr)
			exit(1)
		}

		return .server(ServerConfig(
			modelPath: modelPath,
			vocabPath: vocabPath,
			authToken: authToken,
			port: port,
			pluginDataRoot: pluginDataRoot,
			portRange: max(portRange, 1)
		))
	}
}

struct RerankRequest: Codable {
	let query: String
	let candidates: [String]
	let max_length: Int?
}

struct RerankResponse: Codable {
	let scores: [Double]
}

struct HealthResponse: Codable {
	let status: String
	let model_loaded: Bool
	let version: String
	let startup_stage: String
	let startup_error: String?
	let model_path: String
	let vocab_path: String
}

struct StatusResponse: Codable {
	let status: String
}

struct ErrorResponse: Codable {
	let error: String
}

struct CompileModeResponse: Codable {
	let status: String
	let mode: String
	let version: String
	let source_model_path: String
	let compiled_model_path: String
	let verified_load: Bool
}

struct ValidateModeResponse: Codable {
	let status: String
	let mode: String
	let version: String
	let compiled_model_path: String
	let verified_load: Bool
}

final class RerankerEngine {
	private let inferenceEngine: CoreMLInferenceEngine
	private let modelPath: String
	private let vocabPath: String

	init(modelPath: String, vocabPath: String) throws {
		self.modelPath = modelPath
		self.vocabPath = vocabPath
		let tokenizer = try WordPieceTokenizer(vocabPath: vocabPath, maxLength: supportedSequenceLength)
		self.inferenceEngine = CoreMLInferenceEngine(tokenizer: tokenizer)
	}

	var isLoaded: Bool {
		inferenceEngine.isLoaded
	}

	func loadModel() throws {
		guard FileManager.default.fileExists(atPath: modelPath) else {
			throw NSError(
				domain: "ZPHReranker",
				code: 1,
				userInfo: [NSLocalizedDescriptionKey: "Compiled model not found at \(modelPath)"]
			)
		}

		try inferenceEngine.loadModel(from: modelPath)
		fputs("Model loaded from \(modelPath) with vocab \(vocabPath)\n", stderr)
	}

	func rerank(query: String, candidates: [String], maxLength: Int = supportedSequenceLength) throws -> [Double] {
		try inferenceEngine.rerank(query: query, candidates: candidates, maxLength: maxLength)
	}
}

final class StartupState {
	private let queue = DispatchQueue(label: "ZPHReranker.StartupState")
	private var startupStage = "initializing"
	private var startupError: String?

	func update(stage: String, error: String? = nil) {
		queue.sync {
			startupStage = stage
			startupError = error
		}
	}

	func makeHealthResponse(modelLoaded: Bool, modelPath: String, vocabPath: String) -> HealthResponse {
		queue.sync {
			HealthResponse(
				status: "ok",
				model_loaded: modelLoaded,
				version: sidecarVersion,
				startup_stage: startupStage,
				startup_error: startupError,
				model_path: modelPath,
				vocab_path: vocabPath
			)
		}
	}
}

final class HTTPServer {
	private let config: ServerConfig
	private let engine: RerankerEngine
	private let startupState: StartupState
	private let encoder = JSONEncoder()
	private let decoder = JSONDecoder()
	private var serverSocket: Int32 = -1
	private var isRunning = false
	private var actualPort: UInt16 = 0

	init(config: ServerConfig, engine: RerankerEngine, startupState: StartupState) {
		self.config = config
		self.engine = engine
		self.startupState = startupState
	}

	func start() throws {
		let socketDescriptor = socket(AF_INET, SOCK_STREAM, 0)
		guard socketDescriptor >= 0 else {
			throw NSError(domain: "ZPHReranker", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to create socket"])
		}

		serverSocket = socketDescriptor

		var reuse: Int32 = 1
		setsockopt(serverSocket, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))

		guard bindToAvailablePort() else {
			close(serverSocket)
			serverSocket = -1
			throw NSError(
				domain: "ZPHReranker",
				code: 3,
				userInfo: [NSLocalizedDescriptionKey: "Failed to bind to ports \(config.port)-\(config.port + config.portRange - 1)"]
			)
		}

		guard listen(serverSocket, 10) == 0 else {
			close(serverSocket)
			serverSocket = -1
			throw NSError(domain: "ZPHReranker", code: 4, userInfo: [NSLocalizedDescriptionKey: "Failed to listen"])
		}

		try writeSidecarInfo()
		isRunning = true
		fputs("ZPH Reranker server listening on 127.0.0.1:\(actualPort)\n", stderr)

		while isRunning {
			let clientSocket = accept(serverSocket, nil, nil)
			if clientSocket < 0 {
				if !isRunning {
					break
				}
				continue
			}

			DispatchQueue.global(qos: .userInitiated).async { [weak self] in
				self?.handleConnection(clientSocket)
			}
		}
	}

	func shutdown() {
		guard isRunning || serverSocket >= 0 else {
			return
		}

		isRunning = false
		if serverSocket >= 0 {
			close(serverSocket)
			serverSocket = -1
		}
		removeSidecarInfo()
		fputs("Server shut down\n", stderr)
		exit(0)
	}

	private func bindToAvailablePort() -> Bool {
		for portOffset: UInt16 in 0..<config.portRange {
			let candidatePort = config.port + portOffset
			var address = sockaddr_in()
			address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
			address.sin_family = sa_family_t(AF_INET)
			address.sin_port = candidatePort.bigEndian
			address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

			let bindResult = withUnsafePointer(to: &address) { pointer in
				pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
					bind(serverSocket, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
				}
			}

			if bindResult == 0 {
				actualPort = candidatePort
				return true
			}
		}

		return false
	}

	private func writeSidecarInfo() throws {
		try FileManager.default.createDirectory(atPath: config.pluginDataRoot, withIntermediateDirectories: true, attributes: nil)
		let payload = ["port": Int(actualPort), "token": config.authToken] as [String: Any]
		let path = (config.pluginDataRoot as NSString).appendingPathComponent("sidecar.json")
		let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
		try data.write(to: URL(fileURLWithPath: path), options: .atomic)
	}

	private func removeSidecarInfo() {
		let path = (config.pluginDataRoot as NSString).appendingPathComponent("sidecar.json")
		try? FileManager.default.removeItem(atPath: path)
	}

	private func handleConnection(_ clientSocket: Int32) {
		defer { close(clientSocket) }
		configureClientSocket(clientSocket)

		guard let request = readRequest(from: clientSocket) else {
			return
		}

		let response = routeRequest(method: request.method, path: request.path, headers: request.headers, body: request.body)
		writeResponse(response, to: clientSocket)
	}

	private func configureClientSocket(_ clientSocket: Int32) {
		var disableSigPipe: Int32 = 1
		let result = setsockopt(clientSocket, SOL_SOCKET, SO_NOSIGPIPE, &disableSigPipe, socklen_t(MemoryLayout<Int32>.size))
		if result == -1 {
			fputs("Warning: Failed to set SO_NOSIGPIPE on client socket: \(String(cString: strerror(errno)))\n", stderr)
		}
	}

	private func readRequest(from clientSocket: Int32) -> (method: String, path: String, headers: [String: String], body: Data)? {
		var data = Data()
		var headerEndRange: Range<Data.Index>?
		var contentLength = 0

		while headerEndRange == nil {
			guard let chunk = readChunk(from: clientSocket), !chunk.isEmpty else {
				return nil
			}
			data.append(chunk)
			headerEndRange = data.range(of: Data("\r\n\r\n".utf8))
			if let range = headerEndRange {
				let headerData = data.subdata(in: 0..<range.lowerBound)
				guard let headerText = String(data: headerData, encoding: .utf8) else {
					return nil
				}
				contentLength = parseContentLength(from: headerText)
			}
		}

		guard let range = headerEndRange else {
			return nil
		}

		let expectedLength = range.upperBound + contentLength
		while data.count < expectedLength {
			guard let chunk = readChunk(from: clientSocket), !chunk.isEmpty else {
				break
			}
			data.append(chunk)
		}

		let headerData = data.subdata(in: 0..<range.lowerBound)
		let bodyData = data.count >= range.upperBound ? data.subdata(in: range.upperBound..<min(expectedLength, data.count)) : Data()

		guard let headerText = String(data: headerData, encoding: .utf8) else {
			return nil
		}

		let headerLines = headerText.components(separatedBy: "\r\n")
		guard let requestLine = headerLines.first else {
			return nil
		}

		let requestParts = requestLine.split(separator: " ", omittingEmptySubsequences: true)
		guard requestParts.count >= 2 else {
			return nil
		}

		var headers: [String: String] = [:]
		for line in headerLines.dropFirst() {
			guard let separatorIndex = line.firstIndex(of: ":") else {
				continue
			}
			let key = String(line[..<separatorIndex]).trimmingCharacters(in: .whitespaces).lowercased()
			let value = String(line[line.index(after: separatorIndex)...]).trimmingCharacters(in: .whitespaces)
			headers[key] = value
		}

		return (String(requestParts[0]), String(requestParts[1]), headers, bodyData)
	}

	private func readChunk(from clientSocket: Int32) -> Data? {
		var buffer = [UInt8](repeating: 0, count: 4096)
		let bytesRead = recv(clientSocket, &buffer, buffer.count, 0)
		guard bytesRead > 0 else {
			return nil
		}
		return Data(buffer.prefix(bytesRead))
	}

	private func parseContentLength(from headerText: String) -> Int {
		for line in headerText.components(separatedBy: "\r\n") {
			guard line.lowercased().hasPrefix("content-length:") else {
				continue
			}
			let rawValue = line.split(separator: ":", maxSplits: 1).last.map(String.init) ?? ""
			return Int(rawValue.trimmingCharacters(in: .whitespaces)) ?? 0
		}
		return 0
	}

	private func routeRequest(method: String, path: String, headers: [String: String], body: Data) -> (statusLine: String, body: Data) {
		if method == "GET" && path == "/health" {
			let response = startupState.makeHealthResponse(modelLoaded: engine.isLoaded, modelPath: config.modelPath, vocabPath: config.vocabPath)
			return encodeResponse(statusLine: "200 OK", payload: response)
		}

		guard isAuthorized(headers: headers) else {
			return encodeResponse(statusLine: "401 Unauthorized", payload: ErrorResponse(error: "Unauthorized"))
		}

		if method == "POST" && path == "/rerank" {
			return handleRerank(body: body)
		}

		if method == "POST" && path == "/shutdown" {
			DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { [weak self] in
				self?.shutdown()
			}
			return encodeResponse(statusLine: "200 OK", payload: StatusResponse(status: "shutting_down"))
		}

		return encodeResponse(statusLine: "404 Not Found", payload: ErrorResponse(error: "Not found"))
	}

	private func isAuthorized(headers: [String: String]) -> Bool {
		(headers["authorization"] ?? "") == "Bearer \(config.authToken)"
	}

	private func handleRerank(body: Data) -> (statusLine: String, body: Data) {
		guard engine.isLoaded else {
			return encodeResponse(statusLine: "503 Service Unavailable", payload: ErrorResponse(error: "Model is not loaded"))
		}
		guard !body.isEmpty else {
			return encodeResponse(statusLine: "400 Bad Request", payload: ErrorResponse(error: "Missing request body"))
		}

		do {
			let request = try decoder.decode(RerankRequest.self, from: body)
			if let requestedMaxLength = request.max_length, requestedMaxLength != supportedSequenceLength {
				return encodeResponse(
					statusLine: "400 Bad Request",
					payload: ErrorResponse(error: "Unsupported max_length \(requestedMaxLength); only \(supportedSequenceLength) is supported")
				)
			}

			let scores = try engine.rerank(
				query: request.query,
				candidates: request.candidates,
				maxLength: request.max_length ?? supportedSequenceLength
			)
			return encodeResponse(statusLine: "200 OK", payload: RerankResponse(scores: scores))
		} catch {
			return encodeResponse(statusLine: "400 Bad Request", payload: ErrorResponse(error: "Invalid request: \(error.localizedDescription)"))
		}
	}

	private func encodeResponse<T: Encodable>(statusLine: String, payload: T) -> (statusLine: String, body: Data) {
		do {
			return (statusLine, try encoder.encode(payload))
		} catch {
			return ("500 Internal Server Error", Data("{\"error\":\"Encoding failure\"}".utf8))
		}
	}

	private func writeResponse(_ response: (statusLine: String, body: Data), to clientSocket: Int32) {
		let header = "HTTP/1.1 \(response.statusLine)\r\nContent-Type: application/json\r\nContent-Length: \(response.body.count)\r\nConnection: close\r\n\r\n"
		guard let headerData = header.data(using: .utf8) else {
			return
		}

		var responseData = Data()
		responseData.append(headerData)
		responseData.append(response.body)

		responseData.withUnsafeBytes { rawBuffer in
			guard let baseAddress = rawBuffer.baseAddress else {
				return
			}

			var bytesSent = 0
			while bytesSent < responseData.count {
				let remainingBytes = responseData.count - bytesSent
				let sendResult = send(clientSocket, baseAddress.advanced(by: bytesSent), remainingBytes, 0)
				if sendResult > 0 {
					bytesSent += sendResult
					continue
				}
				if sendResult == 0 {
					return
				}

				let errorCode = errno
				if errorCode == EPIPE || errorCode == ECONNRESET || errorCode == ENOTCONN {
					return
				}
				fputs("Warning: Failed to write response: \(String(cString: strerror(errorCode)))\n", stderr)
				return
			}
		}
	}
}

private func ensureSupportedPlatform() {
	#if arch(arm64)
	return
	#else
	fputs("Error: ZPHReranker is supported on Apple Silicon only\n", stderr)
	exit(1)
	#endif
}

private func installSignalHandlers(server: HTTPServer) -> [DispatchSourceSignal] {
	signal(SIGINT, SIG_IGN)
	signal(SIGTERM, SIG_IGN)

	let queue = DispatchQueue.global(qos: .utility)
	return [SIGINT, SIGTERM].map { signalValue in
		let source = DispatchSource.makeSignalSource(signal: signalValue, queue: queue)
		source.setEventHandler { [weak server] in
			server?.shutdown()
		}
		source.resume()
		return source
	}
}

private func runCompileMode(_ config: CompileConfig) {
	do {
		let compiledPath = try compileModelPackage(sourceModelPath: config.sourceModelPath, compiledModelPath: config.compiledModelPath)
		try smokeLoadCompiledModel(at: compiledPath)

		let payload = CompileModeResponse(
			status: "ok",
			mode: "compile",
			version: sidecarVersion,
			source_model_path: config.sourceModelPath,
			compiled_model_path: compiledPath,
			verified_load: true
		)
		let encoder = JSONEncoder()
		encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
		let data = try encoder.encode(payload)
		FileHandle.standardOutput.write(data)
		FileHandle.standardOutput.write(Data("\n".utf8))
		exit(0)
	} catch {
		fputs("Compile mode failed: \(error.localizedDescription)\n", stderr)
		exit(1)
	}
}

private func runValidateMode(_ config: ValidateConfig) {
	do {
		try smokeLoadCompiledModel(at: config.compiledModelPath)

		let payload = ValidateModeResponse(
			status: "ok",
			mode: "validate",
			version: sidecarVersion,
			compiled_model_path: config.compiledModelPath,
			verified_load: true
		)
		let encoder = JSONEncoder()
		encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
		let data = try encoder.encode(payload)
		FileHandle.standardOutput.write(data)
		FileHandle.standardOutput.write(Data("\n".utf8))
		exit(0)
	} catch {
		fputs("Validate mode failed: \(error.localizedDescription)\n", stderr)
		exit(1)
	}
}

private func runServerMode(_ config: ServerConfig) {
	let startupState = StartupState()
	let engine: RerankerEngine

	do {
		engine = try RerankerEngine(modelPath: config.modelPath, vocabPath: config.vocabPath)
		startupState.update(stage: "tokenizer_ready")
	} catch {
		fputs("Failed to initialize tokenizer: \(error.localizedDescription)\n", stderr)
		exit(1)
	}

	startupState.update(stage: "loading_model")

	do {
		try engine.loadModel()
		startupState.update(stage: "ready")
	} catch {
		let startupError = "Failed to load compiled model at \(config.modelPath): \(error.localizedDescription)"
		startupState.update(stage: "load_model_failed", error: startupError)
		fputs("Model load failed at \(config.modelPath): \(error.localizedDescription)\n", stderr)
		fputs("Server will stay running so the plugin can read startup diagnostics\n", stderr)
	}

	let server = HTTPServer(config: config, engine: engine, startupState: startupState)
	let signalSources = installSignalHandlers(server: server)
	_ = signalSources

	do {
		try server.start()
	} catch {
		fputs("Failed to start server: \(error.localizedDescription)\n", stderr)
		exit(1)
	}
}

ensureSupportedPlatform()

switch CommandLineParser.parse() {
case .compile(let config):
	runCompileMode(config)
case .validate(let config):
	runValidateMode(config)
case .server(let config):
	runServerMode(config)
}
