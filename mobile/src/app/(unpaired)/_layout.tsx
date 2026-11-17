import { Stack } from "expo-router";

// Welcome is always the first screen, even under the scanner when a pairing link opens it.
export const unstable_settings = { anchor: "welcome" };

/** What a phone that hasn't paired with a computer has: the welcome screen, and the scanner it opens. */
export default function Unpaired() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      {/* The scanner is black in either mode, so its status bar is light. */}
      <Stack.Screen name="pair" options={{ statusBarStyle: "light" }} />
    </Stack>
  );
}
