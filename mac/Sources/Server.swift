import AppKit
import Observation

/// What the server's `status --json` command says.
struct ServerStatus: Decodable {
  struct Person: Decodable {
    let name: String
    let accounts: [Account]
  }

  /// How a person's agents sign in to a provider.
  struct Account: Decodable {
    /// The provider's id, such as `claude`.
    let provider: String
    /// The provider's name, such as Claude Code.
    let name: String
    let configDir: String
    /// `login` for the login in the person's config folder, or `api-key`.
    let signIn: String
  }

  let running: Bool
  /// The address phones reach this Mac at, once the relay has given it one.
  let address: String?
  /// Whether phones reach the server at its address. Nil until it has one.
  let reachable: Bool?
  /// Whether any agent has a turn queued or running.
  let working: Bool
  let people: [Person]
}

/// A paired phone, as the server's `devices --json` command lists it.
struct Phone: Decodable, Identifiable {
  let id: String
  let name: String
  let person: String
}

/// A pairing code, as the server's `pair --json` command makes it.
struct Pairing: Decodable {
  let link: String
  let expiresAt: Double
}

/// What a program printed when it failed.
struct Failed: LocalizedError {
  let errorDescription: String?
}

/// How the person's agents sign in to Claude Code.
enum SignIn {
  /// The Claude login in the person's Claude Code config folder.
  case login
  case apiKey(String)
}

/// The Sidebots server inside the app: Node running `server/src/main.ts`. The
/// app starts it, starts it again when it stops, and learns its state only
/// from the server's own commands.
@MainActor @Observable final class Server {
  private(set) var status: ServerStatus?
  private(set) var phones: [Phone] = []
  /// Whether the Claude login the person's agents run on is signed in. Nil until known, and for agents on an API key.
  private(set) var signedIn: Bool?

  @ObservationIgnored private var process: Process?
  /// Set once the app is quitting: called when the server has stopped.
  @ObservationIgnored private var quitting: (() -> Void)?
  @ObservationIgnored private var restartDelay = Duration.seconds(1)

  nonisolated private static let resources = Bundle.main.resourceURL!
  nonisolated private static let node = resources.appending(path: "bin/node")
  nonisolated private static let folder = resources.appending(path: "server")
  /// The Claude Code program the Agent SDK ships, which the agents run on.
  nonisolated static let claude = folder.appending(path: "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude")
  /// The server's output, where Console shows it.
  private static let log = FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Logs/Sidebots/server.log")

  /// The person the app sets up, named as the Mac knows its user.
  static let personName = NSFullUserName().isEmpty ? NSUserName() : NSFullUserName()

  /// The provider the app sets the person's agents up on: Claude Code, which the app carries.
  static let provider = "claude"

  /// The one person the app looks after: the first on the server.
  var person: ServerStatus.Person? { status?.people.first }

  /// How the person's agents sign in to Claude Code.
  var account: ServerStatus.Account? { person?.accounts.first { $0.provider == Self.provider } }

  /// What the server, its commands and Claude Code run with: the app's own
  /// environment, so that `SIDEBOTS_HOME`, `PORT` and `SIDEBOTS_RELAY` pass
  /// through, with the bundled Node first on the PATH and the bundled
  /// cloudflared for the tunnel.
  nonisolated static var environment: [String: String] {
    var environment = ProcessInfo.processInfo.environment
    environment["PATH"] = node.deletingLastPathComponent().path + ":" + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
    environment["SIDEBOTS_CLOUDFLARED"] = resources.appending(path: "bin/cloudflared").path
    return environment
  }

  func start() {
    let process = Process()
    process.executableURL = Self.node
    process.arguments = ["src/main.ts"]
    process.currentDirectoryURL = Self.folder
    process.environment = Self.environment
    try? FileManager.default.createDirectory(at: Self.log.deletingLastPathComponent(), withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: Self.log.path) { FileManager.default.createFile(atPath: Self.log.path, contents: nil) }
    if let log = try? FileHandle(forWritingTo: Self.log) {
      log.seekToEndOfFile()
      process.standardOutput = log
      process.standardError = log
    }
    let started = ContinuousClock.now
    process.terminationHandler = { [weak self] _ in
      Task { @MainActor in self?.stopped(after: ContinuousClock.now - started) }
    }
    do {
      try process.run()
      self.process = process
    } catch {
      stopped(after: .zero)
    }
  }

  /// Starts the server again after it stops. One that keeps stopping straight away waits longer each time, up to a minute.
  private func stopped(after uptime: Duration) {
    process = nil
    if let quitting { return quitting() }
    restartDelay = uptime > .seconds(30) ? .seconds(1) : min(restartDelay * 2, .seconds(60))
    Task {
      try? await Task.sleep(for: restartDelay)
      if quitting == nil { start() }
    }
  }

  /// Stops the server as the app quits, and calls `done` once it has stopped.
  func stop(then done: @escaping () -> Void) {
    quitting = done
    guard let process else { return done() }
    process.terminate()
  }

  /// Reads the server's state and the paired phones.
  func refresh() async {
    status = try? Self.decode(await command(["status", "--json"]))
    if let phones: [Phone] = try? Self.decode(await command(["devices", "--json"])) { self.phones = phones }
  }

  /// Looks at whether the Claude login the person's agents run on is signed in.
  func checkSignIn() async {
    if let account, account.signIn == "login" {
      signedIn = await Self.claudeAccount(configDir: account.configDir)?.loggedIn
    } else {
      signedIn = nil
    }
  }

  /// Sets up the person the app looks after, or changes how their agents sign in.
  func setUp(_ signIn: SignIn, configDir: String) async throws {
    let person = self.person
    if person == nil { try await command(["add-person", Self.personName, Self.provider, configDir]) }
    let name = person?.name ?? Self.personName
    switch signIn {
    case .apiKey(let key):
      // The command takes the key in a file, readable only by this user, which goes once the key is saved.
      let file = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
      guard FileManager.default.createFile(atPath: file.path, contents: Data(key.utf8), attributes: [.posixPermissions: 0o600]) else {
        throw Failed(errorDescription: "Sidebots couldn't save the key.")
      }
      defer { try? FileManager.default.removeItem(at: file) }
      try await command(["api-key", name, Self.provider, file.path])
    case .login:
      if account?.signIn == "api-key" { try await command(["api-key", name, Self.provider, "--remove"]) }
    }
    await refresh()
    await checkSignIn()
  }

  /// Makes a code that pairs one phone with the person the app looks after.
  func pair() async throws -> Pairing {
    guard let person else { throw Failed(errorDescription: "Set up Sidebots first.") }
    return try Self.decode(await command(["pair", person.name, "--json"]))
  }

  func remove(_ phone: Phone) async throws {
    try await command(["remove-device", phone.id])
    await refresh()
  }

  /// Runs one of the server's commands and returns what it printed.
  @discardableResult func command(_ arguments: [String]) async throws -> Data {
    let (status, output, error) = await Self.run(Self.node, ["src/main.ts"] + arguments, in: Self.folder)
    guard status == 0 else { throw Failed(errorDescription: error.isEmpty ? "Sidebots couldn't do that." : error) }
    return output
  }

  /// The Claude login in a Claude Code config folder, as Claude Code itself reports it.
  static func claudeAccount(configDir: String) async -> ClaudeAccount? {
    var environment = environment
    environment["CLAUDE_CONFIG_DIR"] = configDir
    let (_, output, _) = await run(claude, ["auth", "status", "--json"], environment: environment)
    return try? decode(output)
  }

  /// Runs a program to its end and returns its exit status, what it printed, and what it printed as errors.
  nonisolated static func run(_ program: URL, _ arguments: [String], in folder: URL? = nil, environment: [String: String] = environment) async
    -> (Int32, Data, String)
  {
    await Task.detached {
      let process = Process()
      process.executableURL = program
      process.arguments = arguments
      process.currentDirectoryURL = folder
      process.environment = environment
      let output = Pipe()
      let errors = Pipe()
      process.standardOutput = output
      process.standardError = errors
      do { try process.run() } catch { return (-1, Data(), error.localizedDescription) }
      let printed = output.fileHandleForReading.readDataToEndOfFile()
      let failed = errors.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      return (process.terminationStatus, printed, String(decoding: failed, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
    }.value
  }

  nonisolated static func decode<T: Decodable>(_ data: Data) throws -> T {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try decoder.decode(T.self, from: data)
  }
}

/// What `claude auth status --json` says about a Claude Code config folder.
struct ClaudeAccount: Decodable {
  let loggedIn: Bool
  let email: String?
}
