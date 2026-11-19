import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useCameraPermissions } from "expo-camera";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronLeft, Link } from "lucide-react-native";
import { CameraPreview } from "@/components/CameraPreview";
import { FadingText } from "@/components/FadingText";
import { IconButton } from "@/components/IconButton";
import { keepPairing, readPairingLink, requestPairing } from "@/lib/api";
import { haptics } from "@/lib/haptics";
import { useWindowControls } from "@/lib/layout";
import { useTheme } from "@/lib/theme";

const NOT_A_CODE = "That isn't a Sidebots pairing code.";
// How long the computer's name stays up before the agents take the screen.
const PAIRED_MS = 1200;
// How long before a code the camera still sees is tried again.
const RETRY_MS = 3000;

/**
 * The scanner, opened from the welcome screen and laid out as the chat's
 * camera: the preview on black, reading the code Sidebots shows on the computer,
 * with one line under it that says what to do or what went wrong. Back, above
 * the preview, returns to the welcome screen. The link button beside it asks
 * for the code as its link instead, in the system's own prompt. When the
 * camera is refused, a button in its place opens Settings. A pairing link
 * opened anywhere on the phone lands here and pairs the same way. Once
 * paired, the line names the computer, and the agents take the screen.
 */
export default function Pair() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const controls = useWindowControls();
  const opened = useLocalSearchParams<{ host?: string; code?: string }>();
  const [permission, askForCamera] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [machine, setMachine] = useState<string | null>(null);
  // The camera reports the code it sees many times a second, and each code is tried once in a while.
  const tried = useRef<string | null>(null);

  async function pair(target: { host: string; code: string } | null) {
    if (busy || machine) return;
    if (!target) return setError(NOT_A_CODE);
    setBusy(true);
    setError(null);
    try {
      const pairing = await requestPairing(target);
      haptics.paired();
      setMachine(pairing.machine);
      setTimeout(() => keepPairing(pairing), PAIRED_MS);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function scanned(data: string) {
    if (data === tried.current) return;
    tried.current = data;
    setTimeout(() => {
      if (tried.current === data) tried.current = null;
    }, RETRY_MS);
    void pair(readPairingLink(data));
  }

  function enterLink() {
    Alert.prompt(
      "Enter a link",
      "Paste the link under the code on your computer.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Pair", isPreferred: true, onPress: (link?: string) => void pair(readPairingLink(link ?? "")) },
      ],
      "plain-text",
      "",
      "url",
    );
  }

  useEffect(() => {
    if (opened.host && opened.code) void pair({ host: opened.host, code: opened.code });
    // A link pairs once, as it opens the app.
  }, [opened.host, opened.code]);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void askForCamera();
  }, [permission, askForCamera]);

  const noCamera = permission !== null && !permission.granted && !permission.canAskAgain;
  const prompt = noCamera
    ? "Allow Sidebots to use the camera in Settings to scan the code on your computer, or enter its link."
    : "Scan the code Sidebots shows on your computer.";
  const line = machine ? `Paired with ${machine}` : (error ?? prompt);

  return (
    <View style={[styles.screen, { backgroundColor: theme.viewer, paddingBottom: insets.bottom + 12 }]}>
      <View style={[styles.bar, { paddingTop: insets.top + 8, marginLeft: controls }]}>
        <IconButton icon={ChevronLeft} label="Back" variant="overlay" size={40} iconSize={22} disabled={busy || machine !== null} onPress={() => router.back()} />
        <IconButton icon={Link} label="Enter a link instead" variant="overlay" size={40} iconSize={19} disabled={busy || machine !== null} onPress={enterLink} />
      </View>
      <View style={styles.stage}>
        {permission?.granted ? (
          <CameraPreview backdrop={theme.viewerControl} onScanned={scanned}>
            {busy ? <ActivityIndicator style={StyleSheet.absoluteFill} color={theme.viewerInk} /> : null}
          </CameraPreview>
        ) : noCamera ? (
          <View style={styles.refused}>
            <Pressable
              onPress={() => void Linking.openSettings()}
              accessibilityRole="button"
              style={({ pressed }) => [styles.settings, { backgroundColor: theme.viewerInk, opacity: pressed ? 0.85 : 1 }]}>
              <Text style={[styles.settingsText, { color: theme.viewer }]}>Open Settings</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      {/* Room for two lines, so the preview keeps its size whatever the line says. */}
      <View style={styles.notice}>
        <FadingText style={[styles.line, { color: theme.viewerInk }]}>{line}</FadingText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 12 },
  stage: { flex: 1, paddingHorizontal: 12 },
  refused: { flex: 1, alignItems: "center", justifyContent: "center" },
  settings: { minHeight: 48, paddingHorizontal: 20, borderRadius: 999, justifyContent: "center" },
  settingsText: { fontSize: 16, fontWeight: "600" },
  notice: { minHeight: 72, justifyContent: "center", paddingHorizontal: 24, paddingTop: 12 },
  line: { textAlign: "center", fontSize: 15, lineHeight: 20 },
});
