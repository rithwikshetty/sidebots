import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { PROVIDERS, type Provider } from "@server/contract";
import { AvatarPicker } from "@/components/AvatarPicker";
import { Choices } from "@/components/Choices";
import { FadingText } from "@/components/FadingText";
import { createAgent, loadUsage, useAvatars, useUsage } from "@/lib/state";
import { useTheme } from "@/lib/theme";

/** A stable number from a name, so a name always suggests the same avatar. */
function hash(text: string): number {
  let sum = 0;
  for (const letter of text) sum = (sum * 31 + letter.charCodeAt(0)) >>> 0;
  return sum;
}

/**
 * The sheet for a new agent: its name, its avatar, and Create agent. A person
 * who has set up more than one provider on their computer also picks the one
 * it runs on, which starts as the first they set up. The keyboard covers the
 * sheet's lower part, so the sheet scrolls up from behind it when large text
 * doesn't fit, which keeps Create agent in reach.
 */
export default function NewAgent() {
  const theme = useTheme();
  const router = useRouter();
  const avatars = useAvatars();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  // The providers the person has set up, which the computer lists with how each is signed in to.
  const providers = (useUsage()?.accounts ?? []).map((account) => account.provider);
  const [chosen, setChosen] = useState<Provider | null>(null);
  const provider = chosen ?? providers[0];
  useEffect(() => {
    loadUsage().catch(() => {});
  }, []);
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
      const agent = await createAgent(trimmed, avatarId, provider);
      router.dismiss();
      router.push(`/chat/${agent.id}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={styles.page}
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled">
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
      {providers.length > 1 ? (
        <View style={[styles.providers, { backgroundColor: theme.field }]}>
          <Choices options={Object.fromEntries(providers.map((id) => [id, PROVIDERS[id].name]))} value={provider} onChange={setChosen} />
        </View>
      ) : null}
      <FadingText style={[styles.hint, { color: error ? theme.danger : theme.ink2 }]}>{error ?? "Tell it what it's for in the chat."}</FadingText>
      <Pressable
        onPress={onCreate}
        disabled={busy || !trimmed || !avatarId}
        style={({ pressed }) => [styles.button, { backgroundColor: theme.tint, opacity: pressed || busy || !trimmed ? 0.5 : 1 }]}>
        {busy ? <ActivityIndicator color={theme.onTint} /> : <Text style={[styles.buttonText, { color: theme.onTint }]}>Create agent</Text>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 24, paddingTop: 28, paddingBottom: 24, gap: 16 },
  title: { fontSize: 17, fontWeight: "600", textAlign: "center" },
  name: { fontSize: 26, fontWeight: "700", textAlign: "center", paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  providers: { borderRadius: 16, borderCurve: "continuous" },
  hint: { fontSize: 15, textAlign: "center" },
  button: { minHeight: 50, borderRadius: 14, alignItems: "center", justifyContent: "center", paddingVertical: 12 },
  buttonText: { fontSize: 17, fontWeight: "600" },
});
