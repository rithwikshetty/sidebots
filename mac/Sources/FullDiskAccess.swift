import AppKit

/// Full Disk Access, the macOS privacy setting that lets Sidebots open any
/// file without asking. The server and the agents run inside the app, so
/// they have it when the app does. Without it, macOS asks on this Mac the
/// first time an agent opens Documents, Desktop, Downloads or a drive, and
/// the agent waits for an answer that can't come from a phone. Only the
/// person can turn it on, in System Settings.
@MainActor enum FullDiskAccess {
  /// The privacy settings' own database, which macOS lets an app read only with Full Disk Access. Reading it asks nothing.
  private static let guarded = FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Application Support/com.apple.TCC/TCC.db")
  private static let settings = URL(string: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles")!

  /// Whether the app has it.
  static var granted: Bool {
    guard let file = FileHandle(forReadingAtPath: guarded.path) else { return false }
    try? file.close()
    return true
  }

  /// Opens its list in System Settings, where the person turns Sidebots on.
  static func open() {
    NSWorkspace.shared.open(settings)
  }
}
