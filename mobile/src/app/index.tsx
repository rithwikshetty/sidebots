import { useEffect, useRef, useState, type ComponentType, type ReactNode, type RefObject } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { LayoutAnimationConfig, useAnimatedStyle, withTiming } from "react-native-reanimated";
import Swipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { Redirect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { Bell, BellOff, ChevronRight, Eye, EyeOff, Plus, Search, Trash2 } from "lucide-react-native";
import type { AgentWithLatest, Found } from "@server/contract";
import { Glass } from "@/components/Glass";
import { AvatarView } from "@/components/AvatarView";
import { EdgeFade } from "@/components/EdgeFade";
import { FadingText } from "@/components/FadingText";
import { confirmDelete, problem } from "@/lib/alerts";
import { serverUrl } from "@/lib/api";
import { useWorkingLine } from "@/lib/lines";
import { preview } from "@/lib/messages";
import { EASE, HIDE, MOVE, POP_IN, POP_OUT, SHOW } from "@/lib/motion";
import { avatarStateOf, changeAgent, findMessages, useAgents, useOnline, type AgentChanges } from "@/lib/state";
import { usePush } from "@/lib/push";
import { useTheme } from "@/lib/theme";
import { listTime } from "@/lib/time";

const ADD_BUTTON = 44;
const SEARCH_HEIGHT = 44;
// The room between the search field and the home indicator, or the keyboard once it is up.
const SEARCH_GAP = 8;
// How long the person rests from typing before the server is asked.
const SEARCH_DELAY_MS = 200;
// How much of a found message shows before the words that matched.
const SNIPPET_LEAD = 24;
// The width of each action a swipe on a row shows.
const ACTION = 76;

/** A row of the list: an agent, or a message a search found in that agent's chat. */
type Row = { agent: AgentWithLatest; found?: Found };

/**
 * The home screen. It has no title bar and no heading: the person's agents,
 * with a glass button for a new agent floating at the top right and a glass
 * search field floating at the bottom, where a thumb reaches it. The field
 * rises with the keyboard. A swipe left on an agent shows what can be done
 * to it: mute, hide and delete. Hidden agents wait under a line at the
 * list's end, which a tap opens. While the search field holds text, the list
 * is the agents whose name matches and then the messages that contain it,
 * from every chat. Rows slide to their new places as agents move up the
 * list, and fade in and out as they come and go.
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
  const [showHidden, setShowHidden] = useState(false);
  // The row whose actions are showing, which closes when another row's open.
  const opened = useRef<SwipeableMethods | null>(null);
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
    : agents.filter((agent) => !agent.hidden).map((agent) => ({ agent }));
  const hidden = search ? [] : agents.filter((agent) => agent.hidden);
  const swipeRow = (agent: AgentWithLatest) => (
    <Animated.View key={agent.id} entering={SHOW} exiting={HIDE}>
      <AgentActions agent={agent} opened={opened}>
        <AgentRow agent={agent} search={search} online={online} onPress={() => router.push(`/chat/${agent.id}`)} />
      </AgentActions>
    </Animated.View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      {/* The rows the list opens with show as they are; ones that come later fade in. */}
      <LayoutAnimationConfig skipEntering>
        <Animated.FlatList
          data={rows}
          keyExtractor={(row) => row.found?.id ?? row.agent.id}
          itemLayoutAnimation={MOVE}
          contentInsetAdjustmentBehavior="never"
          contentContainerStyle={{ paddingTop: insets.top + ADD_BUTTON + 12, paddingBottom: insets.bottom + SEARCH_GAP + SEARCH_HEIGHT + 16 }}
          // A drag lowers the keyboard, and a tap on a row opens it with the keyboard still up.
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={search && found ? <FadingText style={[styles.empty, { color: theme.ink2 }]}>No results</FadingText> : undefined}
          ListFooterComponent={
            hidden.length ? (
              <>
                <Pressable
                  onPress={() => setShowHidden((shown) => !shown)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showHidden }}
                  style={styles.hidden}>
                  <Text style={[styles.hiddenText, { color: theme.ink2 }]}>Hidden · {hidden.length}</Text>
                  <Turning open={showHidden} />
                </Pressable>
                {showHidden ? hidden.map(swipeRow) : null}
              </>
            ) : undefined
          }
          renderItem={({ item }) =>
            item.found ? (
              <Animated.View entering={SHOW} exiting={HIDE}>
                <AgentRow agent={item.agent} found={item.found} search={search} online={online} onPress={() => router.push(`/chat/${item.agent.id}`)} />
              </Animated.View>
            ) : (
              swipeRow(item.agent)
            )
          }
        />
      </LayoutAnimationConfig>
      <EdgeFade edge="top" height={insets.top + ADD_BUTTON + 16} solid={insets.top} />
      <Pressable
        onPress={() => router.push("/new-agent")}
        accessibilityRole="button"
        accessibilityLabel="New agent"
        style={[styles.add, { top: insets.top }]}>
        <Glass interactive style={styles.addGlass}>
          <Plus size={24} strokeWidth={2.25} color={theme.tintInk} />
        </Glass>
      </Pressable>
      {/* The keyboard covers the home indicator, so the field rises by the keyboard's height less that inset. */}
      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }} style={styles.sticky}>
        <EdgeFade edge="bottom" height={insets.bottom + SEARCH_GAP + SEARCH_HEIGHT + 16} solid={insets.bottom} />
        <View style={[styles.search, { paddingBottom: insets.bottom + SEARCH_GAP }]}>
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
      </KeyboardStickyView>
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

/**
 * Wraps an agent's row so that a swipe left shows its actions: mute, hide and
 * delete. Mute stops its notifications. Hide takes it off the list until it
 * next has something to say. Delete asks first.
 */
function AgentActions({ agent, opened, children }: { agent: AgentWithLatest; opened: RefObject<SwipeableMethods | null>; children: ReactNode }) {
  const theme = useTheme();
  const row = useRef<SwipeableMethods>(null);
  const change = (changes: AgentChanges) => void changeAgent(agent.id, changes).catch((failure) => problem("Couldn't change that", failure));
  const act = (action: () => void) => () => {
    row.current?.close();
    action();
  };
  return (
    <Swipeable
      ref={row}
      friction={1.5}
      rightThreshold={ACTION / 2}
      overshootRight={false}
      onSwipeableWillOpen={() => {
        if (opened.current !== row.current) opened.current?.close();
        opened.current = row.current;
      }}
      renderRightActions={() => (
        <View style={styles.actions}>
          <RowAction icon={agent.muted ? Bell : BellOff} label={agent.muted ? "Unmute" : "Mute"} color={theme.ink2} onPress={act(() => change({ muted: !agent.muted }))} />
          <RowAction icon={agent.hidden ? Eye : EyeOff} label={agent.hidden ? "Unhide" : "Hide"} color={theme.tint} onPress={act(() => change({ hidden: !agent.hidden }))} />
          <RowAction icon={Trash2} label="Delete" color={theme.danger} onPress={act(() => confirmDelete(agent))} />
        </View>
      )}>
      {children}
    </Swipeable>
  );
}

/** The arrow by Hidden, which turns down as the hidden agents open and back as they close. */
function Turning({ open }: { open: boolean }) {
  const theme = useTheme();
  const turn = useAnimatedStyle(() => ({ transform: [{ rotate: withTiming(open ? "90deg" : "0deg", EASE) }] }));
  return (
    <Animated.View style={turn}>
      <ChevronRight size={16} color={theme.ink2} />
    </Animated.View>
  );
}

/** One of the actions behind a row: its icon over its name, on its colour. */
function RowAction({ icon: Icon, label, color, onPress }: { icon: ComponentType<{ size?: number; color?: string; strokeWidth?: number }>; label: string; color: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.action, { backgroundColor: color, opacity: pressed ? 0.75 : 1 }]}>
      <Icon size={22} strokeWidth={2} color={theme.onTint} />
      <Text style={[styles.actionText, { color: theme.onTint }]}>{label}</Text>
    </Pressable>
  );
}

/** An agent as a row of the list. With `found`, the row shows that message from its chat in place of the latest one. */
function AgentRow({ agent, found, search, online, onPress }: { agent: AgentWithLatest; found?: Found; search: string; online: boolean; onPress: () => void }) {
  const theme = useTheme();
  const avatarState = found ? "resting" : avatarStateOf(agent);
  const line = useWorkingLine();
  const working = online && avatarState === "working";
  const unread = !found && agent.unread > 0;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.field : theme.bg }]}>
      <AvatarView avatarId={agent.avatar_id} state={online ? avatarState : "resting"} size={48} dimmed={!online} />
      <View style={[styles.body, { borderBottomColor: theme.line }]}>
        <View style={styles.top}>
          <View style={styles.title}>
            <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
              {agent.name}
            </Text>
            {agent.muted ? (
              <Animated.View entering={SHOW} exiting={HIDE}>
                <BellOff size={13} strokeWidth={2.25} color={theme.ink2} accessibilityLabel="Muted" />
              </Animated.View>
            ) : null}
          </View>
          <Text style={[styles.time, { color: theme.ink2 }]}>{listTime((found ?? agent.latest)?.created_at ?? agent.created_at)}</Text>
        </View>
        <View style={styles.bottom}>
          {/* The line crossfades as a new message comes or the working line changes. */}
          <FadingText style={[styles.preview, { color: unread ? theme.ink : theme.ink2 }, working && styles.working]} numberOfLines={2}>
            {found ? foundLine(found, search) : working ? line : agent.latest ? preview(agent.latest) : "Say hello"}
          </FadingText>
          {unread ? (
            <Animated.View
              entering={POP_IN}
              exiting={POP_OUT}
              style={[styles.count, { backgroundColor: agent.muted ? theme.ink2 : theme.tint }]}
              accessibilityLabel={`${agent.unread} unread`}>
              <Text style={[styles.countText, { color: theme.onTint }]}>{agent.unread > 99 ? "99+" : agent.unread}</Text>
            </Animated.View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
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
  sticky: { position: "absolute", left: 0, right: 0, bottom: 0 },
  search: { paddingHorizontal: 16 },
  searchGlass: { height: SEARCH_HEIGHT, borderRadius: SEARCH_HEIGHT / 2, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 14, paddingRight: 8, overflow: "hidden" },
  searchText: { flex: 1, height: SEARCH_HEIGHT, fontSize: 17, padding: 0 },
  empty: { textAlign: "center", fontSize: 15, marginTop: 32 },
  add: { position: "absolute", right: 16, zIndex: 2 },
  addGlass: { width: ADD_BUTTON, height: ADD_BUTTON, borderRadius: ADD_BUTTON / 2, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16 },
  body: { flex: 1, minHeight: 76, justifyContent: "center", paddingRight: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  title: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6 },
  name: { flexShrink: 1, fontSize: 17, fontWeight: "600" },
  actions: { flexDirection: "row" },
  action: { width: ACTION, alignItems: "center", justifyContent: "center", gap: 4 },
  actionText: { fontSize: 12, fontWeight: "600" },
  hidden: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 16, paddingVertical: 14 },
  hiddenText: { fontSize: 15 },
  time: { fontSize: 15 },
  bottom: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 2 },
  preview: { flex: 1, fontSize: 15, lineHeight: 20 },
  working: { fontStyle: "italic" },
  count: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 7, alignItems: "center", justifyContent: "center" },
  countText: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
});
