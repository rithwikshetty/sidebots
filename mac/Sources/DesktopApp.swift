import AppKit

/// The desktop app inside this bundle, at `Contents/Helpers/Sidebots.app`, which
/// shows the person's agents and their chats in a window. It finds the bundle's
/// Node and server by itself. It keeps running when its window closes, until
/// it quits.
@MainActor enum DesktopApp {
  static let url = Bundle.main.bundleURL.appending(path: "Contents/Helpers/Sidebots.app")
  private static let identifier = "app.sidebots.desktop"

  /// Whether this bundle carries it. A build of the menu bar app alone has none.
  static var bundled: Bool { FileManager.default.fileExists(atPath: url.path) }

  /// It, when it runs from this bundle. A copy in another bundle belongs to another Sidebots.
  static var running: [NSRunningApplication] {
    NSRunningApplication.runningApplications(withBundleIdentifier: identifier).filter {
      $0.bundleURL?.resolvingSymlinksInPath().path == url.resolvingSymlinksInPath().path
    }
  }

  /// Whether `quit` has been called, which is when Sidebots itself quits.
  private static var quitting = false

  /// How many launches `open` has asked the system for that the system hasn't answered yet. One of those isn't among `running`.
  private static var launching = 0

  /// Opens the window: starts the app, or brings its window forward when it runs.
  /// It gets the `PORT`, `SIDEBOTS_HOME` and `SIDEBOTS_RELAY` the server gets, so it reaches the same server.
  /// With `welcome`, as setup ends for someone new, an app it starts first shows what comes after setup.
  /// It does nothing once `quit` has been called.
  static func open(welcome: Bool = false) {
    guard bundled, !quitting else { return }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.allowsRunningApplicationSubstitution = false
    configuration.addsToRecentItems = false
    configuration.environment = Server.environment.filter { ["PORT", "SIDEBOTS_HOME", "SIDEBOTS_RELAY"].contains($0.key) }
    if welcome { configuration.environment["SIDEBOTS_WELCOME"] = "1" }
    launching += 1
    NSWorkspace.shared.openApplication(at: url, configuration: configuration) { @Sendable _, _ in
      Task { @MainActor in launching -= 1 }
    }
  }

  /// Asks it to quit, and returns once it has, a copy that was still being launched too.
  /// One that still runs after five seconds is ended, since an update may be about to replace its files.
  static func quit() async {
    quitting = true
    await wait(.seconds(5)) { launching == 0 }
    let apps = running
    for app in apps { app.terminate() }
    await wait(.seconds(5)) { apps.allSatisfy(\.isTerminated) }
    for app in apps where !app.isTerminated { app.forceTerminate() }
    await wait(.seconds(2)) { apps.allSatisfy(\.isTerminated) }
  }

  /// Returns once `done` holds, or after `limit`.
  private static func wait(_ limit: Duration, until done: () -> Bool) async {
    let deadline = ContinuousClock.now + limit
    while !done(), ContinuousClock.now < deadline {
      try? await Task.sleep(for: .milliseconds(100))
    }
  }
}
