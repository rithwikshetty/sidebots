import { useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Plus, Search } from "lucide-react-native";
import type { AgentWithLatest, Found, Message } from "@server/contract";
import { Glass } from "@/components/Glass";
import { PetView } from "@/components/PetView";
import { TopFade } from "@/components/TopFade";
import { serverUrl } from "@/lib/api";
import { useWorkingLine } from "@/lib/lines";
import { findMessages, petStateOf, useAgents, useOnline } from "@/lib/state";
import { usePush } from "@/lib/push";
import { useTheme } from "@/lib/theme";
import { listTime } from "@/lib/time";

const ADD_BUTTON = 60;
const SEARCH_HEIGHT = 44;
// How long the person rests from typing before the server is asked.
const SEARCH_DELAY_MS = 200;
// How much of a found message shows before the words that matched.
const SNIPPET_LEAD = 24;

/** A row of the list: an agent, or a message a search found in that agent's chat. */
type Row = { agent: AgentWithLatest; found?: Found };

/**
 * The home screen. It has no title bar and no heading: a glass search field
 * floating at the top, the person's agents, and the button for a new agent
 * floating at the bottom right, where a thumb reaches it. While the search
 * field holds text, the list is the agents whose name matches and then the
 * messages that contain it, from every chat.
 */
export default function Home() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const agents = useAgents();
  const online = useOnline();
  const [typed, setTyped] = useState("");
  const search = typed.trim();
  const found = useFound(search);
  usePush();

  if (!serverUrl()) return <Redirect href="/setup" />;

  const rows: Row[] = search
    ? [
        ...agents.filter((agent) => agent.name.toLowerCase().includes(search.toLowerCase())).map((agent) => ({ agent })),
        ...(found ?? []).flatMap((message) => {
          const agent = agents.find((item) => item.id === message.agent_id);
          return agent ? [{ agent, found: message }] : [];
        }),
      ]
    : agents.map((agent) => ({ agent }));

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.found?.id ?? row.agent.id}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingTop: insets.top + SEARCH_HEIGHT + 12, paddingBottom: insets.bottom + ADD_BUTTON + 32 }}
        // A drag lowers the keyboard, and a tap on a row opens it with the keyboard still up.
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={search && found ? <Text style={[styles.empty, { color: theme.ink2 }]}>No results</Text> : undefined}
        renderItem={({ item }) => (
          <AgentRow agent={item.agent} found={item.found} search={search} online={online} onPress={() => router.push(`/chat/${item.agent.id}`)} />
        )}
      />
      <TopFade height={insets.top + SEARCH_HEIGHT + 16} solid={insets.top + SEARCH_HEIGHT} />
      <View style={[styles.search, { top: insets.top }]}>
        <Glass style={styles.searchGlass}>
          <Search size={18} strokeWidth={2.25} color={theme.ink2} />
          <TextInput
            value={typed}
            onChangeText={setTyped}
            placeholder="Search"
            placeholderTextColor={theme.ink2}
            selectionColor={theme.tintInk}
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
            style={[styles.searchText, { color: theme.ink }]}
          />
        </Glass>
      </View>
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

/** The messages that contain `text`, from every chat of the person's. Null until the server has answered. */
function useFound(text: string): Found[] | null {
  const [found, setFound] = useState<Found[] | null>(null);
  useEffect(() => {
    if (!text) return setFound(null);
    let current = true;
    const keep = (messages: Found[]) => current && setFound(messages);
    const timer = setTimeout(() => findMessages(text).then(keep, () => keep([])), SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [text]);
  return found;
}

/** An agent as a row of the list. With `found`, the row shows that message from its chat in place of the latest one. */
function AgentRow({ agent, found, search, online, onPress }: { agent: AgentWithLatest; found?: Found; search: string; online: boolean; onPress: () => void }) {
  const theme = useTheme();
  const petState = found ? "resting" : petStateOf(agent);
  const line = useWorkingLine();
  const working = online && petState === "working";
  const unread = !found && agent.unread > 0;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.field }]}>
      <PetView petId={agent.pet_id} state={online ? petState : "resting"} size={48} dimmed={!online} />
      <View style={[styles.body, { borderBottomColor: theme.line }]}>
        <View style={styles.top}>
          <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
            {agent.name}
          </Text>
          <Text style={[styles.time, { color: theme.ink2 }]}>{listTime((found ?? agent.latest)?.created_at ?? agent.created_at)}</Text>
        </View>
        <View style={styles.bottom}>
          <Text style={[styles.preview, { color: unread ? theme.ink : theme.ink2 }, working && styles.working]} numberOfLines={2}>
            {found ? foundLine(found, search) : working ? line : agent.latest ? preview(agent.latest) : "Say hello"}
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

/** A found message as one line of the list, starting a little before the words that matched, so they show. */
function foundLine(found: Found, search: string): string {
  const at = found.body.toLowerCase().indexOf(search.toLowerCase());
  const start = at - SNIPPET_LEAD;
  const space = found.body.indexOf(" ", Math.max(start, 0));
  const body = start > 0 ? `…${found.body.slice(space < at ? space + 1 : start)}` : found.body;
  return found.sender === "person" ? `You: ${body}` : body;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  search: { position: "absolute", left: 16, right: 16, zIndex: 2 },
  searchGlass: { height: SEARCH_HEIGHT, borderRadius: SEARCH_HEIGHT / 2, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 14, paddingRight: 8, overflow: "hidden" },
  searchText: { flex: 1, height: SEARCH_HEIGHT, fontSize: 17, padding: 0 },
  empty: { textAlign: "center", fontSize: 15, marginTop: 32 },
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
