import AppKit
import Observation

/// One run of a provider's own sign-in in a config folder, through the
/// server's `sign-in` command, which finds the provider's program and runs
/// the sign-in with this run's input and output. The program opens its
/// sign-in page in the browser and ends once the person has signed in there.
/// When Claude's page shows a code instead, the person pastes it and Claude
/// Code reads it from its input.
@MainActor @Observable final class BrowserSignIn {
  let provider: Provider
  /// The sign-in page, once the program has said where it is.
  private(set) var page: URL?
  /// What the program said about the last code the person pasted, such as that it was cut short.
  private(set) var answer: String?
  @ObservationIgnored private var entered = false
  @ObservationIgnored private var cancelled = false

  @ObservationIgnored private let process = Process()
  @ObservationIgnored private let input = Pipe()

  init(_ provider: Provider) {
    self.provider = provider
  }

  /// Starts the sign-in, and returns once it has ended: nil when the person signed in, nothing to say when they cancelled, or why not.
  func run(configDir: String) async -> String? {
    process.executableURL = Server.node
    process.arguments = ["src/main.ts", "sign-in", provider.rawValue, configDir]
    process.currentDirectoryURL = Server.folder
    process.environment = Server.environment
    process.standardInput = input
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    let pageFollows = provider.pageFollows
    var printed = ""
    output.fileHandleForReading.readabilityHandler = { handle in
      let text = String(decoding: handle.availableData, as: UTF8.self)
      Task { @MainActor in
        printed += text
        if self.page == nil, let at = printed.range(of: pageFollows), let link = printed[at.upperBound...].firstMatch(of: #/^\s*(https://\S+)/#) {
          self.page = URL(string: String(link.1))
        }
        // Claude Code asks for a code again after one it can't read, after its prompt.
        if self.entered, let line = text.split(separator: "\n").last {
          self.answer = line.replacingOccurrences(of: #"^.*> "#, with: "", options: .regularExpression)
        }
      }
    }
    let ended = AsyncStream<Int32> { continuation in
      process.terminationHandler = { process in
        continuation.yield(process.terminationStatus)
        continuation.finish()
      }
    }
    do { try process.run() } catch { return "Sidebots couldn't start \(provider.name)'s sign-in." }
    var status: Int32 = 1
    for await code in ended { status = code }
    output.fileHandleForReading.readabilityHandler = nil
    if status == 0 { return nil }
    if cancelled { return "" }
    // The program says why it failed on its last line, which Claude Code starts with "Login failed: ".
    let reason = printed.split(separator: "\n").last.map { String($0).replacingOccurrences(of: #"^.*Login failed: "#, with: "", options: .regularExpression) }
    return reason ?? "\(provider.account) didn't finish signing in. Try again."
  }

  /// Hands the program the code the sign-in page showed, one line at a time.
  func enter(code: String) {
    entered = true
    answer = nil
    input.fileHandleForWriting.write(Data((code.trimmingCharacters(in: .whitespacesAndNewlines) + "\n").utf8))
  }

  func cancel() {
    cancelled = true
    if process.isRunning { process.terminate() }
  }
}
