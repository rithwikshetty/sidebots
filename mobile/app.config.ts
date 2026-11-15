import type { ExpoConfig } from "expo/config";

// The Apple team and app identifier are personal, so they come from .env.local.
const identifier = process.env.SIMON_BUNDLE_ID ?? "com.example.simon";
const MICROPHONE_PERMISSION = "Simon listens while you dictate a message, and turns what you say into text on your phone.";

const config: ExpoConfig = {
  name: "Simon",
  slug: "simon",
  version: "1.0.0",
  scheme: "simon",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  ios: {
    supportsTablet: false,
    bundleIdentifier: identifier,
    appleTeamId: process.env.SIMON_APPLE_TEAM_ID,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
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
    // Adds the entitlement that lets Apple's push service deliver to the app, and the sound a notification plays.
    ["expo-notifications", { sounds: ["./assets/sounds/simon.wav"] }],
    // The words the phone shows when it asks for the photos, the camera and the microphone.
    [
      "expo-image-picker",
      {
        photosPermission: "Simon opens the photos you choose so you can send them to an agent.",
        cameraPermission: "Simon uses the camera so you can send a photo to an agent.",
        // The same words as expo-audio's, which this plugin would otherwise remove.
        microphonePermission: MICROPHONE_PERMISSION,
      },
    ],
    // Records what you say for dictation, which Apple's speech model turns into text on the phone.
    ["expo-audio", { microphonePermission: MICROPHONE_PERMISSION, recordAudioAndroid: false }],
    "expo-document-picker",
    "expo-web-browser",
  ],
  experiments: { typedRoutes: true },
};

export default config;
