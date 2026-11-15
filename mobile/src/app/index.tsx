import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Plus } from "lucide-react-native";
import type { AgentWithLatest, Message } from "@server/contract";
import { Glass } from "@/components/Glass";
import { PetView } from "@/components/PetView";
import { TopFade } from "@/components/TopFade";
import { serverUrl } from "@/lib/api";
import { useWorkingLine } from "@/lib/lines";
import { petStateOf, useAgents, useOnline } from "@/lib/state";
import { usePush } from "@/lib/push";
import { useTheme } from "@/lib/theme";
import { listTime } from "@/lib/time";

const ADD_BUTTON = 60;

/**
 * The home screen. It has no title bar and no heading: only the person's
 * agents, and the button for a new agent floating at the bottom right, where
 * a thumb reaches it.
 */
export default function Home() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const agents = useAgents();
  const online = useOnline();
  usePush();

  if (!serverUrl()) return <Redirect href="/setup" />;

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <FlatList
        data={agents}
        keyExtractor={(agent) => agent.id}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + ADD_BUTTON + 32 }}
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
  const petState = petStateOf(agent);
  const line = useWorkingLine();
  const working = online && petState === "working";
  const unread = agent.unread > 0;
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
            {working ? line : agent.latest ? preview(agent.latest) : "Say hello"}
          </Text>
          {unread ? (
            <View style={[styles.count, { backgroundColor: theme.tint }]} accessibilityLabel={`${agent.unread} unread`}>
              <Text style={[styles.countText, { color: theme.onTint }]}>{agent.unread > 99 ? "99+" : agent.unread}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/** A message as one line of the list: its text, or what was sent when it has none. */
function preview(message: Message): string {
  if (message.body) return message.body;
  return message.attachments.length === 1 ? "Attachment" : `${message.attachments.length} attachments`;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
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
  count: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 7, alignItems: "center", justifyContent: "center" },
  countText: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
});
