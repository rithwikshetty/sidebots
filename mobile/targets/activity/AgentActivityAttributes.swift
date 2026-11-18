import ActivityKit
import Foundation

/// A working agent's Live Activity. The app sets everything that stays the
/// same when it starts the activity, so none of it leaves the phone: the
/// agent, its name, its avatar's picture and the line under its name for each
/// state, what a tap opens, and when the activity began. Only the state changes,
/// and it is all a push from the computer carries.
///
/// The app's module in modules/agent-activity builds this file too, since iOS
/// matches the activity the app starts to the one the widget draws by this
/// type's name and fields.
struct AgentActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// One of the avatar's states: `working`, then `replied`, `failed` or `resting` as the activity ends.
    var state: String
  }

  var agentId: String
  var name: String
  var url: URL
  var startedAt: Date
  /// The avatar in each state, as a PNG with one pixel for each pixel of its drawing.
  var poses: [String: Data]
  var lines: [String: String]
}
