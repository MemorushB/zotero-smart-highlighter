import Dispatch
import Foundation
import Darwin

// MARK: - Configuration

struct ServerConfig {
    let modelPath: String
    let authToken: String
    let port: UInt16
    let dataDir: String

    static func fromCommandLine() -> ServerConfig {
        var modelPath: String?
        var authToken: String?
        var port: UInt16 = 23516

        let args = CommandLine.arguments
        var index = 1
        while index < args.count {
            let argument = args[index]
            switch argument {
            case "--model-path":
                index += 1
                if index < args.count {
                    modelPath = args[index]
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
            default:
                break
            }
            index += 1
        }

        guard let parsedModelPath = modelPath else {
            fputs("Error: --model-path is required\n", stderr)
            exit(1)
        }

        guard let parsedAuthToken = authToken else {
            fputs("Error: --auth-token is required\n", stderr)
            exit(1)
        }

        let dataDir = (parsedModelPath as NSString).deletingLastPathComponent
        return ServerConfig(
            modelPath: parsedModelPath,
            authToken: parsedAuthToken,
            port: port,
            dataDir: dataDir
        )
    }
}

// MARK: - Request / Response Types

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
}

struct StatusResponse: Codable {
    let status: String
}

struct ErrorResponse: Codable {
    let error: String
}

// MARK: - Reranker Engine

final class RerankerEngine {
    private let inferenceEngine: CoreMLInferenceEngine
    private let modelPath: String

    init(modelPath: String) {
        self.modelPath = modelPath

        let vocabPath = ((modelPath as NSString).deletingLastPathComponent as NSString)
            .appendingPathComponent("vocab.txt")
        let tokenizer = WordPieceTokenizer(
            vocabPath: FileManager.default.fileExists(atPath: vocabPath) ? vocabPath : nil,
            maxLength: 512
        )
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
                userInfo: [NSLocalizedDescriptionKey: "Model not found at \(modelPath)"]
            )
        }

        try inferenceEngine.loadModel(from: modelPath)
        fputs("Model loaded from \(modelPath)\n", stderr)
    }

    func rerank(query: String, candidates: [String], maxLength: Int = 512) -> [Double] {
        inferenceEngine.rerank(query: query, candidates: candidates, maxLength: maxLength)
    }
}

// MARK: - HTTP Server

final class HTTPServer {
    private let config: ServerConfig
    private let engine: RerankerEngine
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var serverSocket: Int32 = -1
    private var isRunning = false
    private var actualPort: UInt16 = 0

    init(config: ServerConfig, engine: RerankerEngine) {
        self.config = config
        self.engine = engine
    }

    func start() throws {
        let socketDescriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard socketDescriptor >= 0 else {
            throw NSError(
                domain: "ZPHReranker",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Failed to create socket"]
            )
        }

        serverSocket = socketDescriptor

        var reuse: Int32 = 1
        setsockopt(
            serverSocket,
            SOL_SOCKET,
            SO_REUSEADDR,
            &reuse,
            socklen_t(MemoryLayout<Int32>.size)
        )

        guard bindToAvailablePort() else {
            close(serverSocket)
            serverSocket = -1
            throw NSError(
                domain: "ZPHReranker",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Failed to bind to ports \(config.port)-\(config.port + 4)"]
            )
        }

        guard listen(serverSocket, 10) == 0 else {
            close(serverSocket)
            serverSocket = -1
            throw NSError(
                domain: "ZPHReranker",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "Failed to listen"]
            )
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
        for portOffset: UInt16 in 0..<5 {
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
        let payload = ["port": Int(actualPort), "token": config.authToken] as [String: Any]
        let path = (config.dataDir as NSString).appendingPathComponent("sidecar.json")
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        fputs("Sidecar info written to \(path)\n", stderr)
    }

    private func removeSidecarInfo() {
        let path = (config.dataDir as NSString).appendingPathComponent("sidecar.json")
        try? FileManager.default.removeItem(atPath: path)
    }

    private func handleConnection(_ clientSocket: Int32) {
        defer { close(clientSocket) }

        guard let request = readRequest(from: clientSocket) else {
            return
        }

        let response = routeRequest(
            method: request.method,
            path: request.path,
            headers: request.headers,
            body: request.body
        )
        writeResponse(response, to: clientSocket)
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

        return (
            method: String(requestParts[0]),
            path: String(requestParts[1]),
            headers: headers,
            body: bodyData
        )
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
            let lowercased = line.lowercased()
            guard lowercased.hasPrefix("content-length:") else {
                continue
            }
            let rawValue = line.split(separator: ":", maxSplits: 1).last.map(String.init) ?? ""
            return Int(rawValue.trimmingCharacters(in: .whitespaces)) ?? 0
        }
        return 0
    }

    private func routeRequest(method: String, path: String, headers: [String: String], body: Data) -> (statusLine: String, body: Data) {
        if method == "GET" && path == "/health" {
            let response = HealthResponse(status: "ok", model_loaded: engine.isLoaded, version: "0.1.0")
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
        let authorizationHeader = headers["authorization"] ?? ""
        return authorizationHeader == "Bearer \(config.authToken)"
    }

    private func handleRerank(body: Data) -> (statusLine: String, body: Data) {
        guard !body.isEmpty else {
            return encodeResponse(statusLine: "400 Bad Request", payload: ErrorResponse(error: "Missing request body"))
        }

        do {
            let request = try decoder.decode(RerankRequest.self, from: body)
            let scores = engine.rerank(
                query: request.query,
                candidates: request.candidates,
                maxLength: request.max_length ?? 512
            )
            return encodeResponse(statusLine: "200 OK", payload: RerankResponse(scores: scores))
        } catch {
            return encodeResponse(
                statusLine: "400 Bad Request",
                payload: ErrorResponse(error: "Invalid request: \(error.localizedDescription)")
            )
        }
    }

    private func encodeResponse<T: Encodable>(statusLine: String, payload: T) -> (statusLine: String, body: Data) {
        do {
            return (statusLine, try encoder.encode(payload))
        } catch {
            let fallback = Data("{\"error\":\"Encoding failure\"}".utf8)
            return ("500 Internal Server Error", fallback)
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
            _ = send(clientSocket, baseAddress, responseData.count, 0)
        }
    }
}

// MARK: - Runtime Guards

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
    let sources = [SIGINT, SIGTERM].map { signalValue -> DispatchSourceSignal in
        let source = DispatchSource.makeSignalSource(signal: signalValue, queue: queue)
        source.setEventHandler { [weak server] in
            server?.shutdown()
        }
        source.resume()
        return source
    }

    return sources
}

// MARK: - Main

ensureSupportedPlatform()

let config = ServerConfig.fromCommandLine()
let engine = RerankerEngine(modelPath: config.modelPath)

do {
    try engine.loadModel()
} catch {
    fputs("Warning: Could not load model: \(error.localizedDescription)\n", stderr)
    fputs("Server will start but reranking will use fallback scoring\n", stderr)
}

let server = HTTPServer(config: config, engine: engine)
let signalSources = installSignalHandlers(server: server)
_ = signalSources

do {
    try server.start()
} catch {
    fputs("Failed to start server: \(error.localizedDescription)\n", stderr)
    exit(1)
}
