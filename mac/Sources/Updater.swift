import AppKit
import Sparkle

/**
 * Keeps Sidebots up to date with Sparkle, from the feed named in Info.plist.
 * Sparkle downloads an update in the background. It installs once no agent is
 * in the middle of a turn: Sparkle quits the app, which stops the server and
 * quits the window's app, and opens the new version, which starts the server
 * again and opens the window when its app was running.
 */
@MainActor final class Updater: NSObject, SPUUpdaterDelegate {
  private let server: Server
  private var controller: SPUStandardUpdaterController!
  /// Installs the downloaded update now. Set while an update waits for the agents.
  private var install: (() -> Void)?
  /// Where the app keeps, for the version an update installs, whether the window's app was running as it installed.
  private static let windowWasRunning = "windowWasRunningBeforeUpdate"

  /// Whether the window's app was running as the update that opened this version installed. Nil for a launch that didn't follow an update. It says so once.
  static func windowRanBeforeUpdate() -> Bool? {
    defer { UserDefaults.standard.removeObject(forKey: windowWasRunning) }
    return UserDefaults.standard.object(forKey: windowWasRunning) as? Bool
  }

  init(server: Server) {
    self.server = server
    super.init()
    controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
  }

  /// Looks for an update now, and shows what it finds.
  func check() {
    NSApp.activate()
    controller.checkForUpdates(nil)
  }

  /// Installs a waiting update if no agent is in the middle of a turn, as the server says now.
  func installIfIdle() async {
    guard install != nil else { return }
    await server.readStatus()
    guard let install, server.status?.working != true else { return }
    self.install = nil
    install()
  }

  /// Sparkle is about to quit the app, install the update and open the new version, whether the update waited for the agents or the person asked for it.
  nonisolated func updaterWillRelaunchApplication(_ updater: SPUUpdater) {
    MainActor.assumeIsolated {
      UserDefaults.standard.set(!DesktopApp.running.isEmpty, forKey: Self.windowWasRunning)
    }
  }

  nonisolated func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock: @escaping () -> Void) -> Bool {
    MainActor.assumeIsolated {
      install = immediateInstallationBlock
      Task { await installIfIdle() }
    }
    return true
  }
}
