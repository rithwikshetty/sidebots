import SwiftUI

/// The window that sets the person up on a provider and asks how their agents
/// sign in to it: on first run, when they add another provider, and again
/// from the menu to change it. On first run it opens on a welcome that asks
/// what their agents should call them, then shows Ruby, the agent they start
/// with, and asks when its morning brief should come. They then turn on Full
/// Disk Access, when the app hasn't it, and pick the provider. A provider
/// whose program isn't on this Mac is installed first, by the person or by
/// its maker's installer.
struct SetupView: View {
  let server: Server
  let done: () -> Void

  private enum Step {
    case welcome
    case ruby
    case picking
    case checking
    case missing
    case installing
    case choosing(Login?)
    case signingIn(BrowserSignIn)
    case apiKey
    case saving
    case files
  }

  /// The provider being set up or changed. None until the person has picked one, on first run.
  @State private var provider: Provider?
  @State private var step: Step
  @State private var key = ""
  @State private var code = ""
  @State private var problem: String?
  /// What the person's agents call them, and when Ruby's brief comes, as `08:00`, or `off`. Both are kept until the person is set up, since macOS reopens the app to give it Full Disk Access.
  @AppStorage(Self.nameKey) private var name = ""
  @AppStorage(Self.briefKey) private var brief = "08:00"
  @State private var called: String

  private static let (nameKey, briefKey) = ("setup.name", "setup.brief")

  init(server: Server, provider: Provider?, done: @escaping () -> Void) {
    self.server = server
    self.done = done
    _provider = State(initialValue: provider)
    let greeted = server.person != nil || UserDefaults.standard.string(forKey: Self.nameKey) != nil
    _step = State(initialValue: provider != nil ? .checking : !greeted ? .welcome : FullDiskAccess.granted ? .picking : .files)
    // The name the computer knows its user by, without the family name.
    _called = State(initialValue: PersonNameComponentsFormatter().personNameComponents(from: Server.personName)?.givenName ?? Server.personName)
  }

  /// How the person's agents sign in to the provider now, when they have set it up.
  private var account: ServerStatus.Account? { provider.flatMap(server.account) }

  /// The provider's program on this Mac, once the server has looked.
  private var program: Program? { provider.flatMap { server.programs[$0] } }

  /// The provider's config folder the agents use: the person's own, or for someone new to it, the one its program uses on this computer.
  private func configDir(_ provider: Provider) -> String { server.account(provider)?.configDir ?? server.programs[provider]?.configDir ?? "" }

  var body: some View {
    VStack(spacing: 20) {
      header
      switch step {
      case .welcome:
        welcome
      case .ruby:
        ruby
      case .picking:
        providers
      case .checking:
        ProgressView().controlSize(.small).frame(height: 120)
      case .missing:
        if let provider { missing(provider) }
      case .installing:
        VStack(spacing: 10) {
          ProgressView().controlSize(.small)
          Text("Installing \(provider?.name ?? "")…").foregroundStyle(.secondary)
        }
        .frame(height: 120)
      case .choosing(let login):
        if let provider { choices(provider, login) }
      case .signingIn(let signIn):
        signingIn(signIn)
      case .apiKey:
        if let provider { apiKey(provider) }
      case .saving:
        VStack(spacing: 10) {
          ProgressView().controlSize(.small)
          Text(account == nil ? "Setting up…" : "Saving…").foregroundStyle(.secondary)
        }
        .frame(height: 120)
      case .files:
        files
      }
      if let problem {
        Text(problem).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(28)
    .frame(width: 460)
    .task { if provider != nil { await check() } }
    .onDisappear { if case .signingIn(let signIn) = step { signIn.cancel() } }
  }

  private var header: some View {
    VStack(spacing: 8) {
      if case .ruby = step {
        Sprite(avatar: "cog").frame(height: 72)
      } else {
        Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 72, height: 72)
      }
      Text(title).font(.title2.bold())
      Text(words)
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var title: String {
    if case .files = step { return "Let agents open your files" }
    if case .welcome = step { return "Welcome to Sidebots" }
    if case .ruby = step { return "Meet Ruby, your first agent" }
    if server.person == nil { return "Set up Sidebots" }
    guard let provider else { return "Sidebots" }
    return account == nil ? "Set up \(provider.name)" : "How your agents sign in"
  }

  /// What the window asks, under its title.
  private var words: String {
    if case .files = step { return "The first time an agent opens Documents, Desktop, Downloads or a drive, macOS asks on this Mac, and the agent waits until someone answers here. With Full Disk Access your agents open them without asking." }
    if case .welcome = step { return "Your own agents, on your own computer. Give one a job, and it tells you when it's done." }
    if case .ruby = step { return "Ruby briefs you every morning on what your day holds and what needs you, and helps with anything else you ask. You can make more agents later." }
    guard let provider else { return "Your agents run on this computer, on a program of your own that you sign in to yourself. Choose the one your agents start on. You can set up the other later." }
    if case .missing = step, let program {
      guard let version = program.version else { return "\(provider.name) isn't on this Mac. Your agents run on the \(provider.name) you install, and Sidebots carries none of its own." }
      return "\(provider.name) \(version) is on this Mac, and Sidebots needs \(program.oldest) or later. Update it, then check again."
    }
    guard let account else { return "Agents on \(provider.name) run on this computer. Choose how they sign in to \(provider.account)." }
    // The login the window has just looked at, which is newer than the one the server last checked.
    let key = if case .choosing(let login?) = step, account.signIn == "login" { login.apiKey } else { server.billsKey(provider) }
    let now = key ? "They use an API key now." : "They use your \(provider.account) plan now."
    return "Your agents on \(provider.name) run on this computer. \(now) Choose how they sign in to \(provider.account)."
  }

  /// The first step of first run: what the person's agents call them.
  private var welcome: some View {
    VStack(spacing: 12) {
      Text("What should your agents call you?").foregroundStyle(.secondary)
      TextField("Your name", text: $called).textFieldStyle(.roundedBorder).multilineTextAlignment(.center).frame(width: 220).onSubmit(greet)
      Button("Get started", action: greet).keyboardShortcut(.defaultAction).controlSize(.large).disabled(typed.isEmpty)
    }
  }

  /// The name as it is kept. It is an argument of the server's commands, where one that starts with a hyphen reads as an option.
  private var typed: String { called.trimmingCharacters(in: .whitespaces.union(CharacterSet(charactersIn: "-"))) }

  private func greet() {
    guard !typed.isEmpty else { return }
    name = typed
    step = .ruby
  }

  /// The agent the person starts with, and when its morning brief comes.
  private var ruby: some View {
    VStack(spacing: 12) {
      Text("Send the morning brief at").foregroundStyle(.secondary)
      Picker("Send the morning brief at", selection: $brief) {
        Text("7:00").tag("07:00")
        Text("8:00").tag("08:00")
        Text("9:00").tag("09:00")
        Text("No brief").tag("off")
      }
      .pickerStyle(.segmented).labelsHidden().frame(width: 300)
      HStack {
        Button("Back") { step = .welcome }
        Spacer()
        Button("Continue") { step = FullDiskAccess.granted ? .picking : .files }.keyboardShortcut(.defaultAction)
      }
      .padding(.top, 8)
    }
  }

  private var providers: some View {
    VStack(spacing: 10) {
      ForEach(Provider.allCases) { provider in
        let installed = server.programs[provider].map { $0.path == nil ? " Not on this Mac yet." : " On this Mac." } ?? ""
        Choice(symbol: provider == .claude ? "sparkle" : "circle.hexagongrid", title: provider.name, detail: provider.summary + installed) {
          self.provider = provider
          Task { await check() }
        }
      }
    }
  }

  /// What to do about a provider whose program isn't on this Mac, or is too old: have its maker's installer put it there, or check again once the person has seen to it.
  private func missing(_ provider: Provider) -> some View {
    VStack(spacing: 10) {
      if let program, program.path == nil {
        Choice(symbol: "arrow.down.circle", title: "Install \(provider.name)", detail: "Runs \(provider.maker)'s own installer:\n\(program.installer)") {
          install(provider)
        }
      }
      Choice(symbol: "arrow.clockwise", title: program?.path == nil ? "I've installed it myself" : "Check again", detail: "Look for \(provider.name) on this Mac again.") {
        Task { await check() }
      }
      back
    }
  }

  /// Back to the two providers, for someone who has yet to set up either.
  @ViewBuilder private var back: some View {
    if server.person == nil {
      HStack {
        Button("Back") {
          problem = nil
          provider = nil
          step = .picking
        }
        Spacer()
      }
    }
  }

  private func choices(_ provider: Provider, _ login: Login?) -> some View {
    VStack(spacing: 10) {
      let current = account?.signIn
      if login?.loggedIn == true {
        let who = login?.email.map { "Signed in as \($0). " } ?? ""
        Choice(
          symbol: "checkmark.seal",
          title: current == "login" ? "Keep using \(provider.name) on this computer" : "Use \(provider.name) on this computer",
          detail: who + (login?.apiKey == true ? "It is an API key, so \(provider.maker) bills it for what your agents use." : "Your agents use the same \(provider.account) plan.")
        ) { save(.login) }
      } else {
        Choice(
          symbol: "person.crop.circle",
          title: "Sign in to \(provider.account)",
          detail: "For a \(provider.account) \(provider.plans) plan. Opens \(provider.account) in your browser."
        ) {
          signIn(provider)
        }
      }
      Choice(
        symbol: "key",
        title: current == "api-key" ? "Use a different API key" : "Use an API key",
        detail: "Pay \(provider.maker) for what your agents use, with a key of your own."
      ) {
        problem = nil
        step = .apiKey
      }
      back
    }
  }

  /// The first step of first run: Full Disk Access, which only the person can turn on, in System Settings. macOS reopens the app to give it, and the app opens on setup again, past this step.
  private var files: some View {
    VStack(spacing: 10) {
      Choice(symbol: "folder.badge.questionmark", title: "Turn on Full Disk Access", detail: "Opens System Settings. Turn on \(Server.name) there, or add it with +, then let macOS reopen it.", action: FullDiskAccess.open)
      HStack {
        Spacer()
        Button("Continue") { step = .picking }
      }
    }
  }

  private func signingIn(_ signIn: BrowserSignIn) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 10) {
        ProgressView().controlSize(.small)
        Text("Finish signing in to \(signIn.provider.account) in your browser. Sidebots carries on by itself once you have.")
          .fixedSize(horizontal: false, vertical: true)
      }
      if let page = signIn.page {
        Link("Open the sign-in page again", destination: page)
      }
      if signIn.provider.takesCode {
        VStack(alignment: .leading, spacing: 6) {
          Text("If the page shows a code, paste it here.").foregroundStyle(.secondary)
          HStack {
            TextField("Code", text: $code).textFieldStyle(.roundedBorder)
            Button("Continue") { signIn.enter(code: code) }.disabled(code.isEmpty)
          }
          if let answer = signIn.answer {
            Text(answer).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      HStack {
        Spacer()
        Button("Cancel") { signIn.cancel() }
      }
    }
  }

  private func apiKey(_ provider: Provider) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Paste your API key.")
      SecureField(provider.keyStart, text: $key).textFieldStyle(.roundedBorder).onSubmit(saveKey)
      Text(.init("Make one in the \(provider.keyPage). Sidebots keeps it on this computer."))
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      HStack {
        Button("Back") { Task { await check() } }
        Spacer()
        Button("Continue", action: saveKey).keyboardShortcut(.defaultAction).disabled(key.trimmingCharacters(in: .whitespaces).isEmpty)
      }
    }
  }

  /// Looks for the provider's program on this computer, and at whether it is signed in, then asks the person to choose.
  private func check() async {
    guard let provider else { return }
    problem = nil
    step = .checking
    await server.findPrograms()
    guard server.programs[provider]?.ready == true else {
      step = .missing
      return
    }
    step = .choosing(await server.login(provider, configDir: configDir(provider)))
  }

  private func install(_ provider: Provider) {
    problem = nil
    step = .installing
    Task {
      do {
        try await server.install(provider)
        await check()
      } catch {
        await check()
        // The installer says why it failed on its last line.
        problem = error.localizedDescription.split(separator: "\n").last.map(String.init)
      }
    }
  }

  private func signIn(_ provider: Provider) {
    problem = nil
    code = ""
    let signIn = BrowserSignIn(provider)
    step = .signingIn(signIn)
    Task {
      if let failed = await signIn.run(configDir: configDir(provider)) {
        await check()
        if !failed.isEmpty { problem = failed }
      } else {
        save(.login)
      }
    }
  }

  private func saveKey() {
    let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !key.isEmpty else { return }
    save(.apiKey(key))
  }

  private func save(_ signIn: SignIn) {
    guard let provider else { return }
    problem = nil
    step = .saving
    Task {
      do {
        try await server.setUp(provider, signIn, configDir: configDir(provider), called: name, brief: brief)
        for key in [Self.nameKey, Self.briefKey] { UserDefaults.standard.removeObject(forKey: key) }
        done()
      } catch {
        await check()
        problem = error.localizedDescription
      }
    }
  }
}

/// An avatar from the app's starter avatars, playing the animation it has for a reply that has just come. The sheet is laid out as `AVATAR_SHEET` in server/src/contract.ts says.
private struct Sprite: View {
  private let sheet: CGImage?
  private static let (cell, art, row, frames) = (CGSize(width: 192, height: 208), CGRect(x: 24, y: 39, width: 144, height: 153), 2, 6)

  init(avatar: String) {
    sheet = NSImage(contentsOf: Bundle.main.resourceURL!.appending(path: "avatars/\(avatar)/spritesheet.png"))?.cgImage(forProposedRect: nil, context: nil, hints: nil)
  }

  var body: some View {
    TimelineView(.periodic(from: .now, by: 0.3)) { time in
      let frame = Int(time.date.timeIntervalSinceReferenceDate / 0.3) % Self.frames
      let shown = Self.art.offsetBy(dx: CGFloat(frame) * Self.cell.width, dy: CGFloat(Self.row) * Self.cell.height)
      if let drawn = sheet?.cropping(to: shown) {
        Image(decorative: drawn, scale: 1).interpolation(.none).resizable().aspectRatio(contentMode: .fit)
      }
    }
  }
}

/// One of the ways to sign in, as a large button.
private struct Choice: View {
  let symbol: String
  let title: String
  let detail: String
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 14) {
        Image(systemName: symbol).font(.title2).foregroundStyle(.tint).frame(width: 30)
        VStack(alignment: .leading, spacing: 3) {
          Text(title).font(.headline)
          Text(detail).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
        Image(systemName: "chevron.right").foregroundStyle(.tertiary)
      }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 10).fill(hovering ? AnyShapeStyle(.quaternary) : AnyShapeStyle(.quinary)))
      .contentShape(RoundedRectangle(cornerRadius: 10))
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}
