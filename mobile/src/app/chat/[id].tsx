import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View, type ListViewToken } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardChatScrollView, KeyboardController, KeyboardEvents, KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, { FadeOut, useSharedValue } from "react-native-reanimated";
import { Reply, X } from "lucide-react-native";
import { avatarStateOf, betweenAgents, exchanges, type AgentWithLatest, type Ask, type Message, type Question } from "@server/contract";
import { standingOf } from "@client/exchanges";
import { fileName, fitsInMessage, isImage, isPage, MAX_FILES, SIZE_LIMIT_NOTICE } from "@client/files";
import { preview } from "@client/messages";
import { dayLabel, listTime, sameDay } from "@client/time";
import { AskCard } from "@/components/AskCard";
import { ChatBubble } from "@/components/ChatBubble";
import { BAR_HEIGHT, ChatHeader, HEADER_CLEARANCE, HEADER_OVERHANG } from "@/components/ChatHeader";
import { Composer } from "@/components/Composer";
import { Exchange } from "@/components/Exchange";
import { FadingText } from "@/components/FadingText";
import { Glass } from "@/components/Glass";
import { IconButton } from "@/components/IconButton";
import { Markdown } from "@/components/Markdown";
import { FileCard, MessagePage, MessagePhotos, type Shown } from "@/components/MessageAttachments";
import { SwipeToReply } from "@/components/SwipeToReply";
import { SwitchNotice } from "@/components/SwitchNotice";
import { WorkingLine } from "@/components/WorkingLine";
import { problem } from "@/lib/alerts";
import { attachment } from "@/lib/api";
import { pick, type Picked, type PickSource } from "@/lib/files";
import { haptics } from "@/lib/haptics";
import { useAppActive, useReadingMargin, useSplit, useToday } from "@/lib/layout";
import { useWorkingLine } from "@/lib/lines";
import { HIDE, MOVE, SHOW, arrive } from "@/lib/motion";
import { askForPush, showChatOnScreen, useOpenChat } from "@/lib/push";
import { answerAsk, backToNewest, connect, freshStart, loadMessages, loadOlder, markRead, resend, send, stop, useAgent, useChatColor, useHole, useMessages, useOnline } from "@/lib/state";
import { ChatColor, type Theme, useTheme } from "@/lib/theme";

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const agent = useAgent(id);
  // A chat whose agent is deleted, here or on the computer, closes with anything over it. One opened before the agents have loaded waits for them.
  const seen = useRef(false);
  if (agent) seen.current = true;
  useEffect(() => {
    if (!agent && seen.current) router.dismissTo("/");
  }, [agent, router]);
  // The chat takes the agent's colour, for the person's messages and the send button.
  const color = useChatColor(agent);
  return agent ? (
    <ChatColor value={color}>
      <ChatWith agent={agent} />
    </ChatColor>
  ) : null;
}

function ChatWith({ agent }: { agent: AgentWithLatest }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const online = useOnline();
  // Beside the agents' column the chat has no Back, and its messages keep to the reading column in a wide one.
  const split = useSplit();
  const margin = useReadingMargin();
  const avatarState = avatarStateOf(agent);
  const today = useToday();
  const chat = useMessages(agent.id);
  const hole = useHole(agent.id);
  // With a hole in the chat, the list draws the stretch before it, which fills across the hole as the person scrolls down to it, and the chat's newest messages wait beyond it.
  const messages = useMemo(() => (hole === undefined ? chat : chat.slice(0, chat.findIndex((message) => message.id === hole) + 1)), [chat, hole]);
  // The agent this one asked something and hasn't heard back from.
  const waitingOn = useAgent(agent.waiting_on ?? "");
  // Whether the agent waits on the person's answer to an ask of its own, which is then the last thing in the chat.
  const asksPerson = chat.some((message) => message.ask === "waiting" && message.agent_id === agent.id);
  // What the agent and another said to each other shows as one line for each exchange, where the newest thing in it was asked.
  const standings = useMemo(() => {
    const each = exchanges(messages).map((exchange) => standingOf(exchange, messages));
    return new Map(each.map(({ asked, state }) => [asked.id, state]));
  }, [messages]);
  // The person's newest message, which carries the chat's receipt.
  const newestMine = chat.findLast((message) => message.sender === "person")?.id;
  const [picked, setPicked] = useState<Picked[]>([]);
  // The message the next one answers, set by a swipe on it.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  // A message on its way to the server, shown faded at the chat's end until the server has it.
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  // Messages made from here on came in while the chat was open, so they arrive with motion.
  const [openedAt] = useState(() => Date.now() - CLOCK_SLACK_MS);

  const [loading, setLoading] = useState(chat.length === 0 && agent.latest !== null);
  useEffect(() => {
    loadMessages(agent.id)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [agent.id]);

  // While the chat is open with the app in front, everything in it counts as read. What comes after the person leaves the app waits, unread, and notifies them.
  const latest = agent.latest?.id;
  const active = useAppActive();
  useFocusEffect(
    useCallback(() => {
      if (active) markRead(agent.id);
    }, [agent.id, latest, active]),
  );
  // Opening the chat clears its notifications from the phone.
  useEffect(() => showChatOnScreen(agent.id), [agent.id]);

  // The list is Assist's: drawn upside down, so it opens at the newest message
  // and holds the end as messages arrive, inside the keyboard's own scroll
  // view, which lifts the messages with the keyboard in the same motion as the
  // composer. Its rows run newest first.
  const list = useRef<FlatList<Message>>(null);
  const newestFirst = useMemo(() => messages.filter((message) => !betweenAgents(message) || standings.has(message.id)).reverse(), [messages, standings]);
  // The composer floats over the list's end; a spacer of its height keeps the last message above it.
  const [composerHeight, setComposerHeight] = useState(COMPOSER_ESTIMATE + insets.bottom);
  // Whether the newest message is on screen, and the room the keyboard takes at the list's end.
  const [atEnd, setAtEnd] = useState(true);
  const keyboardInset = useRef(0);
  // A picker covers the chat, and the keyboard goes while it is up and comes
  // back after. Left to follow the keyboard through that, the list can miss
  // its way back up and leave the newest message behind the message field,
  // so it holds its place until the keyboard is back.
  const covered = useSharedValue(false);
  // The message the chat was opened at flashes, and the rows draw again when it does, as they do when the receipt moves to a newer message.
  const [flashing, setFlashing] = useState<string | null>(null);
  const drawnWith = useMemo(() => ({ newestMine, flashing }), [newestMine, flashing]);
  // Whether the chat is on its way to a message it was opened at.
  const [landing, setLanding] = useState(false);
  // The rows the list has measured on screen, as it last said.
  const onScreen = useRef(new Set<string>());
  const onRowsShown = useRef(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    onScreen.current = new Set(viewableItems.map((row) => row.key));
  }).current;

  // Opened at a message it doesn't draw, the chat fetches the run of the chat from it, or, when it is among the newest messages past a hole, goes back to them. Then it scrolls to it and flashes it. A message that draws no row, as one between two agents, is opened at the nearest row to it, the one before it first. Opened again before a run has come, the chat lets that run go, so it can't land over the chat as it is opened now.
  const opened = useOpenChat();
  const held = useRef({ chat, messages, newestFirst });
  held.current = { chat, messages, newestFirst };
  useEffect(() => {
    const id = opened?.agentId === agent.id ? opened.messageId : undefined;
    if (!id || loading) return;
    let going = true;
    let fetching = false;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const isIt = (message: Message) => message.id === id;
    setLanding(true);
    void (async () => {
      if (!held.current.messages.some(isIt)) {
        if (held.current.chat.some(isIt)) backToNewest(agent.id);
        else {
          fetching = true;
          await loadOlder(agent.id, id).catch(() => false);
          fetching = false;
        }
        await frame();
      }
      const { messages, newestFirst } = held.current;
      const index = going ? messages.findIndex(isIt) : -1;
      if (index < 0) return;
      const drawn = (message: Message | undefined) => (message && newestFirst.includes(message) ? message : undefined);
      let nearest: Message | undefined;
      for (let step = 0; !nearest && step < messages.length; step++) nearest = drawn(messages[index - step]) ?? drawn(messages[index + step]);
      if (!nearest) return;
      // The list scrolls exactly only to a row it has measured, and to others by the heights it guesses. Each frame the chat scrolls to the row again, as the list draws and measures the rows where it is, until the row is on screen measured.
      for (let tries = 0; tries < LANDING_FRAMES; tries++) {
        const at = held.current.newestFirst.indexOf(nearest);
        if (!going || at < 0) return;
        list.current?.scrollToIndex({ index: at, viewPosition: 0.5, animated: false });
        if (onScreen.current.has(nearest.id)) break;
        await frame();
      }
      if (!going) return;
      setFlashing(nearest.id);
      setTimeout(() => going && setFlashing(null), FLASH_HOLD_MS);
    })().finally(() => going && setLanding(false));
    return () => {
      going = false;
      if (fetching) backToNewest(agent.id);
      setLanding(false);
      setFlashing(null);
    };
  }, [opened, agent.id, loading]);

  // Scrolling up to the oldest message the app has fetches the page before it, until the chat's beginning: the oldest message, once a page fetched before it came back empty.
  const first = useRef<string | null>(null);
  function onOldestReached() {
    const oldest = messages[0]?.id;
    if (oldest && oldest !== first.current) loadOlder(agent.id).then((more) => void (more || (first.current = oldest)), () => undefined);
  }

  // Resolves to whether the message went. One that didn't leaves its files and the message it answers as they were.
  async function onSend(text: string): Promise<boolean> {
    const files = picked;
    const answering = replyTo;
    if (!text && files.length === 0) return false;
    setPicked([]);
    setReplyTo(null);
    setOutgoing({ body: text, files, quote: answering ? preview(answering) : undefined, after: newestMine });
    haptics.send();
    // A stretch from further back goes, and the chat is at the end of its newest messages, where the message goes.
    if (hole !== undefined) backToNewest(agent.id);
    list.current?.scrollToOffset({ offset: -keyboardInset.current, animated: true });
    try {
      await send(agent.id, text, files, answering?.id);
      // They may leave while the agent works, so this is when a notification starts to matter.
      void askForPush().catch(() => undefined);
      return true;
    } catch (failure) {
      setPicked(files);
      setReplyTo(answering);
      problem("Not sent", failure);
      return false;
    } finally {
      setOutgoing(null);
    }
  }

  function onResend(message: Message) {
    haptics.send();
    resend(message).catch((failure) => problem("Not sent", failure));
  }

  function onStop() {
    haptics.stop();
    stop(agent.id).catch((failure) => problem("Couldn't stop", failure));
  }

  async function onAttach(source: PickSource) {
    if (KeyboardController.isVisible()) {
      covered.value = true;
      const back = KeyboardEvents.addListener("keyboardDidShow", () => {
        back.remove();
        covered.value = false;
      });
    }
    try {
      const added = await pick(source, MAX_FILES - picked.length);
      if (!fitsInMessage([...picked, ...added])) throw new Error(SIZE_LIMIT_NOTICE);
      setPicked((current) => [...current, ...added].slice(0, MAX_FILES));
    } catch (failure) {
      problem("Can't add that", failure);
    }
  }

  // The keyboard covers the home indicator, so the list and the composer rise by
  // the keyboard's height less that inset, frame by frame with the keyboard.
  const keyboardOffset = Math.max(0, insets.bottom - 8);

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <Stack.Screen options={{ title: agent.name }} />
      {/* The list fills the screen; messages scroll up under the floating header and down under the composer's strip. */}
      <FlatList
        ref={list}
        data={newestFirst}
        inverted
        extraData={drawnWith}
        keyExtractor={(message) => message.id}
        renderScrollComponent={(props) => (
          <KeyboardChatScrollView
            {...props}
            inverted
            keyboardLiftBehavior="always"
            freeze={covered}
            offset={keyboardOffset}
            onEndVisible={setAtEnd}
            onContentInsetChange={(inset) => {
              keyboardInset.current = inset.top;
            }}
          />
        )}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustsScrollIndicatorInsets={false}
        // At the end the list follows new messages; scrolled up, the person stays where they are reading.
        // So do they at the end of a stretch from further back, while the run after it fills the hole below them.
        maintainVisibleContentPosition={atEnd && hole === undefined ? undefined : { minIndexForVisible: 1 }}
        // As in Messages: dragging the list pulls the keyboard down with the finger, and a tap anywhere in it lowers the keyboard.
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="never"
        onEndReached={onOldestReached}
        onEndReachedThreshold={1.5}
        // Scrolling down to the end of a stretch from further back fetches the run of the chat after it. While the chat lands on a message it was opened at, the list can be at that end for a moment on its way.
        onStartReached={hole === undefined || landing ? undefined : () => void loadOlder(agent.id, hole).catch(() => undefined)}
        onStartReachedThreshold={1.5}
        onViewableItemsChanged={onRowsShown}
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
        }}
        // Upside down, the list's header is its foot, and its bottom padding is the room at the top of the screen for the floating header.
        contentContainerStyle={{ paddingBottom: insets.top + BAR_HEIGHT + HEADER_OVERHANG + HEADER_CLEARANCE, paddingHorizontal: margin }}
        ListHeaderComponent={
          <View>
            <View style={styles.foot}>
              {/* A new agent's chat says what to do first. Its instructions have it ask what it's for. */}
              {!agent.latest && messages.length === 0 && !outgoing ? (
                <Animated.View entering={SHOW} exiting={HIDE}>
                  <Text style={[styles.hint, { color: theme.ink2 }]}>{agent.name} is new. Tell it what it's for.</Text>
                </Animated.View>
              ) : null}
              {/* The faded copy goes once the server's copy is in the chat, which may come over the event stream first. */}
              {outgoing && outgoing.after === newestMine ? (
                <Animated.View entering={RISE} style={[styles.mine, styles.pending]}>
                  <Sent
                    body={outgoing.body}
                    quote={outgoing.quote}
                    photos={outgoing.files.filter((file) => file.photo)}
                    files={outgoing.files.filter((file) => !file.photo)}
                    mine
                    theme={theme}
                  />
                </Animated.View>
              ) : null}
              {hole !== undefined ? <ActivityIndicator accessibilityLabel="Loading messages" color={theme.ink2} style={styles.hole} /> : agent.working && online && !asksPerson ? <WorkingRow /> : null}
            </View>
            <View style={{ height: composerHeight }} />
          </View>
        }
        renderItem={({ item, index }) => {
          const older = newestFirst[index + 1];
          const standing = standings.get(item.id);
          return (
            <Row message={item} openedAt={openedAt} flashing={item.id === flashing}>
              {!older || !sameDay(older.created_at, item.created_at) ? (
                <Text style={[styles.day, { color: theme.ink2 }]}>{dayLabel(item.created_at, today)}</Text>
              ) : null}
              {standing ? (
                <Exchange
                  asked={item}
                  state={standing}
                  arriving={item.created_at >= openedAt && !arrived.has(item.id)}
                  onOpen={() => router.push({ pathname: "/exchange", params: { agent: agent.id, message: item.id } })}
                />
              ) : (
                <Bubble
                  message={item}
                  quoted={item.reply_to ? messages.find((message) => message.id === item.reply_to) : undefined}
                  theme={theme}
                  // An ask another agent raised while working for this one says whose it is.
                  from={item.agent_id === agent.id ? undefined : item.agent_id}
                  receipt={item.id === newestMine}
                  onReply={() => setReplyTo(item)}
                  onResend={() => onResend(item)}
                />
              )}
            </Row>
          );
        }}
      />
      <ChatHeader
        name={agent.name}
        avatarId={agent.avatar_id}
        avatarState={online ? (avatarState === "replied" ? "resting" : avatarState) : "resting"}
        dimmed={!online}
        onBack={split ? undefined : () => router.back()}
        onAbout={() => router.push(`/agent/${agent.id}`)}
        onFreshStart={() => void freshStart(agent.id).catch((failure) => problem("Couldn't start fresh", failure))}
      />
      <KeyboardStickyView offset={{ closed: 0, opened: keyboardOffset }} style={styles.sticky}>
        {/* The composer's strip is the page colour, as Assist's, so the messages pass under it instead of showing through. */}
        <View style={{ paddingBottom: insets.bottom, paddingHorizontal: margin, backgroundColor: theme.bg }} onLayout={(event) => setComposerHeight(Math.round(event.nativeEvent.layout.height))}>
          {replyTo ? (
            <Animated.View entering={SHOW} exiting={HIDE} layout={MOVE} style={styles.above}>
              <Glass style={styles.replying}>
                <Reply size={16} strokeWidth={2} color={theme.ink2} />
                <View style={styles.replyingText}>
                  <Text style={[styles.replyingTitle, { color: theme.ink }]}>Replying to {replyTo.sender === "person" ? "yourself" : agent.name}</Text>
                  <Text numberOfLines={1} style={[styles.replyingQuote, { color: theme.ink2 }]}>
                    {preview(replyTo)}
                  </Text>
                </View>
                <IconButton icon={X} label="Cancel reply" size={28} iconSize={16} color={theme.ink2} onPress={() => setReplyTo(null)} />
              </Glass>
            </Animated.View>
          ) : null}
          {/* The composer's own view, as Assist's bar, so its open and close transition measures from
              here: the reply banner coming or going above moves this view, not the composer in it. */}
          <View collapsable={false} style={styles.bar}>
            <Composer
              agent={agent}
              onModel={() => router.push(`/model/${agent.id}`)}
              onSend={onSend}
              onStop={(agent.working || waitingOn) && online ? onStop : undefined}
              placeholder={`Message ${agent.name}`}
              attachments={picked}
              onAttach={onAttach}
              onRemoveAttachment={(file) => setPicked((current) => current.filter((item) => item !== file))}
              attachDisabled={picked.length >= MAX_FILES}
            />
          </View>
        </View>
      </KeyboardStickyView>
    </View>
  );
}

/** A playful line while the agent works, which changes every few seconds. */
function WorkingRow() {
  return <WorkingLine>{useWorkingLine()}</WorkingLine>;
}

/**
 * A row of the chat. A message that came in while the chat was open rises
 * into place the first time it shows, and the person's own settles from its
 * faded copy where it already sits. The history the chat opens on, and a row
 * scrolled back into view, show as they are. The message the chat was opened
 * at is washed in the chat's colour, which fades away.
 */
function Row({ message, openedAt, flashing, children }: { message: Message; openedAt: number; flashing: boolean; children: ReactNode }) {
  const theme = useTheme();
  const [entering] = useState(() => (message.created_at < openedAt || arrived.has(message.id) ? undefined : message.sender === "person" ? SETTLE : RISE));
  useEffect(() => {
    arrived.add(message.id);
  }, [message.id]);
  return (
    <Animated.View entering={entering} style={styles.row}>
      {flashing ? (
        <Animated.View exiting={WASH_FADES} pointerEvents="none" style={styles.wash}>
          <View style={[StyleSheet.absoluteFill, styles.washColour, { backgroundColor: theme.tint, opacity: theme.dark ? 0.22 : 0.13 }]} />
        </Animated.View>
      ) : null}
      {children}
    </Animated.View>
  );
}

/**
 * A message in the chat. A swipe left on it replies to it. `quoted` is the
 * message it answers, when it answers one the app has.
 */
function Bubble({
  message,
  quoted,
  theme,
  from,
  receipt,
  onReply,
  onResend,
}: {
  message: Message;
  quoted: Message | undefined;
  theme: Theme;
  /** The agent that sent it, when that isn't the chat's own. */
  from?: string;
  /** Whether the message carries the chat's receipt, as the person's newest does. */
  receipt: boolean;
  onReply: () => void;
  onResend: () => void;
}) {
  if (message.switched) return <SwitchNotice message={message} switched={message.switched} />;
  if (message.sender === "sidebots") return <Text style={[styles.note, { color: theme.ink2 }]}>{message.body}</Text>;
  const mine = message.sender === "person";
  const shown = message.attachments.map((path) => ({ ...attachment(message.agent_id, path), name: fileName(path) }));
  // A page is the agent's to send. An HTML file from the person is a file, as it is to the agent.
  const drawn = (item: Shown) => !mine && isPage(item.name);
  return (
    <SwipeToReply onReply={onReply}>
      <View style={mine ? styles.mine : styles.theirs}>
        <Sent
          body={message.body}
          quote={message.reply_to ? (quoted ? preview(quoted) : "An earlier message") : undefined}
          photos={shown.filter((item) => isImage(item.name))}
          pages={shown.filter(drawn)}
          files={shown.filter((item) => !isImage(item.name) && !drawn(item))}
          mine={mine}
          theme={theme}
          asked={message.question ?? undefined}
          from={from}
          foot={message.ask ? <AskAnswer message={message} ask={message.ask} theme={theme} /> : undefined}
        />
        {mine && message.status === "failed" ? (
          <Animated.View entering={SHOW} exiting={HIDE}>
            <Pressable onPress={onResend} hitSlop={8}>
              <Text style={[styles.resend, { color: theme.tintInk }]}>Send again</Text>
            </Pressable>
          </Animated.View>
        ) : receipt ? (
          <Receipt message={message} theme={theme} />
        ) : null}
      </View>
    </SwipeToReply>
  );
}

/**
 * Under the person's newest message, as Assist and Messages show it:
 * "Delivered" while it waits for the agent, and "Read" with the time once the
 * agent has taken it in. The words crossfade as they change, and fade away
 * as the receipt moves on to a newer message.
 */
function Receipt({ message, theme }: { message: Message; theme: Theme }) {
  const read = message.status !== "queued";
  return <FadingText style={[styles.receipt, { color: theme.ink2 }]}>{read ? `Read ${listTime(message.seen_at ?? message.created_at)}` : "Delivered"}</FadingText>;
}

/**
 * At the foot of an ask's bubble: Allow and Don't allow while the agent waits
 * for the person's answer, and how the ask ended once it has. The agent goes
 * on, or leaves the thing undone, as soon as one is tapped. An ask for a
 * connection has Connect, which takes the person through the app's sign-in,
 * and the agent goes on once they have signed in.
 */
function AskAnswer({ message, ask, theme }: { message: Message; ask: Ask; theme: Theme }) {
  const [sending, setSending] = useState(false);
  const connection = message.question?.connection;
  if (ask !== "waiting") return <FadingText style={[styles.asked, { color: theme.ink2 }]}>{(connection ? CONNECTED : ASKED)[ask]}</FadingText>;
  const answer = (allow: boolean) => {
    haptics.select();
    setSending(true);
    (connection && allow ? connect(connection) : answerAsk(message, allow))
      .catch((failure) => problem(connection && allow ? "Couldn't connect" : "Couldn't answer", failure))
      .finally(() => setSending(false));
  };
  return (
    <Animated.View exiting={HIDE} style={styles.answers}>
      {/* On the bubble's grey, the quieter button is the page colour, as code is. */}
      <Pressable onPress={() => answer(false)} disabled={sending} accessibilityRole="button" style={({ pressed }) => [styles.answer, { backgroundColor: theme.bg, opacity: pressed || sending ? 0.6 : 1 }]}>
        <Text style={[styles.answerText, { color: theme.ink }]}>{connection ? "Not now" : "Don't allow"}</Text>
      </Pressable>
      <Pressable onPress={() => answer(true)} disabled={sending} accessibilityRole="button" style={({ pressed }) => [styles.answer, { backgroundColor: theme.tint, opacity: pressed || sending ? 0.6 : 1 }]}>
        <Text style={[styles.answerText, { color: theme.onTint }]}>{connection ? "Connect" : "Allow"}</Text>
      </Pressable>
    </Animated.View>
  );
}

/**
 * A message as the chat draws it: its photos and files above its bubble, as
 * Assist draws one, its pages between them, as T3 Code draws one, and the
 * message it answers quoted at the bubble's top. The agent's words are
 * markdown; the person's are as they typed them. An ask shows what is
 * `asked` as its card, in place of the words, with the agent it is `from`
 * when that isn't the chat's own. `foot` sits under either, inside the
 * bubble.
 */
function Sent({ body, quote, photos, pages = [], files, mine, theme, asked, from, foot }: { body: string; quote?: string; photos: Shown[]; pages?: Shown[]; files: Shown[]; mine: boolean; theme: Theme; asked?: Question; from?: string; foot?: ReactNode }) {
  const quiet = mine ? theme.onTint : theme.ink2;
  return (
    <>
      {photos.length ? <MessagePhotos photos={photos} end={mine} /> : null}
      {pages.map((page) => (
        <MessagePage key={page.uri} page={page} />
      ))}
      {files.map((file) => (
        <FileCard key={file.uri} file={file} />
      ))}
      {body || quote ? (
        <ChatBubble mine={mine}>
          {quote ? (
            <View style={[styles.quote, { borderLeftColor: quiet }]} accessibilityLabel={`In reply to: ${quote}`}>
              <Text numberOfLines={3} style={[styles.quoteText, { color: quiet }]}>
                {quote}
              </Text>
            </View>
          ) : null}
          {asked ? (
            <AskCard question={asked} from={from} />
          ) : body && mine ? (
            <Text selectable style={[styles.text, { color: theme.onTint }]}>
              {body}
            </Text>
          ) : body ? (
            <Markdown text={body} />
          ) : null}
          {foot}
        </ChatBubble>
      ) : null}
    </>
  );
}


/**
 * A message the person sent that the server hasn't answered for yet, with
 * what it quotes when it is a reply. `after` is the person's newest message
 * when they sent it, so the copy goes once a newer one is in the chat.
 */
type Outgoing = { body: string; files: Picked[]; quote?: string; after: string | undefined };

// The person's message shows this faded until the server has it.
const PENDING_OPACITY = 0.7;
// A new message rises into the chat. The person's own settles from its faded copy, which already sits there.
const RISE = arrive(0, 12);
const SETTLE = arrive(PENDING_OPACITY, 0);
// How an ask ended, as its bubble says it.
const ASKED: Record<Exclude<Ask, "waiting">, string> = { allowed: "Allowed", refused: "Not allowed", unanswered: "Not answered" };
// How an ask for a connection ended.
const CONNECTED: typeof ASKED = { allowed: "Connected", refused: "Not connected", unanswered: "Not connected" };
// The messages that have come in with motion, so a row scrolled away and back shows as it is.
const arrived = new Set<string>();
// The phone's clock and the server's may disagree by a little.
const CLOCK_SLACK_MS = 2000;
// The message the chat was opened at holds its wash for a moment, and the wash then fades.
const FLASH_HOLD_MS = 560;
const WASH_FADES = FadeOut.duration(1040);
// How many frames the chat is given to reach the message it was opened at. The list draws rows in batches, and a run of 200 rows takes it about 40.
const LANDING_FRAMES = 120;

// The resting composer's height above the home indicator, used until it is measured.
const COMPOSER_ESTIMATE = 64;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  row: { paddingHorizontal: 12 },
  foot: { paddingHorizontal: 12, paddingBottom: 10 },
  hole: { paddingVertical: 20 },
  wash: { position: "absolute", top: 0, right: 6, bottom: -3, left: 6 },
  washColour: { borderRadius: 12, borderCurve: "continuous" },
  day: { alignSelf: "center", fontSize: 13, marginTop: 12, marginBottom: 6 },
  mine: { alignItems: "flex-end", marginTop: 6, gap: 4 },
  theirs: { alignItems: "flex-start", marginTop: 6, gap: 4 },
  pending: { opacity: PENDING_OPACITY },
  text: { fontSize: 17, lineHeight: 22 },
  quote: { borderLeftWidth: 2, paddingLeft: 8, marginTop: 2, marginBottom: 6, opacity: 0.8 },
  quoteText: { fontSize: 14, lineHeight: 18 },
  replying: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 14,
    paddingRight: 8,
    paddingVertical: 8,
    borderRadius: 18,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  replyingText: { flex: 1 },
  replyingTitle: { fontSize: 13, fontWeight: "600" },
  replyingQuote: { fontSize: 13, lineHeight: 18 },
  note: { alignSelf: "center", textAlign: "center", fontSize: 13, lineHeight: 18, marginTop: 10, paddingHorizontal: 24 },
  hint: { textAlign: "center", fontSize: 15, lineHeight: 20, paddingHorizontal: 24 },
  receipt: { fontSize: 11, lineHeight: 15, marginTop: 2, marginRight: 4 },
  answers: { flexDirection: "row", gap: 8, marginTop: 2, marginBottom: 6 },
  answer: { flex: 1, minWidth: 108, minHeight: 44, paddingHorizontal: 14, borderRadius: 14, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  answerText: { fontSize: 16, fontWeight: "600" },
  asked: { fontSize: 13, lineHeight: 18, fontWeight: "600", marginBottom: 2 },
  resend: { fontSize: 13, fontWeight: "600", marginTop: 4, marginRight: 4 },
  sticky: { position: "absolute", left: 0, right: 0, bottom: 0 },
  above: { paddingHorizontal: 12, paddingTop: 8 },
  bar: { paddingHorizontal: 12, paddingTop: 8 },
});
