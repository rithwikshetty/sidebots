import AppKit
import Sparkle

/**
 * Keeps Sidebots up to date with Sparkle, from the feed named in Info.plist.
 * Sparkle downloads an update in the background. It installs once no agent is
 * in the middle of a turn: Sparkle quits the app, which stops the server, and
 * opens the new version, which starts it again.
 */
@MainActor final class Updater: NSObject, SPUUpdaterDelegate {
  private let server: Server
  private var controller: SPUStandardUpdaterController!
  /// Installs the downloaded update now. Set while an update waits for the agents.
  private var install: (() -> Void)?

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

  /// Installs a waiting update if no agent is in the middle of a turn.
  func installIfIdle() {
    guard let install, server.status?.working != true else { return }
    self.install = nil
    install()
  }

  nonisolated func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock: @escaping () -> Void) -> Bool {
    MainActor.assumeIsolated {
      install = immediateInstallationBlock
      installIfIdle()
    }
    return true
  }
}
