import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { AvatarPicker } from "@/components/AvatarPicker";
import { FadingText } from "@/components/FadingText";
import { createAgent, useAvatars } from "@/lib/state";
import { useTheme } from "@/lib/theme";

/** A stable number from a name, so a name always suggests the same avatar. */
function hash(text: string): number {
  let sum = 0;
  for (const letter of text) sum = (sum * 31 + letter.charCodeAt(0)) >>> 0;
  return sum;
}

export default function NewAgent() {
  const theme = useTheme();
  const router = useRouter();
  const avatars = useAvatars();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();
  // Until the person picks, the name suggests an avatar.
  const avatarId = picked ?? avatars[hash(trimmed) % Math.max(avatars.length, 1)]?.id;

  async function onCreate() {
    if (!trimmed || !avatarId) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await createAgent(trimmed, avatarId);
      router.dismiss();
      router.push(`/chat/${agent.id}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <View style={[styles.sheet, { backgroundColor: theme.bg }]}>
      <Text style={[styles.title, { color: theme.ink }]}>New agent</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Name"
        placeholderTextColor={theme.ink2}
        autoFocus
        maxLength={24}
        returnKeyType="done"
        onSubmitEditing={onCreate}
        style={[styles.name, { color: theme.ink, borderBottomColor: theme.line }]}
      />
      <AvatarPicker value={avatarId} onChange={setPicked} />
      <FadingText style={[styles.hint, { color: error ? theme.danger : theme.ink2 }]}>{error ?? "Tell it what it's for in the chat."}</FadingText>
      <Pressable
        onPress={onCreate}
        disabled={busy || !trimmed || !avatarId}
        style={({ pressed }) => [styles.button, { backgroundColor: theme.tint, opacity: pressed || busy || !trimmed ? 0.5 : 1 }]}>
        {busy ? <ActivityIndicator color={theme.onTint} /> : <Text style={[styles.buttonText, { color: theme.onTint }]}>Create agent</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, paddingHorizontal: 24, paddingTop: 28, gap: 16 },
  title: { fontSize: 17, fontWeight: "600", textAlign: "center" },
  name: { fontSize: 26, fontWeight: "700", textAlign: "center", paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  hint: { fontSize: 15, textAlign: "center" },
  button: { height: 50, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 17, fontWeight: "600" },
});
