// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "Sidebots",
  platforms: [.macOS(.v14)],
  dependencies: [.package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.1")],
  targets: [
    .executableTarget(
      name: "Sidebots",
      dependencies: [.product(name: "Sparkle", package: "Sparkle")],
      path: "Sources",
      swiftSettings: [.swiftLanguageMode(.v5)],
      // The app carries Sparkle in Contents/Frameworks.
      linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
    )
  ]
)
