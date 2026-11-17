import SwiftUI

/// The window that asks how the agents sign in to Claude: on first run, and
/// again from the menu to change it.
struct SetupView: View {
  let server: Server
  /// Whether the person is already set up and is changing how their agents sign in.
  let changing: Bool
  let done: () -> Void

  private enum Step {
    case checking
    case choosing(ClaudeAccount?)
    case signingIn(ClaudeSignIn)
    case apiKey
    case saving
  }

  @State private var step = Step.checking
  @State private var key = ""
  @State private var code = ""
  @State private var problem: String?

  /// The Claude Code config folder the agents use: the person's own, or for someone new, the one Claude Code uses on this computer.
  private var configDir: String {
    server.account?.configDir ?? ProcessInfo.processInfo.environment["CLAUDE_CONFIG_DIR"]
      ?? FileManager.default.homeDirectoryForCurrentUser.appending(path: ".claude").path
  }

  var body: some View {
    VStack(spacing: 20) {
      header
      switch step {
      case .checking:
        ProgressView().controlSize(.small).frame(height: 120)
      case .choosing(let account):
        choices(account)
      case .signingIn(let signIn):
        signingIn(signIn)
      case .apiKey:
        apiKey
      case .saving:
        VStack(spacing: 10) {
          ProgressView().controlSize(.small)
          Text(changing ? "Saving…" : "Setting up Sidebots…").foregroundStyle(.secondary)
        }
        .frame(height: 120)
      }
      if let problem {
        Text(problem).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(28)
    .frame(width: 460)
    .task { await check() }
    .onDisappear { if case .signingIn(let signIn) = step { signIn.cancel() } }
  }

  /// How the agents sign in now, when the person is changing it.
  private var now: String {
    guard changing, let account = server.account else { return "" }
    return account.signIn == "api-key" ? "They use an API key now. " : "They use your Claude plan now. "
  }

  private var header: some View {
    VStack(spacing: 8) {
      Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 72, height: 72)
      Text(changing ? "How your agents sign in" : "Set up Sidebots").font(.title2.bold())
      Text("Your agents run on this computer, on Claude Code. \(now)Choose how they sign in to Claude.")
      .multilineTextAlignment(.center)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func choices(_ account: ClaudeAccount?) -> some View {
    VStack(spacing: 10) {
      let current = server.account?.signIn
      if account?.loggedIn == true {
        let who = account?.email.map { "Signed in as \($0). " } ?? ""
        Choice(
          symbol: "checkmark.seal",
          title: current == "login" ? "Keep using Claude Code on this computer" : "Use Claude Code on this computer",
          detail: "\(who)Your agents use the same Claude plan."
        ) { save(.login) }
      } else {
        Choice(symbol: "person.crop.circle", title: "Sign in to Claude", detail: "For a Claude Pro or Max plan. Opens Claude in your browser.") {
          signIn()
        }
      }
      Choice(
        symbol: "key",
        title: current == "api-key" ? "Use a different API key" : "Use an API key",
        detail: "Pay for what your agents use, with a key from the Claude Console."
      ) {
        problem = nil
        step = .apiKey
      }
    }
  }

  private func signingIn(_ signIn: ClaudeSignIn) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 10) {
        ProgressView().controlSize(.small)
        Text("Finish signing in to Claude in your browser. Sidebots carries on by itself once you have.")
          .fixedSize(horizontal: false, vertical: true)
      }
      if let page = signIn.page {
        Link("Open the sign-in page again", destination: page)
      }
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
      HStack {
        Spacer()
        Button("Cancel") { signIn.cancel() }
      }
    }
  }

  private var apiKey: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Paste your API key.")
      SecureField("sk-ant-…", text: $key).textFieldStyle(.roundedBorder).onSubmit(saveKey)
      Text("Make one in the [Claude Console](https://platform.claude.com/settings/keys). Sidebots keeps it on this computer.")
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      HStack {
        Button("Back") { Task { await check() } }
        Spacer()
        Button("Continue", action: saveKey).keyboardShortcut(.defaultAction).disabled(key.trimmingCharacters(in: .whitespaces).isEmpty)
      }
    }
  }

  /// Looks at whether Claude Code is signed in on this computer, then asks the person to choose.
  private func check() async {
    problem = nil
    step = .checking
    step = .choosing(await Server.claudeAccount(configDir: configDir))
  }

  private func signIn() {
    problem = nil
    code = ""
    let signIn = ClaudeSignIn()
    step = .signingIn(signIn)
    Task {
      if let failed = await signIn.run(configDir: configDir) {
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
    problem = nil
    step = .saving
    Task {
      do {
        try await server.setUp(signIn, configDir: configDir)
        done()
      } catch {
        await check()
        problem = error.localizedDescription
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
