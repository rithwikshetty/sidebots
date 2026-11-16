// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "Sidebots",
  platforms: [.macOS(.v14)],
  targets: [.executableTarget(name: "Sidebots", path: "Sources", swiftSettings: [.swiftLanguageMode(.v5)])]
)
