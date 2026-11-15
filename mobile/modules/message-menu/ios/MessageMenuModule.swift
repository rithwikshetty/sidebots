import ExpoModulesCore
import UIKit

struct MessageMenuAction: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var systemImage: String?
  @Field var subtitle: String?
  @Field var checked: Bool = false
  @Field var disabled: Bool = false
  @Field var destructive: Bool = false
  @Field var children: [MessageMenuAction]?
  @Field var group: String?
}

public final class MessageMenuModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MessageMenu")

    View(MessageMenuView.self) {
      Events("onAction")

      Prop("actions") { (view, actions: [MessageMenuAction]) in
        view.actions = actions
      }

      Prop("opensOnTap") { (view, opensOnTap: Bool?) in
        view.opensOnTap = opensOnTap ?? false
      }

      Prop("label") { (view, label: String?) in
        view.label = label
      }

      Prop("immediate") { (view, immediate: Bool?) in
        view.immediate = immediate ?? false
      }
    }
  }
}

/// Holds a message's views and opens the system context menu on a long press,
/// lifting the message above the menu as iOS does for any other app. A
/// message too tall to sit beside the menu stays where it is, and the menu
/// opens at the finger. With `opensOnTap` it opens the menu from a tap
/// instead, as a menu button does, for a control such as the composer's +.
final class MessageMenuView: ExpoView, UIContextMenuInteractionDelegate {
  let onAction = EventDispatcher()
  var actions: [MessageMenuAction] = [] {
    didSet {
      tapButton?.menu = makeMenu()
      // With nothing to offer, the button rests.
      tapButton?.isEnabled = !actions.isEmpty
    }
  }
  var opensOnTap = false {
    didSet { if opensOnTap != oldValue { updateTrigger() } }
  }
  var label: String? {
    didSet { tapButton?.accessibilityLabel = label }
  }
  /// Reports a choice as it is made, for a menu whose actions present nothing.
  var immediate = false
  // The chosen action is reported once the menu has gone, so an action that
  // presents something, such as the share sheet, is not refused by iOS.
  private var chosenActionId: String?
  private var menuDismissed = false
  private lazy var longPress = UIContextMenuInteraction(delegate: self)
  private var pressLocation: CGPoint = .zero
  private var preview: UITargetedPreview?
  // The tallest a message is lifted, as a share of the screen: room is left for the menu.
  private static let liftedShare: CGFloat = 0.4
  private var tapButton: MenuButton?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    addInteraction(longPress)
  }

  /// A long press lifts the view into a context menu; a tap opens a menu
  /// from a clear button laid over the view, which iOS draws as a menu button.
  private func updateTrigger() {
    if opensOnTap {
      removeInteraction(longPress)
      let button = MenuButton(type: .custom)
      button.showsMenuAsPrimaryAction = true
      // The menu reads top to bottom as listed, wherever it opens.
      button.preferredMenuElementOrder = .fixed
      button.accessibilityLabel = label
      button.menu = makeMenu()
      button.isEnabled = !actions.isEmpty
      button.onMenuWillShow = { [weak self] in self?.menuWillShow() }
      button.onMenuEnded = { [weak self] in self?.menuDidEnd() }
      addSubview(button)
      tapButton = button
      setNeedsLayout()
    } else {
      tapButton?.removeFromSuperview()
      tapButton = nil
      addInteraction(longPress)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let tapButton else { return }
    tapButton.frame = bounds
    bringSubviewToFront(tapButton)
  }

  override func didAddSubview(_ subview: UIView) {
    super.didAddSubview(subview)
    // The button stays over the views it opens the menu for.
    if let tapButton, subview !== tapButton { bringSubviewToFront(tapButton) }
  }

  private func makeMenu() -> UIMenu {
    UIMenu(children: elements(of: actions))
  }

  /// Runs of actions that share a group, each drawn between separators.
  private func elements(of actions: [MessageMenuAction]) -> [UIMenuElement] {
    var sections: [[MessageMenuAction]] = []
    for action in actions {
      if let last = sections.last?.last, last.group == action.group {
        sections[sections.count - 1].append(action)
      } else {
        sections.append([action])
      }
    }
    if sections.count == 1 { return actions.map(makeElement) }
    return sections.map { UIMenu(options: .displayInline, children: $0.map(makeElement)) }
  }

  /// An action, or a submenu when it holds actions of its own.
  private func makeElement(_ action: MessageMenuAction) -> UIMenuElement {
    let image = action.systemImage.flatMap { UIImage(systemName: $0) }
    if let children = action.children, !children.isEmpty {
      let menu = UIMenu(title: action.title, image: image, children: elements(of: children))
      menu.subtitle = action.subtitle
      return menu
    }
    let element = UIAction(title: action.title, subtitle: action.subtitle, image: image) { [weak self] _ in
      self?.choose(action.id)
    }
    element.state = action.checked ? .on : .off
    if action.disabled { element.attributes.insert(.disabled) }
    if action.destructive { element.attributes.insert(.destructive) }
    return element
  }

  private func choose(_ id: String) {
    if immediate {
      DispatchQueue.main.async { [weak self] in self?.onAction(["id": id]) }
      return
    }
    chosenActionId = id
    reportChosenAction()
  }

  private func menuWillShow() {
    chosenActionId = nil
    menuDismissed = false
  }

  private func menuDidEnd() {
    menuDismissed = true
    // The lifted message holds this view, so it is let go with the menu.
    preview = nil
    reportChosenAction()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { preview = nil }
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard !actions.isEmpty else { return nil }
    menuWillShow()
    pressLocation = location
    preview = nil
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      self?.makeMenu()
    }
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configuration: UIContextMenuConfiguration,
    highlightPreviewForItemWithIdentifier identifier: any NSCopying
  ) -> UITargetedPreview? {
    targetedPreview()
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configuration: UIContextMenuConfiguration,
    dismissalPreviewForItemWithIdentifier identifier: any NSCopying
  ) -> UITargetedPreview? {
    targetedPreview()
  }

  /// What the long press lifts, the same as the menu opens and closes: the
  /// whole message when it fits beside the menu, as a bubble in Messages is
  /// lifted. A taller message would have to shrink over the menu, so it stays
  /// in place and a clear point at the finger is the menu's source instead.
  private func targetedPreview() -> UITargetedPreview {
    if let preview { return preview }
    let made: UITargetedPreview
    if let window, bounds.height > window.bounds.height * Self.liftedShare {
      let anchor = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
      anchor.backgroundColor = .clear
      let parameters = UIPreviewParameters()
      parameters.backgroundColor = .clear
      parameters.shadowPath = UIBezierPath()
      parameters.visiblePath = UIBezierPath(rect: anchor.bounds)
      made = UITargetedPreview(view: anchor, parameters: parameters, target: UIPreviewTarget(container: self, center: pressLocation))
    } else {
      let parameters = UIPreviewParameters()
      parameters.backgroundColor = .systemBackground
      parameters.visiblePath = UIBezierPath(roundedRect: bounds.insetBy(dx: -8, dy: -6), cornerRadius: 16)
      made = UITargetedPreview(view: self, parameters: parameters)
    }
    preview = made
    return made
  }

  func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    willEndFor configuration: UIContextMenuConfiguration,
    animator: UIContextMenuInteractionAnimating?
  ) {
    if let animator {
      animator.addCompletion { [weak self] in self?.menuDidEnd() }
    } else {
      DispatchQueue.main.async { [weak self] in self?.menuDidEnd() }
    }
  }

  // UIKit may call an action before or after the menu finishes closing;
  // whichever comes second reports it, on the next turn, so a sheet the
  // action opens starts once the menu has gone.
  private func reportChosenAction() {
    guard menuDismissed, let id = chosenActionId else { return }
    chosenActionId = nil
    DispatchQueue.main.async { [weak self] in self?.onAction(["id": id]) }
  }
}

/// A clear menu button that says when its menu opens and when it has gone.
private final class MenuButton: UIButton {
  var onMenuWillShow: (() -> Void)?
  var onMenuEnded: (() -> Void)?

  override func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    willDisplayMenuFor configuration: UIContextMenuConfiguration,
    animator: UIContextMenuInteractionAnimating?
  ) {
    super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
    onMenuWillShow?()
  }

  override func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    willEndFor configuration: UIContextMenuConfiguration,
    animator: UIContextMenuInteractionAnimating?
  ) {
    super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
    if let animator {
      animator.addCompletion { [weak self] in self?.onMenuEnded?() }
    } else {
      DispatchQueue.main.async { [weak self] in self?.onMenuEnded?() }
    }
  }
}
