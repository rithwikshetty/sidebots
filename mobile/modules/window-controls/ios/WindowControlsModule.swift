import ExpoModulesCore
import UIKit

public final class WindowControlsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WindowControls")

    View(WindowControlsRoomView.self) {
      Events("onRoom")
    }
  }
}

/// Laid along the strip under the status bar where a screen's top buttons
/// sit, says how much room iPadOS's window controls take at its leading end,
/// past the safe area: the buttons that close, shrink and arrange an app's
/// window in iPadOS 26 and later. iOS gives that room as the safe area
/// adapted to the window's corners, which also clears the screen's rounded
/// corners, so the strip starts below the status bar, where those corners
/// don't reach. It is nothing on an iPhone, for an iPad app in full screen,
/// and before iOS 26.
/// It tells the room again whenever it changes, as the window is resized or
/// the controls come and go.
final class WindowControlsRoomView: ExpoView {
  let onRoom = EventDispatcher()
  private var told: CGFloat?

  override func layoutSubviews() {
    super.layoutSubviews()
    tell()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    tell()
  }

  private func tell() {
    guard window != nil else { return }
    var room: CGFloat = 0
    if #available(iOS 26.0, *) {
      let adapted = directionalEdgeInsets(for: .safeArea(cornerAdaptation: .horizontal)).leading
      room = max(0, adapted - directionalEdgeInsets(for: .safeArea()).leading)
    }
    guard room != told else { return }
    told = room
    onRoom(["leading": room])
  }
}
