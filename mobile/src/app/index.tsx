import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Plus } from "lucide-react-native";
import type { AgentWithLatest } from "@server/contract";
import { Glass } from "@/components/Glass";
import { PetView } from "@/components/PetView";
import { TopFade } from "@/components/TopFade";
import { serverUrl } from "@/lib/api";
import { useWorkingLine } from "@/lib/lines";
import { useAgents, useOnline, usePetState, useSeen } from "@/lib/state";
import { homeLine } from "@/lib/summary";
import { useTheme } from "@/lib/theme";
import { listTime } from "@/lib/time";

const ADD_BUTTON = 60;

/**
 * The home screen. It has no title bar: the top line says what most needs the
 * person right now, the agents follow, and the button for a new agent floats
 * at the bottom right, where a thumb reaches it.
 */
export default function Home() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const agents = useAgents();
  const seen = useSeen();
  const online = useOnline();

  if (!serverUrl()) return <Redirect href="/setup" />;

  const { headline, detail } = homeLine(agents, seen, online, new Date().getHours());

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <FlatList
        data={agents}
        keyExtractor={(agent) => agent.id}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + ADD_BUTTON + 32 }}
        ListHeaderComponent={
          <View style={styles.head} accessibilityRole="header">
            <Text style={[styles.headline, { color: theme.ink }]}>{headline}</Text>
            {detail ? <Text style={[styles.detail, { color: theme.ink2 }]}>{detail}</Text> : null}
          </View>
        }
        renderItem={({ item }) => <AgentRow agent={item} online={online} onPress={() => router.push(`/chat/${item.id}`)} />}
      />
      <TopFade height={insets.top + 16} solid={insets.top} />
      <Pressable
        onPress={() => router.push("/new-agent")}
        accessibilityRole="button"
        accessibilityLabel="New agent"
        style={[styles.add, { bottom: insets.bottom + 12 }]}>
        <Glass interactive style={styles.addGlass}>
          <Plus size={28} strokeWidth={2.25} color={theme.tintInk} />
        </Glass>
      </Pressable>
    </View>
  );
}

function AgentRow({ agent, online, onPress }: { agent: AgentWithLatest; online: boolean; onPress: () => void }) {
  const theme = useTheme();
  const petState = usePetState(agent);
  const line = useWorkingLine();
  const working = online && petState === "working";
  const unread = online && petState === "replied";
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.field }]}>
      <PetView petId={agent.pet_id} state={online ? petState : "resting"} size={48} dimmed={!online} />
      <View style={[styles.body, { borderBottomColor: theme.line }]}>
        <View style={styles.top}>
          <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
            {agent.name}
          </Text>
          <Text style={[styles.time, { color: theme.ink2 }]}>{listTime(agent.latest?.created_at ?? agent.created_at)}</Text>
        </View>
        <View style={styles.bottom}>
          <Text style={[styles.preview, { color: unread ? theme.ink : theme.ink2 }, working && styles.working]} numberOfLines={2}>
            {working ? line : (agent.latest?.body ?? "Say hello")}
          </Text>
          {unread ? <View style={[styles.dot, { backgroundColor: theme.tintInk }]} /> : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: { paddingHorizontal: 20, paddingBottom: 18 },
  headline: { fontSize: 34, lineHeight: 40, fontWeight: "700", letterSpacing: 0.3 },
  detail: { fontSize: 17, lineHeight: 22, marginTop: 6 },
  add: { position: "absolute", right: 20, zIndex: 2 },
  addGlass: { width: ADD_BUTTON, height: ADD_BUTTON, borderRadius: ADD_BUTTON / 2, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16 },
  body: { flex: 1, minHeight: 76, justifyContent: "center", paddingRight: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  name: { flex: 1, fontSize: 17, fontWeight: "600" },
  time: { fontSize: 15 },
  bottom: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 2 },
  preview: { flex: 1, fontSize: 15, lineHeight: 20 },
  working: { fontStyle: "italic" },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 5 },
});
