import { useEffect } from "react";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { usePaired } from "@/lib/api";
import { startSync } from "@/lib/state";
import { useTheme } from "@/lib/theme";

export default function Layout() {
  const theme = useTheme();
  const paired = usePaired();
  useEffect(startSync, []);

  const base = theme.dark ? DarkTheme : DefaultTheme;
  const navigation = {
    ...base,
    colors: { ...base.colors, primary: theme.tintInk, background: theme.bg, card: theme.bg, text: theme.ink, border: theme.line },
  };

  // No screen has a title bar. Each one floats its own controls over its content.
  // The gesture root is what lets a row and a message follow a swipe.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ThemeProvider value={navigation}>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false }}>
            {/* A phone that hasn't paired with a computer has the welcome and pairing screens and nothing else, and opens on welcome. Once paired, it has everything but those. */}
            <Stack.Protected guard={paired} redirectTo="/welcome">
              <Stack.Screen name="index" />
              <Stack.Screen name="chat/[id]" />
              <Stack.Screen name="new-agent" options={{ presentation: "formSheet", sheetAllowedDetents: [0.62], sheetGrabberVisible: true }} />
              {/* An agent's page, and a note opened from it, each a sheet over what is behind. */}
              <Stack.Screen name="agent/[id]" options={{ presentation: "modal" }} />
              <Stack.Screen name="note" options={{ presentation: "modal" }} />
              <Stack.Screen
                name="camera"
                // Full screen and a quick fade, so the camera is up the moment it's chosen. The status bar is light on its black.
                options={{ presentation: "fullScreenModal", animation: "fade", animationDuration: 150, contentStyle: { backgroundColor: theme.viewer }, statusBarStyle: "light" }}
              />
            </Stack.Protected>
            <Stack.Protected guard={!paired}>
              <Stack.Screen name="(unpaired)" options={{ animation: "fade" }} />
            </Stack.Protected>
          </Stack>
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
