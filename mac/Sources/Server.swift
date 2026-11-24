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
  /// Whether the server tells the relay how much it is used.
  let counting: Bool
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

/// A paired device, as the server's `devices --json` command lists it.
struct Phone: Decodable, Identifiable {
  let id: String
  let name: String
  let person: String
  /// When it paired, in milliseconds since 1970.
  let pairedAt: Double
  /// `phone`, or `desktop` for the desktop app.
  let kind: String
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
/// from the server's own commands. The server ends when the app does, even
/// an app that ends without stopping it.
@MainActor @Observable final class Server {
  private(set) var status: ServerStatus?
  /// Whether the server's `status` command failed when it was last run, as when the server can't open its data. Nothing is known of the person or the server while it does.
  private(set) var failed = false
  private(set) var phones: [Phone] = []
  /// Whether the server tells the relay how much it is used, which it does unless the person turned that off. It is kept apart from `status`, so the switch stays where the person put it while the server saves it.
  private(set) var counting = true
  /// Whether the server is saving that, which the switch waits for before it takes another click.
  private(set) var savingCounting = false
  /// How many times the server has saved it.
  @ObservationIgnored private var countingSaves = 0
  /// Each provider's program on this computer. A provider has none until the server has looked.
  private(set) var programs: [Provider: Program] = [:]
  /// The login the person's agents run on, for each provider. A provider has none until it is known, and for agents on an API key the person gave Sidebots.
  private(set) var logins: [Provider: Login] = [:]

  @ObservationIgnored private var process: Process?
  /// Set once the app is quitting: called when the server has stopped.
  @ObservationIgnored private var quitting: (() -> Void)?
  @ObservationIgnored private var restartDelay = Duration.seconds(1)

  nonisolated private static let resources = Bundle.main.resourceURL!
  nonisolated static let node = resources.appending(path: "bin/node")
  nonisolated static let folder = resources.appending(path: "server")
  /// The app's name, which a dev build has apart from the published app's.
  nonisolated static let name = Bundle.main.infoDictionary?["CFBundleName"] as? String ?? "Sidebots"
  /// The server's output, where Console shows it, in a folder named for the app.
  private static let log = FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Logs/\(name)/server.log")

  /// The person the app sets up, named as the computer knows its user.
  static let personName = NSFullUserName().isEmpty ? NSUserName() : NSFullUserName()

  /// The one person the app looks after: the first on the server.
  var person: ServerStatus.Person? { status?.people.first }

  /// How the person's agents sign in to a provider, once they have set it up.
  func account(_ provider: Provider) -> ServerStatus.Account? { person?.accounts.first { $0.provider == provider.rawValue } }

  /// Whether the provider's maker bills an API key for what the person's agents use: one the person gave Sidebots, or one saved as the login the agents run on.
  func billsKey(_ provider: Provider) -> Bool { account(provider)?.signIn == "api-key" || logins[provider]?.apiKey == true }

  /// What the server and its commands run with: the app's own
  /// environment, so that `SIDEBOTS_HOME`, `PORT` and `SIDEBOTS_RELAY` pass
  /// through, with the bundled Node first on the PATH, the bundled
  /// cloudflared for the tunnel, and the app's version. What the app's
  /// Info.plist sets under `LSEnvironment`, as a dev build's does for its
  /// data folder and port, holds however the app was started, unless the
  /// app's own environment says otherwise.
  nonisolated static var environment: [String: String] {
    let built = Bundle.main.infoDictionary?["LSEnvironment"] as? [String: String] ?? [:]
    var environment = built.merging(ProcessInfo.processInfo.environment) { _, given in given }
    environment["PATH"] = node.deletingLastPathComponent().path + ":" + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
    environment["SIDEBOTS_CLOUDFLARED"] = resources.appending(path: "bin/cloudflared").path
    environment["SIDEBOTS_VERSION"] = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    return environment
  }

  func start() {
    let process = Process()
    process.executableURL = Self.node
    // The server's input is a pipe the app holds open, which closes when the app ends however it ends, and the server ends with it.
    process.arguments = ["src/main.ts", "--with-parent"]
    process.standardInput = Pipe()
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

  /// Reads the server's state and the paired phones, which leave out the desktop app.
  func refresh() async {
    let saves = countingSaves
    status = try? Self.decode(await command(["status", "--json"]))
    failed = status == nil
    // What the server said while it was saving the switch, or since before it last did, may be from before it saved.
    if let status, !savingCounting, saves == countingSaves { counting = status.counting }
    if let devices: [Phone] = try? Self.decode(await command(["devices", "--json"])) { phones = devices.filter { $0.kind == "phone" } }
  }

  /// Opens the server's log, which says why it stopped.
  func showLog() {
    NSWorkspace.shared.open(Self.log)
  }

  /// Looks for each provider's program on this computer.
  func findPrograms() async {
    guard let found: [Program] = try? Self.decode(await command(["providers", "--json"])) else { return }
    programs = Dictionary(uniqueKeysWithValues: found.compactMap { program in Provider(rawValue: program.provider).map { ($0, program) } })
  }

  /// Looks for the providers' programs, and at the login the person's agents run on, for each provider they use one with.
  func checkSignIn() async {
    await findPrograms()
    var logins: [Provider: Login] = [:]
    for provider in Provider.allCases {
      if let account = account(provider), account.signIn == "login", programs[provider]?.ready == true {
        logins[provider] = await login(provider, configDir: account.configDir)
      }
    }
    self.logins = logins
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

  /// Turns on or off what the server tells the relay of how much it is used. The switch goes back when the server couldn't save it.
  func setCounting(_ on: Bool) async {
    counting = on
    savingCounting = true
    do {
      try await command(["counts", on ? "on" : "off"])
    } catch {
      counting = !on
    }
    countingSaves += 1
    savingCounting = false
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
  nonisolated static func run(_ program: URL, _ arguments: [String], in folder: URL? = nil) async
    -> (Int32, Data, String)
  {
    await Task.detached {
      let process = Process()
      process.executableURL = program
      process.arguments = arguments
      process.currentDirectoryURL = folder
      process.environment = Self.environment
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

/// The login in a provider's config folder, as the server's `signed-in --json` command reports it: whether it is signed in, as whom when the provider says, and whether it is an API key saved there, which has no plan.
struct Login: Decodable {
  let loggedIn: Bool
  let email: String?
  let apiKey: Bool
}
