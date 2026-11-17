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

/// Starts the server with the app, stops it as the app quits, and opens the app's windows.
@MainActor @Observable final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  let server = Server()
  private(set) var openAtLogin = SMAppService.mainApp.status == .enabled
  @ObservationIgnored private var windows: [String: NSWindow] = [:]
  @ObservationIgnored private var terminating: DispatchSourceSignal?

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Quits as usual when asked to stop, as `kill` does, so the server stops with it.
    signal(SIGTERM, SIG_IGN)
    terminating = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    terminating?.setEventHandler { NSApp.terminate(nil) }
    terminating?.resume()
    server.start()
    Task {
      await server.refresh()
      if server.person == nil { showSetup() }
      // Every two seconds until the server answers, then every fifteen. Claude Code's sign-in is looked at once a minute.
      var lookedAtClaude = ContinuousClock.now - .seconds(60)
      while true {
        if ContinuousClock.now - lookedAtClaude >= .seconds(60) {
          await server.checkClaude()
          lookedAtClaude = .now
        }
        try? await Task.sleep(for: server.status?.running == true ? .seconds(15) : .seconds(2))
        await server.refresh()
      }
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    server.stop()
  }

  /// Opens the window that asks how the agents sign in. On first run it goes on to the QR code.
  func showSetup() {
    let firstRun = server.person == nil
    show("setup", title: "Sidebots") {
      SetupView(server: server, changing: !firstRun) { [weak self] in
        guard let self else { return }
        self.close("setup")
        if firstRun {
          self.setOpenAtLogin(true)
          self.showPairing()
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

  /// Asks before unpairing a phone, since it needs a new code to pair again.
  func remove(_ phone: Phone) {
    NSApp.activate()
    let alert = NSAlert()
    alert.messageText = "Remove \(phone.name)?"
    alert.informativeText = "It stops reaching your agents at once. To use it again, pair it with a new code."
    alert.addButton(withTitle: "Remove")
    alert.addButton(withTitle: "Cancel")
    alert.buttons[0].hasDestructiveAction = true
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    Task {
      do {
        try await server.remove(phone)
      } catch {
        NSAlert(error: error).runModal()
      }
    }
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
 * panels are: whether phones can reach this Mac at the top, then the paired
 * phones with a way to pair another, then how the agents sign in to Claude,
 * and Open at login and Quit at the foot. Rows light up under the pointer.
 */
struct MenuContent: View {
  let app: AppDelegate
  let server: Server

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      if let person = server.person {
        Divider().padding(.vertical, 6)
        heading("Phones")
        if server.phones.isEmpty {
          Text("No phones yet").font(.callout).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.vertical, 4)
        }
        ForEach(server.phones) { phone in
          PanelRow(symbol: "iphone", title: phone.name) {
            HoverButton(symbol: "xmark.circle.fill", label: "Remove \(phone.name)") { app.remove(phone) }
          }
        }
        PanelRow(symbol: "qrcode", title: "Pair a phone…", action: app.showPairing)
        Divider().padding(.vertical, 6)
        heading("Claude")
        PanelRow(symbol: person.signIn == "api-key" ? "key.fill" : "person.crop.circle.fill", title: signIn(person), detail: signInDetail(person), warning: signedOut(person)) {
          Button(signedOut(person) ? "Sign in" : "Change") { app.showSetup() }.controlSize(.small)
        }
      } else {
        Divider().padding(.vertical, 6)
        PanelRow(symbol: "sparkles", title: "Finish setting up…", action: app.showSetup)
      }
      Divider().padding(.vertical, 6)
      Toggle(isOn: Binding(get: { app.openAtLogin }, set: { app.setOpenAtLogin($0) })) {
        Text("Open at login")
      }
      .toggleStyle(.switch)
      .controlSize(.mini)
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      PanelRow(symbol: nil, title: "Quit Sidebots", shortcut: "⌘Q") { NSApp.terminate(nil) }
        .keyboardShortcut("q")
    }
    .padding(6)
    .frame(width: 300)
  }

  /// The app's icon over whether phones can reach this Mac, with a dot in the light's color.
  private var header: some View {
    HStack(spacing: 10) {
      Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 36, height: 36)
      VStack(alignment: .leading, spacing: 2) {
        Text("Sidebots").font(.headline)
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
    guard let status = server.status, status.running else { return ("Starting…", .gray) }
    if server.person == nil { return ("Not set up yet", .orange) }
    switch status.reachable {
    case true: return ("Phones can reach this Mac", .green)
    case false: return ("Phones can't reach this Mac", .red)
    default: return ("Getting this Mac ready for phones…", .orange)
    }
  }

  private func signedOut(_ person: ServerStatus.Person) -> Bool {
    person.signIn == "claude" && server.claudeSignedIn == false
  }

  private func signIn(_ person: ServerStatus.Person) -> String {
    if person.signIn == "api-key" { return "API key" }
    return signedOut(person) ? "Signed out of Claude" : "Your Claude plan"
  }

  private func signInDetail(_ person: ServerStatus.Person) -> String {
    if person.signIn == "api-key" { return "Agents bill your Anthropic API key" }
    return signedOut(person) ? "Agents can't answer until you sign in" : "Agents use your Claude subscription"
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
