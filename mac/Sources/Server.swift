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
  /// The address phones reach this computer at, once the relay has given it one.
  let address: String?
  /// Whether phones reach the server at its address. Nil until it has one.
  let reachable: Bool?
  /// Whether any agent has a turn queued or running.
  let working: Bool
  let people: [Person]
}

/// A provider's program on this computer, as the server's `providers --json` command finds it.
struct Program: Decodable {
  /// The provider's id, such as `codex`.
  let provider: String
  /// Where the program is. Nil when it isn't installed.
  let path: String?
  let version: String?
  /// Whether the server's driver works with that version.
  let supported: Bool
  /// The oldest version it works with.
  let oldest: String
  /// The command that runs the installer the program's maker publishes.
  let installer: String
  /// The config folder the program uses on this computer.
  let configDir: String

  /// Whether agents can run on it as it is.
  var ready: Bool { path != nil && supported }
}

/// A paired phone, as the server's `devices --json` command lists it.
struct Phone: Decodable, Identifiable {
  let id: String
  let name: String
  let person: String
  /// When it paired, in milliseconds since 1970.
  let pairedAt: Double
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

/// How the person's agents sign in to a provider.
enum SignIn {
  /// The login in the person's config folder for the provider.
  case login
  case apiKey(String)
}

/// The Sidebots server inside the app: Node running `server/src/main.ts`. The
/// app starts it, starts it again when it stops, and learns its state only
/// from the server's own commands.
@MainActor @Observable final class Server {
  private(set) var status: ServerStatus?
  private(set) var phones: [Phone] = []
  /// Each provider's program on this computer. A provider has none until the server has looked.
  private(set) var programs: [Provider: Program] = [:]
  /// Whether the login the person's agents run on is signed in, for each provider. A provider has none until it is known, and for agents on an API key.
  private(set) var signedIn: [Provider: Bool] = [:]

  @ObservationIgnored private var process: Process?
  /// Set once the app is quitting: called when the server has stopped.
  @ObservationIgnored private var quitting: (() -> Void)?
  @ObservationIgnored private var restartDelay = Duration.seconds(1)

  nonisolated private static let resources = Bundle.main.resourceURL!
  nonisolated static let node = resources.appending(path: "bin/node")
  nonisolated static let folder = resources.appending(path: "server")
  /// The server's output, where Console shows it.
  private static let log = FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Logs/Sidebots/server.log")

  /// The person the app sets up, named as the computer knows its user.
  static let personName = NSFullUserName().isEmpty ? NSUserName() : NSFullUserName()

  /// The one person the app looks after: the first on the server.
  var person: ServerStatus.Person? { status?.people.first }

  /// How the person's agents sign in to a provider, once they have set it up.
  func account(_ provider: Provider) -> ServerStatus.Account? { person?.accounts.first { $0.provider == provider.rawValue } }

  /// What the server and its commands run with: the app's own
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

  /// Looks for each provider's program on this computer.
  func findPrograms() async {
    guard let found: [Program] = try? Self.decode(await command(["providers", "--json"])) else { return }
    programs = Dictionary(uniqueKeysWithValues: found.compactMap { program in Provider(rawValue: program.provider).map { ($0, program) } })
  }

  /// Looks for the providers' programs, and at whether the login the person's agents run on is signed in, for each provider they use one with.
  func checkSignIn() async {
    await findPrograms()
    var signedIn: [Provider: Bool] = [:]
    for provider in Provider.allCases {
      if let account = account(provider), account.signIn == "login", programs[provider]?.ready == true {
        signedIn[provider] = await login(provider, configDir: account.configDir)?.loggedIn
      }
    }
    self.signedIn = signedIn
  }

  /// Runs the installer a provider's maker publishes, then looks for its program again.
  func install(_ provider: Provider) async throws {
    try await command(["install", provider.rawValue])
    await findPrograms()
  }

  /// Sets up the person the app looks after on a provider, or changes how their agents sign in to it.
  func setUp(_ provider: Provider, _ signIn: SignIn, configDir: String) async throws {
    let person = self.person
    let name = person?.name ?? Self.personName
    if person == nil {
      try await command(["add-person", name, provider.rawValue, configDir])
    } else if account(provider) == nil {
      try await command(["add-account", name, provider.rawValue, configDir])
    }
    switch signIn {
    case .apiKey(let key):
      // The command takes the key in a file, readable only by this user, which goes once the key is saved.
      let file = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
      guard FileManager.default.createFile(atPath: file.path, contents: Data(key.utf8), attributes: [.posixPermissions: 0o600]) else {
        throw Failed(errorDescription: "Sidebots couldn't save the key.")
      }
      defer { try? FileManager.default.removeItem(at: file) }
      try await command(["api-key", name, provider.rawValue, file.path])
    case .login:
      if account(provider)?.signIn == "api-key" { try await command(["api-key", name, provider.rawValue, "--remove"]) }
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

  /// The login in a provider's config folder, as the provider's program itself reports it. Nil when the program isn't there to ask.
  func login(_ provider: Provider, configDir: String) async -> Login? {
    try? Self.decode(await command(["signed-in", provider.rawValue, configDir, "--json"]))
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

/// The login in a provider's config folder, as the server's `signed-in --json` command reports it: whether it is signed in, and as whom when the provider says.
struct Login: Decodable {
  let loggedIn: Bool
  let email: String?
}
