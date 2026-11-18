import { useEffect, useRef, useState, type ComponentType, type ReactNode, type RefObject } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { LayoutAnimationConfig, useAnimatedStyle, withTiming } from "react-native-reanimated";
import Swipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Bell, BellOff, ChevronRight, Eye, EyeOff, Menu, Plus, Search, Trash2, X } from "lucide-react-native";
import { avatarStateOf, type AgentWithLatest, type Found } from "@server/contract";
import { Glass } from "@/components/Glass";
import { AvatarView } from "@/components/AvatarView";
import { EdgeFade } from "@/components/EdgeFade";
import { FadingText } from "@/components/FadingText";
import { useSideMenu } from "@/components/SideMenu";
import { confirmDelete, problem } from "@/lib/alerts";
import { UPDATE, type Behind } from "@/lib/api";
import { useWorkingLine } from "@/lib/lines";
import { preview } from "@/lib/messages";
import { EASE, HIDE, MOVE, POP_IN, POP_OUT, SHOW } from "@/lib/motion";
import { changeAgent, findMessages, useAgents, useAvatars, useBehind, useOnline, type AgentChanges } from "@/lib/state";
import { useActivities } from "@/lib/activity";
import { usePush } from "@/lib/push";
import { useTheme } from "@/lib/theme";
import { listTime } from "@/lib/time";
import { ScrollWaitsForMenuSwipe } from "../../modules/side-menu-swipe/src";

// The height of the bar that floats at the top, which is the size of each round button in it.
const BAR = 44;
// The search field and an unread count keep their size, and their text fits it up to this text size.
const FIXED_MAX_SCALE = 1.3;
// How long the person rests from typing before the server is asked.
const SEARCH_DELAY_MS = 200;
// How much of a found message shows before the words that matched.
const SNIPPET_LEAD = 24;
// The width of each action a swipe on a row shows.
const ACTION = 76;

/** What the home screen says in place of the agents when the computer or the app is behind. */
const BEHIND_NOTE: Record<Behind, string> = {
  computer: "It's older than this app. Your agents show here again once it's updated.",
  app: "Sidebots on your computer is newer than this app. Your agents show here again once it's updated.",
};

/** A row of the list: an agent, or a message a search found in that agent's chat. */
type Row = { agent: AgentWithLatest; found?: Found };

/**
 * The home screen. It has no title bar and no heading: the person's agents,
 * with glass buttons floating over them at the top, one for the side menu on
 * the left and, on the right, one for search and one for a new agent. Search
 * puts a glass field in the buttons' place, with the keyboard up and a
 * button to close it. A swipe right opens the side menu, and a swipe left on
 * an agent shows what can be done to it: mute, hide and delete. Hidden
 * agents wait under a line at the list's end, which a tap opens. A person
 * with no agents yet is pointed at the + button. When the computer and the
 * app speak different versions of the contract, a line saying which to
 * update takes the agents' place. While the search field holds text, the
 * list is the agents whose name matches and then the messages that contain
 * it, from every chat. Rows slide to their new places as agents move up the
 * list, and fade in and out as they come and go.
 */
export default function Home() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const agents = useAgents();
  const online = useOnline();
  const behind = useBehind();
  // The avatars come with the computer's first answer, so until then the phone can't tell whether there are no agents.
  const loaded = useAvatars().length > 0;
  const empty = loaded && agents.length === 0;
  const menu = useSideMenu();
  const [searching, setSearching] = useState(false);
  const [typed, setTyped] = useState("");
  const search = typed.trim();
  const found = useFound(search);
  const [showHidden, setShowHidden] = useState(false);
  // The row whose actions are showing, which closes when another row's open.
  const opened = useRef<SwipeableMethods | null>(null);
  usePush();
  useActivities();

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
          contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top + BAR + 12, paddingBottom: insets.bottom + 16 }}
          // A drag lowers the keyboard, and a tap on a row opens it with the keyboard still up.
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={<ScrollWaitsForMenuSwipe />}
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
      <EdgeFade edge="top" height={insets.top + BAR + 16} solid={insets.top} />
      {searching ? (
        <Animated.View key="search" entering={SHOW} exiting={HIDE} style={[styles.bar, { top: insets.top }]}>
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
        <Animated.View key="buttons" entering={SHOW} exiting={HIDE} pointerEvents="box-none" style={[styles.bar, { top: insets.top }]}>
          <BarButton icon={Menu} label="Menu" onPress={menu.open} />
          <View style={styles.barEnd}>
            {behind || empty ? null : <BarButton icon={Search} label="Search" onPress={() => setSearching(true)} />}
            {behind ? null : <BarButton icon={Plus} label="New agent" onPress={() => router.push("/new-agent")} />}
          </View>
        </Animated.View>
      )}
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
 * Wraps an agent's row so that a swipe left shows its actions: mute, hide and
 * delete. Mute stops its notifications. Hide takes it off the list until it
 * next has something to say. Delete asks first.
 */
function AgentActions({ agent, opened, children }: { agent: AgentWithLatest; opened: RefObject<SwipeableMethods | null>; children: ReactNode }) {
  const theme = useTheme();
  const row = useRef<SwipeableMethods>(null);
  const { holdSwipe } = useSideMenu();
  // Whether this row's actions are showing. A row that leaves the list with them showing, as when a search no longer finds it, hands the swipe back.
  const showing = useRef(false);
  useEffect(
    () => () => {
      if (showing.current) holdSwipe(false);
    },
    [holdSwipe],
  );
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
        showing.current = true;
        holdSwipe(true);
      }}
      // The row another one's opening closed has already handed the swipe on.
      onSwipeableWillClose={() => {
        showing.current = false;
        if (opened.current !== row.current) return;
        opened.current = null;
        holdSwipe(false);
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
              <Text maxFontSizeMultiplier={FIXED_MAX_SCALE} style={[styles.countText, { color: theme.onTint }]}>{agent.unread > 99 ? "99+" : agent.unread}</Text>
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
  bar: { position: "absolute", left: 16, right: 16, zIndex: 2, flexDirection: "row", justifyContent: "space-between", gap: 8 },
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
