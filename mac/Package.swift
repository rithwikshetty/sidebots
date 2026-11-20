// swift-tools-version:6.2
import PackageDescription

let package = Package(
  name: "Sidebots",
  // macOS sizes the menu bar panel to its content for an app stamped as built with the macOS 26 SDK or later, and `swift build` stamps this minimum as that SDK.
  platforms: [.macOS(.v26)],
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
