import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { SetupButton, SetupPage } from "@/components/SetupPage";
import { wasRemoved } from "@/lib/api";
import { useTheme } from "@/lib/theme";

const ICON = 96;
const STEP = 26;
// A step's number fits its round mark up to this text size.
const NUMBER_MAX_SCALE = 1.3;

/**
 * What a phone that hasn't paired with a computer opens on: what Sidebots is, and
 * the two steps to pair, getting Sidebots for the computer and scanning the code its
 * Pair a phone shows. Its one button opens the scanner, which is when the phone asks for
 * the camera. A phone the computer removed says so here.
 */
export default function Welcome() {
  const theme = useTheme();
  const router = useRouter();
  return (
    <SetupPage
      art={<Image source={require("../../../assets/icon.png")} style={styles.icon} accessibilityIgnoresInvertColors />}
      title="Sidebots"
      lead="Your own agents, on your own computer. Give one a job, and it tells you when it's done."
      actions={<SetupButton onPress={() => router.push("/pair")}>Scan the code</SetupButton>}>
      <View style={[styles.card, { backgroundColor: theme.field }]}>
        <Step number={1}>
          Get Sidebots for your computer from <Text style={[styles.strong, { color: theme.ink }]}>sidebots.app</Text>, and open it.
        </Step>
        <View style={[styles.rule, { backgroundColor: theme.line }]} />
        <Step number={2}>
          Choose <Text style={[styles.strong, { color: theme.ink }]}>Pair a phone</Text> in its Settings, and scan the code.
        </Step>
      </View>
      {wasRemoved() ? <Text style={[styles.removed, { color: theme.danger }]}>Your computer removed this phone. Scan a new code to pair again.</Text> : null}
    </SetupPage>
  );
}

/** One step of pairing: its number in a round mark, and what to do. */
function Step({ number, children }: { number: number; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.step}>
      <View style={[styles.number, { backgroundColor: theme.tint }]}>
        <Text maxFontSizeMultiplier={NUMBER_MAX_SCALE} style={[styles.numberText, { color: theme.onTint }]}>{number}</Text>
      </View>
      <Text style={[styles.stepText, { color: theme.ink }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  icon: { width: ICON, height: ICON, borderRadius: ICON * 0.225, borderCurve: "continuous" },
  card: { borderRadius: 16, borderCurve: "continuous", marginTop: 32 },
  step: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  number: { width: STEP, height: STEP, borderRadius: STEP / 2, alignItems: "center", justifyContent: "center" },
  numberText: { fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
  stepText: { flex: 1, fontSize: 16, lineHeight: 21 },
  strong: { fontWeight: "600" },
  rule: { height: StyleSheet.hairlineWidth, marginLeft: 16 + STEP + 14 },
  removed: { fontSize: 15, lineHeight: 20, textAlign: "center", marginTop: 20 },
});
