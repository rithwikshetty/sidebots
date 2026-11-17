import ExpoModulesCore
import UIKit
import UIKit.UIGestureRecognizerSubclass

public final class SideMenuSwipeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SideMenuSwipe")

    View(ScrollWaitsForMenuSwipeView.self) {}
  }
}

/// Placed inside a scrolling list, makes the list's scroll wait until the
/// side menu's swipe has decided, as a list waits for iOS's back swipe.
/// iOS gives a touch to whichever gesture starts first, and a list starts
/// scrolling a few points into any drag with some up or down in it, before a
/// diagonal swipe right has gone far enough for the menu. Waiting lets the
/// menu's swipe judge the direction first: when it lets go, the list scrolls
/// from where the finger is.
///
/// The menu's swipe is the nearest gesture-handler pan on a view that holds
/// the list: a pan recognizer whose delegate is gesture-handler's
/// `RNPanGestureHandler`. Gesture-handler attaches it after the views are on
/// screen, and may attach a new one, so the list looks for it again whenever
/// a finger comes down.
final class ScrollWaitsForMenuSwipeView: ExpoView {
  private weak var list: UIScrollView?
  private weak var linkedSwipe: UIGestureRecognizer?
  private lazy var touchDown = TouchDownRecognizer { [weak self] in self?.link() }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else { return }
    var ancestor = superview
    while let view = ancestor {
      if let scrollView = view as? UIScrollView {
        if scrollView !== list {
          touchDown.view?.removeGestureRecognizer(touchDown)
          scrollView.addGestureRecognizer(touchDown)
          list = scrollView
        }
        break
      }
      ancestor = view.superview
    }
    link()
  }

  private func link() {
    guard let list else { return }
    var ancestor = list.superview
    while let view = ancestor {
      if let swipe = view.gestureRecognizers?.first(where: Self.isMenuSwipe) {
        if swipe !== linkedSwipe {
          list.panGestureRecognizer.require(toFail: swipe)
          linkedSwipe = swipe
        }
        return
      }
      ancestor = view.superview
    }
  }

  private static let panHandler: AnyClass? = NSClassFromString("RNPanGestureHandler")

  private static func isMenuSwipe(_ recognizer: UIGestureRecognizer) -> Bool {
    guard recognizer is UIPanGestureRecognizer, let panHandler, let handler = recognizer.delegate as? NSObject else {
      return false
    }
    return handler.isKind(of: panHandler)
  }
}

/// Says when a finger comes down on its view, then steps aside without
/// holding or cancelling the touch.
private final class TouchDownRecognizer: UIGestureRecognizer {
  private let onTouchDown: () -> Void

  init(onTouchDown: @escaping () -> Void) {
    self.onTouchDown = onTouchDown
    super.init(target: nil, action: nil)
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    onTouchDown()
    state = .failed
  }
}
