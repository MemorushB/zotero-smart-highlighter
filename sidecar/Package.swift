// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ZPHReranker",
    platforms: [.macOS(.v13)],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "ZPHReranker",
            dependencies: [],
            path: "Sources/ZPHReranker"
        ),
    ]
)
