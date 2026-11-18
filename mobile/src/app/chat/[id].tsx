import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardChatScrollView, KeyboardController, KeyboardEvents, KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, { useSharedValue } from "react-native-reanimated";
import { Reply, X } from "lucide-react-native";
import type { AgentWithLatest, Ask, Message } from "@server/contract";
import { AvatarView } from "@/components/AvatarView";
import { BAR_HEIGHT, ChatHeader, HEADER_CLEARANCE, HEADER_OVERHANG } from "@/components/ChatHeader";
import { Composer } from "@/components/Composer";
import { FadingText } from "@/components/FadingText";
import { Glass } from "@/components/Glass";
import { IconButton } from "@/components/IconButton";
import { Markdown } from "@/components/Markdown";
import { FileCard, MessagePhotos, type Shown } from "@/components/MessageAttachments";
import { SwipeToReply } from "@/components/SwipeToReply";
import { problem } from "@/lib/alerts";
import { attachment } from "@/lib/api";
import { fitsInMessage, isImage, MAX_FILES, pick, SIZE_LIMIT_NOTICE, type Picked, type PickSource } from "@/lib/files";
import { haptics } from "@/lib/haptics";
import { useWorkingLine } from "@/lib/lines";
import { preview } from "@/lib/messages";
import { HIDE, MOVE, SHOW, arrive } from "@/lib/motion";
import { askForPush, showChatOnScreen } from "@/lib/push";
import { answerAsk, avatarStateOf, freshStart, loadMessages, loadOlder, markRead, send, useAgent, useChatColor, useMessages, useOnline } from "@/lib/state";
import { ChatColor, type Theme, useTheme } from "@/lib/theme";
import { dayLabel, listTime, sameDay } from "@/lib/time";

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const agent = useAgent(id);
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
  const avatarState = avatarStateOf(agent);
  const messages = useMessages(agent.id);
  // The person's newest message, which carries the chat's receipt.
  const newestMine = messages.findLast((message) => message.sender === "person")?.id;
  // What the person typed stays with the chat when they leave it and come back.
  const [draft, keepDraft] = useState(() => drafts.get(agent.id) ?? "");
  const setDraft = (text: string) => {
    drafts.set(agent.id, text);
    keepDraft(text);
  };
  const [picked, setPicked] = useState<Picked[]>([]);
  // The message the next one answers, set by a swipe on it.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  // A message on its way to the server, shown faded at the chat's end until the server has it.
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  // Messages made from here on came in while the chat was open, so they arrive with motion.
  const [openedAt] = useState(() => Date.now() - CLOCK_SLACK_MS);

  useEffect(() => {
    loadMessages(agent.id).catch(() => {});
  }, [agent.id]);

  // While the chat is open, everything in it counts as read.
  const latest = agent.latest?.id;
  useFocusEffect(useCallback(() => markRead(agent.id), [agent.id, latest]));
  // Opening the chat clears its notifications from the phone.
  useFocusEffect(useCallback(() => showChatOnScreen(agent.id), [agent.id]));

  // The list is Assist's: drawn upside down, so it opens at the newest message
  // and holds the end as messages arrive, inside the keyboard's own scroll
  // view, which lifts the messages with the keyboard in the same motion as the
  // composer. Its rows run newest first.
  const list = useRef<FlatList<Message>>(null);
  const newestFirst = useMemo(() => [...messages].reverse(), [messages]);
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

  // Scrolling up to the oldest message the app has fetches the page before it, until the chat's beginning.
  const older = useRef<"more" | "loading" | "none">("more");
  function onOldestReached() {
    if (older.current !== "more" || messages.length === 0) return;
    older.current = "loading";
    loadOlder(agent.id).then(
      (more) => (older.current = more ? "more" : "none"),
      () => (older.current = "more"),
    );
  }

  async function onSend(body: string, files: Picked[] = [], answering: Message | null = null) {
    const text = body.trim();
    if (!text && files.length === 0) return;
    setDraft("");
    setPicked([]);
    setReplyTo(null);
    setOutgoing({ body: text, files, quote: answering ? preview(answering) : undefined, after: newestMine });
    haptics.send();
    list.current?.scrollToOffset({ offset: -keyboardInset.current, animated: true });
    try {
      await send(agent.id, text, files, answering?.id);
      // They may leave while the agent works, so this is when a notification starts to matter.
      void askForPush().catch(() => undefined);
    } catch (failure) {
      setDraft(text);
      setPicked(files);
      setReplyTo(answering);
      problem("Not sent", failure);
    } finally {
      setOutgoing(null);
    }
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
        // The receipt moves to each newest message, so the rows draw again when it does.
        extraData={newestMine}
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
        maintainVisibleContentPosition={atEnd ? undefined : { minIndexForVisible: 1 }}
        // As in Messages: dragging the list pulls the keyboard down with the finger, and a tap anywhere in it lowers the keyboard.
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="never"
        onEndReached={onOldestReached}
        onEndReachedThreshold={1.5}
        // Upside down, the list's header is its foot, and its bottom padding is the room at the top of the screen for the floating header.
        contentContainerStyle={{ paddingBottom: insets.top + BAR_HEIGHT + HEADER_OVERHANG + HEADER_CLEARANCE }}
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
              {agent.working && online ? <WorkingRow agent={agent} /> : null}
            </View>
            <View style={{ height: composerHeight }} />
          </View>
        }
        renderItem={({ item, index }) => {
          const older = newestFirst[index + 1];
          return (
            <Row message={item} openedAt={openedAt}>
              {!older || !sameDay(older.created_at, item.created_at) ? (
                <Text style={[styles.day, { color: theme.ink2 }]}>{dayLabel(item.created_at)}</Text>
              ) : null}
              <Bubble
                message={item}
                quoted={item.reply_to ? messages.find((message) => message.id === item.reply_to) : undefined}
                theme={theme}
                receipt={item.id === newestMine}
                onReply={() => setReplyTo(item)}
                onResend={() => onSend(item.body)}
              />
            </Row>
          );
        }}
      />
      <ChatHeader
        name={agent.name}
        avatarId={agent.avatar_id}
        avatarState={online ? (avatarState === "replied" ? "resting" : avatarState) : "resting"}
        dimmed={!online}
        onBack={() => router.back()}
        onAbout={() => router.push(`/agent/${agent.id}`)}
        onFreshStart={() => void freshStart(agent.id).catch((failure) => problem("Couldn't start fresh", failure))}
      />
      <KeyboardStickyView offset={{ closed: 0, opened: keyboardOffset }} style={styles.sticky}>
        {/* The composer's strip is the page colour, as Assist's, so the messages pass under it instead of showing through. */}
        <View style={{ paddingBottom: insets.bottom, backgroundColor: theme.bg }} onLayout={(event) => setComposerHeight(Math.round(event.nativeEvent.layout.height))}>
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
              value={draft}
              onChangeText={setDraft}
              onSend={() => void onSend(draft, picked, replyTo)}
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

/** The agent's avatar at work with its playful line, fading in as the work starts and out as the reply comes. */
function WorkingRow({ agent }: { agent: AgentWithLatest }) {
  const theme = useTheme();
  const line = useWorkingLine();
  return (
    <Animated.View entering={SHOW} exiting={HIDE} style={styles.workingRow}>
      <AvatarView avatarId={agent.avatar_id} state="working" size={48} />
      <FadingText style={[styles.workingText, { color: theme.ink2 }]}>{line}</FadingText>
    </Animated.View>
  );
}

/**
 * A row of the chat. A message that came in while the chat was open rises
 * into place the first time it shows, and the person's own settles from its
 * faded copy where it already sits. The history the chat opens on, and a row
 * scrolled back into view, show as they are.
 */
function Row({ message, openedAt, children }: { message: Message; openedAt: number; children: ReactNode }) {
  const [entering] = useState(() => (message.created_at < openedAt || arrived.has(message.id) ? undefined : message.sender === "person" ? SETTLE : RISE));
  useEffect(() => {
    arrived.add(message.id);
  }, [message.id]);
  return (
    <Animated.View entering={entering} style={styles.row}>
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
  receipt,
  onReply,
  onResend,
}: {
  message: Message;
  quoted: Message | undefined;
  theme: Theme;
  /** Whether the message carries the chat's receipt, as the person's newest does. */
  receipt: boolean;
  onReply: () => void;
  onResend: () => void;
}) {
  if (message.sender === "sidebots") return <Text style={[styles.note, { color: theme.ink2 }]}>{message.body}</Text>;
  const mine = message.sender === "person";
  const shown = message.attachments.map((path) => ({ ...attachment(message.agent_id, path), name: fileName(path) }));
  return (
    <SwipeToReply onReply={onReply}>
      <View style={mine ? styles.mine : styles.theirs}>
        <Sent
          body={message.body}
          quote={message.reply_to ? (quoted ? preview(quoted) : "An earlier message") : undefined}
          photos={shown.filter((item) => isImage(item.name))}
          files={shown.filter((item) => !isImage(item.name))}
          mine={mine}
          theme={theme}
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
 * on, or leaves the thing undone, as soon as one is tapped.
 */
function AskAnswer({ message, ask, theme }: { message: Message; ask: Ask; theme: Theme }) {
  const [sending, setSending] = useState(false);
  if (ask !== "waiting") return <FadingText style={[styles.asked, { color: theme.ink2 }]}>{ASKED[ask]}</FadingText>;
  const answer = (allow: boolean) => {
    haptics.select();
    setSending(true);
    answerAsk(message, allow)
      .catch((failure) => problem("Couldn't answer", failure))
      .finally(() => setSending(false));
  };
  return (
    <Animated.View exiting={HIDE} style={styles.answers}>
      {/* On the bubble's grey, the quieter button is the page colour, as code is. */}
      <Pressable onPress={() => answer(false)} disabled={sending} accessibilityRole="button" style={({ pressed }) => [styles.answer, { backgroundColor: theme.bg, opacity: pressed || sending ? 0.6 : 1 }]}>
        <Text style={[styles.answerText, { color: theme.ink }]}>Don't allow</Text>
      </Pressable>
      <Pressable onPress={() => answer(true)} disabled={sending} accessibilityRole="button" style={({ pressed }) => [styles.answer, { backgroundColor: theme.tint, opacity: pressed || sending ? 0.6 : 1 }]}>
        <Text style={[styles.answerText, { color: theme.onTint }]}>Allow</Text>
      </Pressable>
    </Animated.View>
  );
}

/**
 * A message as the chat draws it: its photos and files above its bubble, as
 * Assist draws one, and the message it answers quoted at the bubble's top.
 * The agent's words are markdown; the person's are as they typed them.
 * `foot` sits under the words, inside the bubble.
 */
function Sent({ body, quote, photos, files, mine, theme, foot }: { body: string; quote?: string; photos: Shown[]; files: Shown[]; mine: boolean; theme: Theme; foot?: ReactNode }) {
  const quiet = mine ? theme.onTint : theme.ink2;
  return (
    <>
      {photos.length ? <MessagePhotos photos={photos} end={mine} /> : null}
      {files.map((file) => (
        <FileCard key={file.uri} file={file} />
      ))}
      {body || quote ? (
        <View style={[styles.bubble, mine ? [styles.bubbleMine, { backgroundColor: theme.tint }] : [styles.bubbleTheirs, { backgroundColor: theme.bubble }]]}>
          {quote ? (
            <View style={[styles.quote, { borderLeftColor: quiet }]} accessibilityLabel={`In reply to: ${quote}`}>
              <Text numberOfLines={3} style={[styles.quoteText, { color: quiet }]}>
                {quote}
              </Text>
            </View>
          ) : null}
          {body && mine ? (
            <Text selectable style={[styles.text, { color: theme.onTint }]}>
              {body}
            </Text>
          ) : body ? (
            <Markdown text={body} />
          ) : null}
          {foot}
        </View>
      ) : null}
    </>
  );
}


/** A sent file's own name, without the folder and the code the server puts before it. */
function fileName(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.slice(name.indexOf("-") + 1);
}

/**
 * A message the person sent that the server hasn't answered for yet, with
 * what it quotes when it is a reply. `after` is the person's newest message
 * when they sent it, so the copy goes once a newer one is in the chat.
 */
type Outgoing = { body: string; files: Picked[]; quote?: string; after: string | undefined };

// What the person had typed in each chat, kept while the app runs.
const drafts = new Map<string, string>();
// The person's message shows this faded until the server has it.
const PENDING_OPACITY = 0.7;
// A new message rises into the chat. The person's own settles from its faded copy, which already sits there.
const RISE = arrive(0, 12);
const SETTLE = arrive(PENDING_OPACITY, 0);
// How an ask ended, as its bubble says it.
const ASKED: Record<Exclude<Ask, "waiting">, string> = { allowed: "Allowed", refused: "Not allowed", unanswered: "Not answered" };
// The messages that have come in with motion, so a row scrolled away and back shows as it is.
const arrived = new Set<string>();
// The phone's clock and the server's may disagree by a little.
const CLOCK_SLACK_MS = 2000;

// The resting composer's height above the home indicator, used until it is measured.
const COMPOSER_ESTIMATE = 64;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  row: { paddingHorizontal: 12 },
  foot: { paddingHorizontal: 12, paddingBottom: 10 },
  day: { alignSelf: "center", fontSize: 13, marginTop: 12, marginBottom: 6 },
  mine: { alignItems: "flex-end", marginTop: 6, gap: 4 },
  theirs: { alignItems: "flex-start", marginTop: 6, gap: 4 },
  pending: { opacity: PENDING_OPACITY },
  bubble: { maxWidth: "80%", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  bubbleMine: { borderBottomRightRadius: 6 },
  bubbleTheirs: { borderBottomLeftRadius: 6 },
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
  workingRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10, paddingLeft: 2 },
  workingText: { fontSize: 15, fontStyle: "italic" },
  sticky: { position: "absolute", left: 0, right: 0, bottom: 0 },
  above: { paddingHorizontal: 12, paddingTop: 8 },
  bar: { paddingHorizontal: 12, paddingTop: 8 },
});
