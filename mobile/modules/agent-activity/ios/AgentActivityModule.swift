import ActivityKit
import ExpoModulesCore
import UIKit

final class UnreadableSheetException: Exception, @unchecked Sendable {
  override var reason: String { "The avatar's spritesheet couldn't be read." }
}

/// What the app starts an agent's Live Activity with. `sheet` is the path of
/// the avatar's spritesheet on the phone, `poses` says where each state's
/// picture is in it, as x, y, width and height, and `pixel` is how many of the
/// sheet's pixels make one pixel of the drawing.
struct Shown: Record {
  @Field var agentId: String = ""
  @Field var name: String = ""
  @Field var url: String = ""
  @Field var lines: [String: String] = [:]
  @Field var sheet: String = ""
  @Field var poses: [String: [Double]] = [:]
  @Field var pixel: Double = 1
}

/// The Live Activities that show working agents, one for each agent. The app
/// starts one while it is in front, which is the only time iOS allows it, and
/// hears the token Apple's push service takes its updates under in `onToken`.
/// An activity outlives the app, so the app hears of the ones it finds running
/// when it starts listening too. The widget in targets/activity draws it.
public final class AgentActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AgentActivity")

    Events("onToken")

    OnStartObserving("onToken") {
      for activity in Activity<AgentActivityAttributes>.activities where activity.activityState == .active {
        self.hear(activity)
      }
    }

    Function("isAvailable") { () -> Bool in
      ActivityAuthorizationInfo().areActivitiesEnabled
    }

    Function("shown") { () -> [[String: Any]] in
      Activity<AgentActivityAttributes>.activities.map { ["agentId": $0.attributes.agentId, "live": $0.activityState == .active] as [String: Any] }
    }

    AsyncFunction("start") { (agent: Shown) async throws in
      // An activity that ended on the agent's last reply may still be on the Lock Screen.
      await Self.end(agent.agentId)
      guard let sheet = UIImage(contentsOfFile: agent.sheet)?.cgImage, let url = URL(string: agent.url) else { throw UnreadableSheetException() }
      let attributes = AgentActivityAttributes(
        agentId: agent.agentId,
        name: agent.name,
        url: url,
        startedAt: Date(),
        poses: agent.poses.compactMapValues { Self.pose(sheet, $0, pixel: agent.pixel) },
        lines: agent.lines
      )
      let working = ActivityContent(state: AgentActivityAttributes.ContentState(state: "working"), staleDate: nil)
      self.hear(try Activity.request(attributes: attributes, content: working, pushType: .token))
    }

    AsyncFunction("end") { (agentId: String) async in
      await Self.end(agentId)
    }
  }

  /// Sends the app the activity's token: the one it has, and each one Apple
  /// gives it after. Apple gives the first a moment after the activity starts,
  /// and may change it while the activity lasts.
  private func hear(_ activity: Activity<AgentActivityAttributes>) {
    let agentId = activity.attributes.agentId
    let tell = { [weak self] (token: Data) in
      self?.sendEvent("onToken", ["agentId": agentId, "token": token.map { String(format: "%02x", $0) }.joined()])
    }
    Task {
      if let token = activity.pushToken { tell(token) }
      for await token in activity.pushTokenUpdates { tell(token) }
    }
  }

  /// Takes the agent's activity off the Lock Screen and out of the Dynamic Island.
  private static func end(_ agentId: String) async {
    for activity in Activity<AgentActivityAttributes>.activities where activity.attributes.agentId == agentId {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }

  /// The part of the sheet at `rect`, as a PNG with one pixel for each pixel
  /// of the drawing. An activity holds 4 KB at most, and a pose this small
  /// takes a few hundred bytes of it.
  private static func pose(_ sheet: CGImage, _ rect: [Double], pixel: Double) -> Data? {
    guard rect.count == 4, pixel > 0, let cell = sheet.cropping(to: CGRect(x: rect[0], y: rect[1], width: rect[2], height: rect[3])) else { return nil }
    let size = CGSize(width: rect[2] / pixel, height: rect[3] / pixel)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: size, format: format).pngData { context in
      context.cgContext.interpolationQuality = .none
      UIImage(cgImage: cell).draw(in: CGRect(origin: .zero, size: size))
    }
  }
}
