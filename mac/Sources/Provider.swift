import Foundation

/// A program the agents run on, as the app sets a person up on it: the app's
/// words for it, and how its sign-in reads. Each is known to the server by
/// its raw value. The app carries neither program. The server finds the one
/// the person installed.
enum Provider: String, CaseIterable, Identifiable {
  case claude, codex

  var id: String { rawValue }

  /// The provider's name, as the server has it.
  var name: String { self == .claude ? "Claude Code" : "Codex" }

  /// What it is, for a person choosing between the two.
  var summary: String {
    self == .claude ? "Anthropic's Claude, on a Claude plan or an API key." : "OpenAI's models, on a ChatGPT plan or an API key."
  }

  /// Who makes it, publishes its installer and bills an API key for it.
  var maker: String { self == .claude ? "Anthropic" : "OpenAI" }

  /// What the person signs in to for it, whose plan their agents then use.
  var account: String { self == .claude ? "Claude" : "ChatGPT" }

  /// The plans that sign-in is for.
  var plans: String { self == .claude ? "Pro or Max" : "Plus or Pro" }

  /// Where a key is made, as a link in Markdown.
  var keyPage: String {
    self == .claude ? "[Claude Console](https://platform.claude.com/settings/keys)" : "[OpenAI Platform](https://platform.openai.com/api-keys)"
  }

  /// How a key starts.
  var keyStart: String { self == .claude ? "sk-ant-…" : "sk-…" }

  /// The words its sign-in prints just before the address of its sign-in page.
  var pageFollows: String { self == .claude ? "visit:" : "authenticate:" }

  /// Whether the sign-in page can show a code for the person to paste, which the sign-in then reads.
  var takesCode: Bool { self == .claude }
}
