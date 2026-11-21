// The notification extension: the small program iOS runs when a notification
// arrives, before it shows. It reads the phone's notification key from the
// Keychain group it shares with the app, so it has the app's own entitlement.

/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "notification-service",
  bundleIdentifier: ".notifications",
  deploymentTarget: config.ios.deploymentTarget,
  frameworks: ["CryptoKit"],
  entitlements: { "keychain-access-groups": config.ios.entitlements["keychain-access-groups"] },
});
