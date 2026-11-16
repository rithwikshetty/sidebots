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

/// The menu under the menu bar icon.
struct MenuContent: View {
  let app: AppDelegate
  let server: Server

  var body: some View {
    Text(state)
    Divider()
    if let person = server.person {
      Section("Phones") {
        if server.phones.isEmpty { Text("No phones yet") }
        ForEach(server.phones) { phone in
          Menu(phone.name) {
            Button("Remove…") { app.remove(phone) }
          }
        }
        Button("Pair a phone…") { app.showPairing() }
      }
      Divider()
      Section("Claude") {
        Text(signIn(person))
        Button(server.claudeSignedIn == false && person.signIn == "claude" ? "Sign in to Claude…" : "Change how agents sign in…") { app.showSetup() }
      }
    } else {
      Button("Finish setting up…") { app.showSetup() }
    }
    Divider()
    Toggle("Open at login", isOn: Binding(get: { app.openAtLogin }, set: { app.setOpenAtLogin($0) }))
    Button("Quit Sidebots") { NSApp.terminate(nil) }.keyboardShortcut("q")
  }

  /// Whether Sidebots is running and phones can reach it.
  private var state: String {
    guard let status = server.status, status.running else { return "Sidebots is starting…" }
    if server.person == nil { return "Sidebots isn't set up yet" }
    switch status.reachable {
    case true: return "Sidebots is running"
    case false: return "Phones can't reach this Mac"
    default: return "Getting this Mac ready for phones…"
    }
  }

  private func signIn(_ person: ServerStatus.Person) -> String {
    if person.signIn == "api-key" { return "Agents use an API key" }
    return server.claudeSignedIn == false ? "Signed out of Claude" : "Agents use your Claude plan"
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
