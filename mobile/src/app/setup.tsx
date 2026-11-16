import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { FadingText } from "@/components/FadingText";
import { connect } from "@/lib/api";
import { startSync } from "@/lib/state";
import { useTheme } from "@/lib/theme";

export default function Setup() {
  const theme = useTheme();
  const router = useRouter();
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onConnect() {
    setBusy(true);
    setError(null);
    try {
      await connect(address);
      startSync();
      router.replace("/");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={[styles.screen, { backgroundColor: theme.bg }]}>
      <View style={styles.top}>
        <Text style={[styles.title, { color: theme.ink }]}>Sidebots</Text>
        <Text style={[styles.tag, { color: theme.ink2 }]}>Your agents, on your own machine.</Text>
      </View>
      <View style={styles.form}>
        <Text style={[styles.label, { color: theme.ink }]}>Server address</Text>
        <TextInput
          value={address}
          onChangeText={setAddress}
          placeholder="macbook.your-tailnet.ts.net"
          placeholderTextColor={theme.ink2}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={onConnect}
          style={[styles.field, { color: theme.ink, backgroundColor: theme.field, borderColor: theme.line }]}
        />
        <FadingText style={[styles.help, { color: error ? theme.danger : theme.ink2 }]}>
          {error ?? "The Tailscale name of the machine that runs Sidebots."}
        </FadingText>
        <Pressable
          onPress={onConnect}
          disabled={busy}
          style={({ pressed }) => [styles.button, { backgroundColor: theme.tint, opacity: pressed || busy ? 0.7 : 1 }]}>
          {busy ? <ActivityIndicator color={theme.onTint} /> : <Text style={[styles.buttonText, { color: theme.onTint }]}>Connect</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 24, justifyContent: "center" },
  top: { alignItems: "center", marginBottom: 56 },
  title: { fontSize: 44, fontWeight: "700", letterSpacing: 0.4 },
  tag: { fontSize: 17, marginTop: 10 },
  form: { gap: 8 },
  label: { fontSize: 15, fontWeight: "600" },
  field: { height: 50, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, fontSize: 17 },
  help: { fontSize: 14, lineHeight: 19, marginBottom: 10 },
  button: { height: 50, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 17, fontWeight: "600" },
});
