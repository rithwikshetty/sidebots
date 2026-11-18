import ActivityKit
import SwiftUI
import WidgetKit

@main
struct ActivityWidgets: WidgetBundle {
  var body: some Widget {
    AgentActivity()
  }
}

/// A working agent on the Lock Screen and in the Dynamic Island: its avatar
/// in the pose for its state, its name, a line under it, and how long the
/// activity has been up. iOS redraws a Live Activity only when its state
/// changes, so the avatar holds one pose for each state, and the time is the
/// system's own running clock.
struct AgentActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: AgentActivityAttributes.self) { context in
      HStack(spacing: 12) {
        Avatar(context: context, width: 48)
        Words(context: context)
        Spacer(minLength: 8)
        Elapsed(context: context, width: 76).font(.title3)
      }
      .padding(16)
      .widgetURL(context.attributes.url)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Avatar(context: context, width: 44).padding(.leading, 6)
        }
        DynamicIslandExpandedRegion(.center) {
          Words(context: context)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Elapsed(context: context, width: 76).font(.title3).padding(.trailing, 6)
        }
      } compactLeading: {
        Avatar(context: context, width: 22)
      } compactTrailing: {
        Elapsed(context: context, width: 44).font(.caption)
      } minimal: {
        Avatar(context: context, width: 20)
      }
      .widgetURL(context.attributes.url)
    }
  }
}

/// The avatar's picture for the activity's state. Its pixels stay square at any size.
private struct Avatar: View {
  let context: ActivityViewContext<AgentActivityAttributes>
  let width: CGFloat

  var body: some View {
    let state = context.state.state
    if let data = context.attributes.poses[state] ?? context.attributes.poses["working"], let pose = UIImage(data: data) {
      Image(uiImage: pose)
        .interpolation(.none)
        .resizable()
        .aspectRatio(contentMode: .fit)
        .frame(width: width)
        .id(state)
        .transition(.scale(scale: 0.8).combined(with: .opacity))
        .accessibilityHidden(true)
    }
  }
}

/// The agent's name over the line for its state.
private struct Words: View {
  let context: ActivityViewContext<AgentActivityAttributes>

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(context.attributes.name).font(.headline).lineLimit(1)
      if let line = context.attributes.lines[context.state.state] {
        Text(line).font(.subheadline).foregroundStyle(.secondary).lineLimit(1).contentTransition(.opacity)
      }
    }
  }
}

/// How long the activity has been up, counting by itself. It goes when the
/// work ends. A running clock takes all the width it is offered, so it is
/// given `width`, which leaves the rest to the words beside it.
private struct Elapsed: View {
  let context: ActivityViewContext<AgentActivityAttributes>
  let width: CGFloat

  var body: some View {
    if context.state.state == "working" {
      Text(context.attributes.startedAt, style: .timer)
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .multilineTextAlignment(.trailing)
        .frame(width: width, alignment: .trailing)
        .foregroundStyle(.secondary)
        .accessibilityLabel("Working")
    }
  }
}
