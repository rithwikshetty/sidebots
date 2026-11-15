import { useEffect } from "react";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { startSync } from "@/lib/state";
import { useTheme } from "@/lib/theme";

export default function Layout() {
  const theme = useTheme();
  useEffect(startSync, []);

  const base = theme.dark ? DarkTheme : DefaultTheme;
  const navigation = {
    ...base,
    colors: { ...base.colors, primary: theme.tintInk, background: theme.bg, card: theme.bg, text: theme.ink, border: theme.line },
  };

  // No screen has a title bar. Each one floats its own controls over its content.
  return (
    <KeyboardProvider>
      <ThemeProvider value={navigation}>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="setup" options={{ animation: "none" }} />
          <Stack.Screen name="chat/[id]" />
          <Stack.Screen name="new-agent" options={{ presentation: "formSheet", sheetAllowedDetents: [0.62], sheetGrabberVisible: true }} />
        </Stack>
      </ThemeProvider>
    </KeyboardProvider>
  );
}
