import type { ExpoConfig } from "expo/config";

// The Apple team and app identifier are personal, so they come from .env.local.
// A development build, with APP_VARIANT=development, is an app of its own
// beside the published one: its identifier ends in .dev, and it has its own
// name and icon, with a "DEV" tag.
const development = process.env.APP_VARIANT === "development";
const identifier = `${process.env.SIDEBOTS_BUNDLE_ID ?? "com.example.sidebots"}${development ? ".dev" : ""}`;
const MICROPHONE_PERMISSION = "Sidebots listens while you dictate a message, and turns what you say into text on your phone.";

const config: ExpoConfig = {
  name: development ? "Sidebots Dev" : "Sidebots",
  slug: "sidebots",
  version: "1.0.1",
  scheme: development ? "sidebots-dev" : "sidebots",
  orientation: "portrait",
  icon: development ? "./assets/icon-dev.png" : "./assets/icon.png",
  userInterfaceStyle: "automatic",
  ios: {
    // A native iPad app. `orientation` above keeps the iPhone upright; for the
    // iPad, Expo lists all four orientations under
    // UISupportedInterfaceOrientations~ipad, as iPadOS needs for windows it
    // can resize.
    supportsTablet: true,
    bundleIdentifier: identifier,
    appleTeamId: process.env.SIDEBOTS_APPLE_TEAM_ID,
    // The oldest iOS the app runs on, and its extensions in targets/ with it.
    deploymentTarget: "18.0",
    // The app's build number, and its extensions'. testflight.sh sets it, since App Store Connect takes each number once.
    buildNumber: process.env.SIDEBOTS_BUILD_NUMBER,
    // A working agent shows as a Live Activity, which the widget in targets/activity draws.
    infoPlist: { ITSAppUsesNonExemptEncryption: false, NSSupportsLiveActivities: true },
    // The Keychain group the app shares with its notification extension, which reads the notification key from it.
    entitlements: { "keychain-access-groups": [`$(AppIdentifierPrefix)${identifier}`] },
  },
  android: {
    package: identifier,
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
  },
  plugins: [
    "expo-router",
    "expo-status-bar",
    "expo-sqlite",
    "expo-image",
    // Adds the entitlement that lets Apple's push service deliver to the app, the sound a notification plays, and the background mode in which iOS wakes the app for a push that shows nothing, as when a chat was read on another device.
    ["expo-notifications", { sounds: ["./assets/sounds/sidebots.wav"], enableBackgroundRemoteNotifications: true }],
    // The words the phone shows when it asks for the photos, the camera and the microphone.
    [
      "expo-image-picker",
      {
        photosPermission: "Sidebots opens the photos you choose so you can send them to an agent.",
        cameraPermission: "Sidebots uses the camera to scan the code on your computer, and so you can send a photo to an agent.",
        // The same words as expo-audio's, which this plugin would otherwise remove.
        microphonePermission: MICROPHONE_PERMISSION,
      },
    ],
    // Records what you say for dictation, which Apple's speech model turns into text on the phone.
    ["expo-audio", { microphonePermission: MICROPHONE_PERMISSION, recordAudioAndroid: false }],
    // Keeps the keys that prove this phone to its computer and open its notifications in the Keychain.
    "expo-secure-store",
    // Builds the native targets in targets/: the extension that opens each notification as it arrives, and the widget that draws a working agent's Live Activity.
    "@bacons/apple-targets",
    "expo-document-picker",
    "expo-web-browser",
  ],
  experiments: { typedRoutes: true },
};

export default config;
