import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { LayoutAnimationConfig, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BellOff, ChevronRight, Plus, Search, X } from "lucide-react-native";
import { avatarStateOf, type AgentWithLatest, type Found } from "@server/contract";
import { foundLine, preview } from "@client/messages";
import { listTime } from "@client/time";
import { Glass } from "@/components/Glass";
import { AvatarView } from "@/components/AvatarView";
import { Computer } from "@/components/Computer";
import { EdgeFade } from "@/components/EdgeFade";
import { FadingText } from "@/components/FadingText";
import { confirmDelete, problem } from "@/lib/alerts";
import { UPDATE, type Behind } from "@/lib/api";
import { useWorkingLine } from "@/lib/lines";
import { EASE, HIDE, MOVE, POP_IN, POP_OUT, SHOW } from "@/lib/motion";
import { changeAgent, findMessages, useAgent, useAgents, useAvatars, useBehind, useOnline } from "@/lib/state";
import { useSplit, useToday, useWindowControls } from "@/lib/layout";
import { openChat, useChatOnScreen } from "@/lib/push";
import { useTheme } from "@/lib/theme";
import { MessageMenuView, type MessageMenuAction } from "../../modules/message-menu/src";
import { ScrollWaitsForMenuSwipe } from "../../modules/side-menu-swipe/src";

// The height of the bar that floats at the top, which is the size of each round button in it.
const BAR = 44;
// The search field and an unread count keep their size, and their text fits it up to this text size.
const FIXED_MAX_SCALE = 1.3;
// How long the person rests from typing before the server is asked.
const SEARCH_DELAY_MS = 200;

/** What the app says in place of the agents when the computer or the app is behind. */
const BEHIND_NOTE: Record<Behind, string> = {
  computer: "It's older than this app. Your agents show here again once it's updated.",
  app: "Sidebots on your computer is newer than this app. Your agents show here again once it's updated.",
};

/** A row of the list: an agent, or a message a search found in that agent's chat. */
type Row = { agent: AgentWithLatest; found?: Found };

/**
 * The person's agents: the side menu a window of one column keeps them in,
 * which is also its home screen while no chat is open, or in a split window
 * the column beside the chat. The agent whose chat is open is marked. At the top are the app's name and glass buttons for search
 * and a new agent. Search puts a glass field in their place, with the
 * keyboard up and a button to close it. A long press on an agent opens what
 * can be done to it: mute, hide and delete. Hidden agents wait under a line
 * at the list's end, which a tap opens. A person with no agents yet is
 * pointed at the + button. When the computer and the app speak different
 * versions of the contract, a line saying which to update takes the agents'
 * place. While the search field holds text, the list is the agents whose
 * name matches and then the messages that contain it, from every chat. Rows
 * slide to their new places as agents move up the list, and fade in and out
 * as they come and go. At the foot is the computer the device has paired
 * with, which opens Settings.
 */
export function AgentList() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const agents = useAgents();
  const online = useOnline();
  const behind = useBehind();
  // The avatars come with the computer's first answer, so until then the phone can't tell whether there are no agents.
  const loaded = useAvatars().length > 0;
  const empty = loaded && agents.length === 0;
  const controls = useWindowControls();
  // The side menu is the colour of what the screens slide off, and the open chat's row is raised from it. Beside the chat, the agents are on the page colour.
  const split = useSplit();
  const surface = split ? theme.bg : theme.field;
  const marked = split ? theme.field : theme.raised;
  const [searching, setSearching] = useState(false);
  const [typed, setTyped] = useState("");
  const search = typed.trim();
  const found = useFound(search);
  const [showHidden, setShowHidden] = useState(false);
  // The agent whose chat is open.
  const open = useChatOnScreen();

  const rows: Row[] = behind
    ? []
    : search
      ? [
          ...agents.filter((agent) => agent.name.toLowerCase().includes(search.toLowerCase())).map((agent) => ({ agent })),
          ...(found ?? []).flatMap((message) => {
            const agent = agents.find((item) => item.id === message.agent_id);
            return agent ? [{ agent, found: message }] : [];
          }),
        ]
      : agents.filter((agent) => !agent.hidden).map((agent) => ({ agent }));
  const hidden = search || behind ? [] : agents.filter((agent) => agent.hidden);
  const agentRow = (agent: AgentWithLatest) => (
    <Animated.View key={agent.id} entering={SHOW} exiting={HIDE}>
      <AgentActions agent={agent}>
        <AgentRow agent={agent} search={search} online={online} marked={agent.id === open ? marked : undefined} onPress={() => openChat(agent.id)} />
      </AgentActions>
    </Animated.View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: surface }]}>
      {/* The rows the list opens with show as they are; ones that come later fade in. */}
      <LayoutAnimationConfig skipEntering>
        <Animated.FlatList
          data={rows}
          keyExtractor={(row) => row.found?.id ?? row.agent.id}
          itemLayoutAnimation={MOVE}
          contentInsetAdjustmentBehavior="never"
          contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top + BAR + 12, paddingBottom: 16 }}
          // A drag lowers the keyboard, and a tap on a row opens it with the keyboard still up.
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          // In the side menu, a swipe across closes it, and the list's scroll waits for that swipe to judge each drag.
          ListHeaderComponent={split ? undefined : <ScrollWaitsForMenuSwipe />}
          ListEmptyComponent={
            behind ? (
              <Notice title={UPDATE[behind]} note={BEHIND_NOTE[behind]} />
            ) : search && found ? (
              <FadingText style={[styles.empty, { color: theme.ink2 }]}>No results</FadingText>
            ) : empty ? (
              <Notice title="No agents yet" note="Tap + to make one, then tell it what it's for." />
            ) : undefined
          }
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
                {showHidden ? hidden.map(agentRow) : null}
              </>
            ) : undefined
          }
          renderItem={({ item }) =>
            item.found ? (
              <Animated.View entering={SHOW} exiting={HIDE}>
                <AgentRow agent={item.agent} found={item.found} search={search} online={online} onPress={() => openChat(item.agent.id, item.found?.id)} />
              </Animated.View>
            ) : (
              agentRow(item.agent)
            )
          }
        />
      </LayoutAnimationConfig>
      <EdgeFade edge="top" height={insets.top + BAR + 16} solid={insets.top} color={surface} />
      {searching ? (
        <Animated.View key="search" entering={SHOW} exiting={HIDE} style={[styles.bar, { top: insets.top, marginLeft: controls }]}>
          <Glass style={styles.searchGlass}>
            <Search size={18} strokeWidth={2.25} color={theme.ink2} />
            <TextInput
              autoFocus
              value={typed}
              onChangeText={setTyped}
              placeholder="Search"
              placeholderTextColor={theme.ink2}
              selectionColor={theme.tintInk}
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
              maxFontSizeMultiplier={FIXED_MAX_SCALE}
              style={[styles.searchText, { color: theme.ink }]}
            />
          </Glass>
          <BarButton
            icon={X}
            label="Close search"
            onPress={() => {
              setTyped("");
              setSearching(false);
            }}
          />
        </Animated.View>
      ) : (
        <Animated.View key="buttons" entering={SHOW} exiting={HIDE} pointerEvents="box-none" style={[styles.bar, { top: insets.top, marginLeft: controls }]}>
          <Text accessibilityRole="header" style={[styles.wordmark, { color: theme.ink }]}>
            Sidebots
          </Text>
          <View style={styles.barEnd}>
            {behind || empty ? null : <BarButton icon={Search} label="Search" onPress={() => setSearching(true)} />}
            {behind ? null : <BarButton icon={Plus} label="New agent" onPress={() => router.push("/new-agent")} />}
          </View>
        </Animated.View>
      )}
      <Pressable
        onPress={() => router.push("/settings")}
        accessibilityRole="button"
        accessibilityHint="Opens Settings"
        style={({ pressed }) => [styles.computer, { borderTopColor: theme.line, paddingBottom: Math.max(insets.bottom, 12), backgroundColor: pressed ? theme.line : "transparent" }]}>
        <Computer />
        <ChevronRight size={18} strokeWidth={2} color={theme.ink2} />
      </Pressable>
    </View>
  );
}

/** A round glass button of the bar that floats at the top. */
function BarButton({ icon: Icon, label, onPress }: { icon: ComponentType<{ size?: number; color?: string; strokeWidth?: number }>; label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      <Glass interactive style={styles.barButton}>
        <Icon size={24} strokeWidth={2.25} color={theme.tintInk} />
      </Glass>
    </Pressable>
  );
}

/** A few words in the middle of the screen where the agents would be. */
function Notice({ title, note }: { title: string; note: string }) {
  const theme = useTheme();
  return (
    <Animated.View entering={SHOW} exiting={HIDE} style={styles.notice}>
      <Text style={[styles.noticeTitle, { color: theme.ink }]}>{title}</Text>
      <Text style={[styles.noticeNote, { color: theme.ink2 }]}>{note}</Text>
    </Animated.View>
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
 * Wraps an agent's row so that a long press opens what can be done to it:
 * mute, hide and delete. Mute stops its notifications. Hide takes it off the
 * list until it next has something to say. Delete asks first.
 */
function AgentActions({ agent, children }: { agent: AgentWithLatest; children: ReactNode }) {
  const actions: MessageMenuAction[] = [
    { id: "mute", title: agent.muted ? "Unmute" : "Mute", systemImage: agent.muted ? "bell" : "bell.slash", group: "keeps" },
    { id: "hide", title: agent.hidden ? "Unhide" : "Hide", systemImage: agent.hidden ? "eye" : "eye.slash", group: "keeps" },
    { id: "delete", title: "Delete agent", systemImage: "trash", destructive: true, group: "removes" },
  ];
  const act = (id: string) => {
    if (id === "delete") return confirmDelete(agent);
    void changeAgent(agent.id, id === "mute" ? { muted: !agent.muted } : { hidden: !agent.hidden }).catch((failure) => problem("Couldn't change that", failure));
  };
  return (
    <MessageMenuView actions={actions} onAction={({ nativeEvent }) => act(nativeEvent.id)}>
      {children}
    </MessageMenuView>
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

/** An agent as a row of the list. With `found`, the row shows that message from its chat in place of the latest one. The row of the chat that is open is filled with `marked`, as a row is while a finger is on it. */
function AgentRow({ agent, found, search, online, marked, onPress }: { agent: AgentWithLatest; found?: Found; search: string; online: boolean; marked?: string; onPress: () => void }) {
  const theme = useTheme();
  const avatarState = found ? "resting" : avatarStateOf(agent);
  const working = online && avatarState === "working";
  const line = useWorkingLine(working);
  // The agent it asked something and hasn't heard back from.
  const waitingOn = useAgent(agent.waiting_on ?? "");
  const unread = !found && agent.unread > 0;
  const today = useToday();
  return (
    <Pressable
      onPress={onPress}
      accessibilityState={{ selected: marked !== undefined }}
      style={({ pressed }) => [styles.row, { backgroundColor: marked ?? (pressed ? theme.line : "transparent") }]}>
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
          <Text style={[styles.time, { color: theme.ink2 }]}>{listTime((found ?? agent.latest)?.created_at ?? agent.created_at, today)}</Text>
        </View>
        <View style={styles.bottom}>
          {/* The line crossfades as a new message comes or the working line changes. */}
          <FadingText style={[styles.preview, { color: unread ? theme.ink : theme.ink2 }, working && styles.working]} numberOfLines={2}>
            {found ? foundLine(found, search) : working ? line : waitingOn && online ? `Waiting on ${waitingOn.name}` : agent.latest ? preview(agent.latest) : "Say hello"}
          </FadingText>
          {unread ? (
            <Animated.View
              entering={POP_IN}
              exiting={POP_OUT}
              style={[styles.count, { backgroundColor: agent.muted ? theme.ink2 : theme.tint }]}
              accessibilityLabel={`${agent.unread} unread`}>
              <Text maxFontSizeMultiplier={FIXED_MAX_SCALE} style={[styles.countText, { color: theme.onTint }]}>{agent.unread > 99 ? "99+" : agent.unread}</Text>
            </Animated.View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  bar: { position: "absolute", left: 16, right: 16, zIndex: 2, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  wordmark: { fontSize: 22, lineHeight: 28, fontWeight: "600", paddingLeft: 8 },
  barEnd: { flexDirection: "row", gap: 8 },
  barButton: { width: BAR, height: BAR, borderRadius: BAR / 2, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  searchGlass: { flex: 1, height: BAR, borderRadius: BAR / 2, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 14, paddingRight: 8, overflow: "hidden" },
  searchText: { flex: 1, height: BAR, fontSize: 17, padding: 0 },
  empty: { textAlign: "center", fontSize: 15, marginTop: 32 },
  notice: { flex: 1, justifyContent: "center", gap: 6, paddingHorizontal: 32, paddingBottom: BAR },
  noticeTitle: { fontSize: 20, fontWeight: "600", textAlign: "center" },
  noticeNote: { fontSize: 15, lineHeight: 20, textAlign: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 16 },
  body: { flex: 1, minHeight: 76, justifyContent: "center", paddingRight: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  title: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6 },
  name: { flexShrink: 1, fontSize: 17, fontWeight: "600" },
  computer: { flexDirection: "row", alignItems: "center", gap: 14, paddingLeft: 24, paddingRight: 20, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  hidden: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 16, paddingVertical: 14 },
  hiddenText: { fontSize: 15 },
  time: { fontSize: 15 },
  bottom: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginTop: 2 },
  preview: { flex: 1, fontSize: 15, lineHeight: 20 },
  working: { fontStyle: "italic" },
  count: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 7, alignItems: "center", justifyContent: "center" },
  countText: { fontSize: 13, fontWeight: "600", fontVariant: ["tabular-nums"] },
});
