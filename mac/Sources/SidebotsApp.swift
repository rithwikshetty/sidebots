import ServiceManagement
import SwiftUI

@main struct SidebotsApp: App {
  @NSApplicationDelegateAdaptor private var app: AppDelegate

  var body: some Scene {
    MenuBarExtra {
      MenuContent(app: app, server: app.server)
    } label: {
      Image(nsImage: MenuBarIcon.image(awake: app.server.status?.running == true && app.server.status?.reachable == true))
    }
    .menuBarExtraStyle(.window)
  }
}

/// Starts the server with the app, stops it and quits the window's app as the app quits, and opens the app's windows.
@MainActor @Observable final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  let server = Server()
  @ObservationIgnored private(set) lazy var updater = Updater(server: server)
  private(set) var openAtLogin = SMAppService.mainApp.status == .enabled
  /// Whether the app has Full Disk Access, as it was when the panel last opened.
  private(set) var fullDiskAccess = FullDiskAccess.granted
  @ObservationIgnored private var windows: [String: NSWindow] = [:]
  @ObservationIgnored private var terminating: DispatchSourceSignal?

  /// Whether the system opened the app at login, as the event that opened it says. The event is at hand only while the app finishes launching.
  private var openedAtLogin: Bool {
    guard let event = NSAppleEventManager.shared().currentAppleEvent, event.eventID == kAEOpenApplication else { return false }
    return event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // The window opens once the server answers when the person opened Sidebots, or when an update
    // quit the window's app to install. Sidebots opened at login, or by an update while the window's
    // app wasn't running, stays in the menu bar.
    let opensWindow = Updater.windowRanBeforeUpdate() ?? !openedAtLogin
    // Quits as usual when asked to stop, as `kill` does, so the server stops with it.
    // The run loop makes the call: quitting waits for the server to stop, and that
    // news comes on the main queue, which stands still while one of its own handlers runs.
    signal(SIGTERM, SIG_IGN)
    terminating = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    terminating?.setEventHandler {
      RunLoop.main.perform(inModes: [.common]) { MainActor.assumeIsolated { NSApp.terminate(nil) } }
    }
    terminating?.resume()
    server.start()
    _ = updater
    // The menu bar panel is a window of the system's making, which becomes the key window each time it opens. It shows the server as it stands then.
    NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: nil, queue: .main) { [weak self] opened in
      MainActor.assumeIsolated {
        guard let self, let window = opened.object as? NSWindow, !self.windows.values.contains(window) else { return }
        self.fullDiskAccess = FullDiskAccess.granted
        Task {
          await self.server.refresh()
          await self.server.checkSignIn()
        }
      }
    }
    Task {
      await server.readStatus()
      var opensWindow = opensWindow
      // A server that can't say who is set up is no sign that nobody is. Setup opens the window once it ends.
      if !server.failed, server.person == nil {
        showSetup()
        opensWindow = false
      }
      // What the panel shows is read apart from the window, which waits for none of it.
      Task {
        await server.readPhones()
        await server.checkSignIn()
      }
      // The app looks at the server once a minute while it runs and phones reach it. After a look that found it short of that it looks again a moment later, then waits twice as long each time, up to the minute.
      let (firstWait, longestWait) = (Duration.milliseconds(250), Duration.seconds(60))
      var wait = firstWait
      while true {
        await server.lookAtPort()
        // The window opens once the server answers on its port, before the app has asked at its address.
        if opensWindow, server.status?.running == true, server.person != nil {
          opensWindow = false
          DesktopApp.open()
        }
        await server.lookAtAddress()
        await updater.installIfIdle()
        let settled = server.status?.running == true && server.status?.reachable == true
        try? await Task.sleep(for: settled ? longestWait : wait)
        wait = settled ? firstWait : min(wait * 2, longestWait)
      }
    }
  }

  /// Quits once the window's app has quit and the server has stopped, so that neither outlives the app.
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    Task {
      await DesktopApp.quit()
      server.stop { sender.reply(toApplicationShouldTerminate: true) }
    }
    return .terminateLater
  }

  /// Opening Sidebots while it runs opens the window, or setup for someone not set up yet.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if server.person != nil {
      DesktopApp.open()
    } else if !server.failed {
      showSetup()
    }
    return false
  }

  /// Opens the window that sets the person up on a provider, or changes how their agents sign in to it. On first run the person picks the provider there, and once they are set up Sidebots opens at login and the window opens on what comes after setup.
  func showSetup(_ provider: Provider? = nil) {
    let firstRun = server.person == nil
    show("setup", title: "Sidebots") {
      SetupView(server: server, provider: firstRun ? nil : provider) { [weak self] in
        guard let self else { return }
        self.close("setup")
        if firstRun {
          self.setOpenAtLogin(true)
          DesktopApp.open(welcome: true)
        }
      }
    }
  }

  func showPairing() {
    show("pair", title: "Pair a phone") {
      PairView(server: server) { [weak self] in self?.close("pair") }
    }
  }

  func setOpenAtLogin(_ on: Bool) {
    try? on ? SMAppService.mainApp.register() : SMAppService.mainApp.unregister()
    openAtLogin = SMAppService.mainApp.status == .enabled
  }

  /// Shows a window, or brings it forward when it is already open. The app shows in the Dock while one is open, so the window is easy to find.
  private func show(_ id: String, title: String, @ViewBuilder content: () -> some View) {
    let window = windows[id] ?? {
      let controller = NSHostingController(rootView: content())
      controller.sizingOptions = .preferredContentSize
      let window = NSWindow(contentViewController: controller)
      window.title = title
      window.styleMask = [.titled, .closable]
      window.isReleasedWhenClosed = false
      window.delegate = self
      window.setContentSize(controller.view.fittingSize)
      window.center()
      windows[id] = window
      return window
    }()
    NSApp.setActivationPolicy(.regular)
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }

  private func close(_ id: String) {
    windows[id]?.close()
  }

  func windowWillClose(_ notification: Notification) {
    guard let window = notification.object as? NSWindow, let id = windows.first(where: { $0.value === window })?.key else { return }
    windows[id] = nil
    if windows.isEmpty { NSApp.setActivationPolicy(.accessory) }
  }
}

/**
 * The panel under the menu bar icon, laid out as the system's own menu bar
 * panels are: whether phones can reach this computer at the top, then Open Sidebots, which opens the window with the chats, then the paired
 * phones with a way to pair another, then how the agents sign in to each provider
 * the person has set up, or that its program is missing from this Mac, with a way to set up one they haven't, a way to turn on
 * Full Disk Access while the app hasn't it, and Open at login,
 * Share usage counts, Check for updates and Quit at the foot. When the server can't start, the panel says so in place of the phones and
 * providers, with a way to its log. Rows light up under the pointer.
 * A phone's row asks before it unpairs the phone, since the phone needs a new code to pair again.
 */
struct MenuContent: View {
  let app: AppDelegate
  let server: Server
  /// The phone whose row asks whether to remove it.
  @State private var removing: Phone.ID?
  /// The phone the server couldn't remove, and why.
  @State private var problem: (phone: Phone.ID, words: String)?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      if server.person != nil {
        Divider().padding(.vertical, 6)
        if DesktopApp.bundled {
          PanelRow(symbol: "macwindow", title: "Open Sidebots", action: { DesktopApp.open() })
          Divider().padding(.vertical, 6)
        }
        heading("Phones")
        if server.phones.isEmpty {
          Text("No phones yet").font(.callout).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.vertical, 4)
        }
        ForEach(server.phones) { phone in
          PanelRow(symbol: "iphone", title: phone.name, detail: detail(phone), warning: problem?.phone == phone.id) {
            if removing == phone.id {
              Button("Remove", role: .destructive) { remove(phone) }.controlSize(.small)
            } else {
              HoverButton(symbol: "xmark.circle.fill", label: "Remove \(phone.name)") { removing = phone.id }
            }
          }
          .onHover { if !$0, removing == phone.id { removing = nil } }
        }
        PanelRow(symbol: "qrcode", title: "Pair a phone…", action: app.showPairing)
        Divider().padding(.vertical, 6)
        ForEach(Provider.allCases) { provider in
          if let account = server.account(provider) {
            heading(provider.name)
            if let program = server.programs[provider], !program.ready {
              // Agents on it can't run until its program is on this Mac, at a version Sidebots works with.
              PanelRow(
                symbol: "exclamationmark.triangle.fill",
                title: program.path == nil ? "\(provider.name) isn't on this Mac" : "\(provider.name) needs an update",
                detail: program.path == nil ? "Agents can't answer until you install it" : "Sidebots needs \(program.oldest) or later",
                warning: true
              ) {
                Button(program.path == nil ? "Install" : "Check") { app.showSetup(provider) }.controlSize(.small)
              }
            } else {
              let signedOut = account.signIn == "login" && server.logins[provider]?.loggedIn == false
              PanelRow(symbol: server.billsKey(provider) ? "key.fill" : "person.crop.circle.fill", title: signIn(provider, signedOut), detail: signInDetail(provider, signedOut), warning: signedOut) {
                Button(signedOut ? "Sign in" : "Change") { app.showSetup(provider) }.controlSize(.small)
              }
            }
          } else {
            PanelRow(symbol: "plus", title: "Set up \(provider.name)…") { app.showSetup(provider) }
          }
        }
        if !app.fullDiskAccess {
          Divider().padding(.vertical, 6)
          PanelRow(symbol: "folder.badge.questionmark", title: "Let agents open your files", detail: "Or macOS asks on this Mac first") {
            Button("Turn on", action: FullDiskAccess.open).controlSize(.small)
          }
        }
      } else if server.failed {
        Divider().padding(.vertical, 6)
        PanelRow(symbol: "exclamationmark.triangle.fill", title: "Its server stopped with an error", detail: "Your agents and phones are as you left them", warning: true) {
          Button("Show log", action: server.showLog).controlSize(.small)
        }
      } else {
        Divider().padding(.vertical, 6)
        PanelRow(symbol: "sparkles", title: "Finish setting up…") { app.showSetup() }
      }
      Divider().padding(.vertical, 6)
      Toggle(isOn: Binding(get: { app.openAtLogin }, set: { app.setOpenAtLogin($0) })) {
        Text("Open at login")
      }
      .toggleStyle(.switch)
      .controlSize(.mini)
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      Toggle(isOn: Binding(get: { server.counting }, set: { on in Task { await server.setCounting(on) } })) {
        Text("Share usage counts")
      }
      .toggleStyle(.switch)
      .controlSize(.mini)
      .disabled(server.savingCounting)
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .help("Your Sidebots version, how many agents and phones you have, and how many turns your agents ran on Claude Code and Codex. Never who you are or what was said.")
      PanelRow(symbol: nil, title: "Check for updates…", action: app.updater.check)
      PanelRow(symbol: nil, title: "Quit Sidebots", shortcut: "⌘Q") { NSApp.terminate(nil) }
        .keyboardShortcut("q")
    }
    .padding(6)
    .frame(width: 300)
  }

  /// The app's icon over whether phones can reach this computer, with a dot in the light's color.
  private var header: some View {
    HStack(spacing: 10) {
      Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 36, height: 36)
      VStack(alignment: .leading, spacing: 2) {
        Text(Server.name).font(.headline)
        HStack(spacing: 5) {
          Circle().fill(state.color).frame(width: 7, height: 7)
          Text(state.words).font(.callout).foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 10)
    .padding(.top, 6)
    .padding(.bottom, 2)
  }

  private func heading(_ words: String) -> some View {
    Text(words).font(.caption.weight(.semibold)).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.bottom, 2)
  }

  /// Whether Sidebots is running and phones can reach it, and the color of its light.
  private var state: (words: String, color: Color) {
    if server.failed { return ("Sidebots can't start", .red) }
    guard let status = server.status, status.running else { return ("Starting…", .gray) }
    if server.person == nil { return ("Not set up yet", .orange) }
    switch status.reachable {
    case true: return ("Phones can reach this computer", .green)
    case false: return ("Phones can't reach this computer", .red)
    default: return ("Getting this computer ready for phones…", .orange)
    }
  }

  /// What a phone's row says under its name: when it paired, which tells apart two phones of one name. A row that asks whether to remove its phone says what removing costs, and one whose phone the server couldn't remove says why.
  private func detail(_ phone: Phone) -> String {
    if removing == phone.id { return "It will need a new code" }
    if let problem, problem.phone == phone.id { return problem.words }
    return "Paired \(Date(timeIntervalSince1970: phone.pairedAt / 1000).formatted(date: .abbreviated, time: .shortened))"
  }

  private func remove(_ phone: Phone) {
    removing = nil
    problem = nil
    Task {
      do {
        try await server.remove(phone)
      } catch {
        problem = (phone.id, error.localizedDescription)
      }
    }
  }

  private func signIn(_ provider: Provider, _ signedOut: Bool) -> String {
    if server.billsKey(provider) { return "API key" }
    return signedOut ? "Signed out of \(provider.account)" : "Your \(provider.account) plan"
  }

  private func signInDetail(_ provider: Provider, _ signedOut: Bool) -> String {
    if server.billsKey(provider) { return "Agents bill your \(provider.maker) API key" }
    return signedOut ? "Agents can't answer until you sign in" : "Agents use your \(provider.account) subscription"
  }
}

/// One row of the panel: a symbol in a round tile, words, and whatever goes at its end. A row with an action lights up under the pointer and runs it on a click.
struct PanelRow<Accessory: View>: View {
  let symbol: String?
  let title: String
  var detail: String? = nil
  var warning = false
  var shortcut: String? = nil
  var action: (() -> Void)? = nil
  @ViewBuilder var accessory: Accessory
  @State private var hovering = false

  var body: some View {
    let row = HStack(spacing: 10) {
      if let symbol {
        Image(systemName: symbol)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(warning ? Color.white : Color.primary)
          .frame(width: 26, height: 26)
          .background(Circle().fill(warning ? Color.orange : Color.primary.opacity(0.1)))
      }
      VStack(alignment: .leading, spacing: 1) {
        Text(title)
        if let detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
      }
      Spacer(minLength: 8)
      accessory
      if let shortcut { Text(shortcut).foregroundStyle(.secondary) }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, symbol == nil ? 5 : 4)
    .contentShape(Rectangle())
    .background(RoundedRectangle(cornerRadius: 6).fill(action != nil && hovering ? Color.primary.opacity(0.1) : .clear))
    .onHover { hovering = $0 }
    if let action {
      Button(action: action) { row }.buttonStyle(.plain)
    } else {
      row
    }
  }
}

extension PanelRow where Accessory == EmptyView {
  init(symbol: String?, title: String, detail: String? = nil, shortcut: String? = nil, action: @escaping () -> Void) {
    self.init(symbol: symbol, title: title, detail: detail, shortcut: shortcut, action: action) { EmptyView() }
  }
}

/// A small round button at the end of a row, quiet until the pointer is on it.
struct HoverButton: View {
  let symbol: String
  let label: String
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: 14)).foregroundStyle(hovering ? Color.secondary : Color.secondary.opacity(0.45))
    }
    .buttonStyle(.plain)
    .help(label)
    .accessibilityLabel(label)
    .onHover { hovering = $0 }
  }
}

/// The menu bar icon: Mochi, the slime on Sidebots' app icon, drawn from its
/// pixel grid. Solid while phones can reach Sidebots, an outline while they can't.
enum MenuBarIcon {
  // o is the outline, b the body, a the bow, and e the eyes and mouth.
  private static let grid = [
    "........a.a.....",
    ".........a......",
    "......oooo......",
    "....oobbbboo....",
    "...obbbbbbbbo...",
    "..obbbbbbbbbbo..",
    "..obbbbbbbbbbo..",
    ".obbbeebbeebbbo.",
    ".obbbeebbeebbbo.",
    ".obbbbbbbbbbbbo.",
    ".obbbbbbeebbbbo.",
    ".obbbbbbbbbbbbo.",
    "..obbbbbbbbbbo..",
    "...oooooooooo...",
  ]

  static func image(awake: Bool) -> NSImage {
    let image = NSImage(size: NSSize(width: 16, height: 16), flipped: true) { _ in
      NSColor.black.setFill()
      for (row, line) in grid.enumerated() {
        for (column, cell) in line.enumerated() where awake ? "oba".contains(cell) : "oae".contains(cell) {
          NSRect(x: column, y: row + 1, width: 1, height: 1).fill()
        }
      }
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = awake ? "Sidebots" : "Sidebots, not reachable"
    return image
  }
}
