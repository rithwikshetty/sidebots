// The widget extension, which draws an agent's Live Activity on the Lock
// Screen and in the Dynamic Island. It draws from what the app gave the
// activity when it started it, so it needs nothing the app holds.

/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "widget",
  bundleIdentifier: ".activity",
  deploymentTarget: "16.4",
  frameworks: ["SwiftUI", "WidgetKit", "ActivityKit"],
};
