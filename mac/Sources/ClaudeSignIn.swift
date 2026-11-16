import AppKit
import Observation

/// One run of Claude Code's own sign-in, `claude auth login`, in a config
/// folder. Claude Code opens Claude's sign-in page in the browser and ends once
/// the person has signed in there. When the page shows a code instead, the
/// person pastes it and Claude Code reads it from its input.
@MainActor @Observable final class ClaudeSignIn {
  /// The sign-in page, once Claude Code has said where it is.
  private(set) var page: URL?
  /// What Claude Code said about the last code the person pasted, such as that it was cut short.
  private(set) var answer: String?
  @ObservationIgnored private var entered = false
  @ObservationIgnored private var cancelled = false

  @ObservationIgnored private let process = Process()
  @ObservationIgnored private let input = Pipe()

  /// Starts the sign-in, and returns once it has ended: nil when the person signed in, nothing to say when they cancelled, or why not.
  func run(configDir: String) async -> String? {
    var environment = Server.environment
    environment["CLAUDE_CONFIG_DIR"] = configDir
    process.executableURL = Server.claude
    process.arguments = ["auth", "login"]
    process.environment = environment
    process.standardInput = input
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    var printed = ""
    output.fileHandleForReading.readabilityHandler = { handle in
      let text = String(decoding: handle.availableData, as: UTF8.self)
      Task { @MainActor in
        printed += text
        if self.page == nil, let link = printed.firstMatch(of: #/visit: (https://\S+)/#) { self.page = URL(string: String(link.1)) }
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
    do { try process.run() } catch { return "Sidebots couldn't start Claude Code's sign-in." }
    var status: Int32 = 1
    for await code in ended { status = code }
    output.fileHandleForReading.readabilityHandler = nil
    if status == 0 { return nil }
    if cancelled { return "" }
    // Claude Code says why it failed on its last line, after "Login failed: ".
    let reason = printed.split(separator: "\n").last.map { String($0).replacingOccurrences(of: #"^.*Login failed: "#, with: "", options: .regularExpression) }
    return reason ?? "Claude didn't finish signing in. Try again."
  }

  /// Hands Claude Code the code the sign-in page showed, one line at a time.
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
