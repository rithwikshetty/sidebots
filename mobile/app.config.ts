import type { ExpoConfig } from "expo/config";

// The Apple team and app identifier are personal, so they come from .env.local.
const identifier = process.env.SIMON_BUNDLE_ID ?? "com.example.simon";

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
  plugins: ["expo-router", "expo-status-bar", "expo-sqlite", "expo-image"],
  experiments: { typedRoutes: true },
};

export default config;
