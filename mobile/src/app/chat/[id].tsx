import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSharedValue } from "react-native-reanimated";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { Reply, X } from "lucide-react-native";
import type { AgentWithLatest, Message } from "@server/contract";
import { BAR_HEIGHT, ChatHeader, HEADER_CLEARANCE, HEADER_OVERHANG } from "@/components/ChatHeader";
import { Composer } from "@/components/Composer";
import { IconButton } from "@/components/IconButton";
import { FileCard, MessagePhotos, type Shown } from "@/components/MessageAttachments";
import { PetView } from "@/components/PetView";
import { SwipeToReply } from "@/components/SwipeToReply";
import { problem } from "@/lib/alerts";
import { attachmentUrl } from "@/lib/api";
import { isImage, MAX_FILES, pick, type Picked, type PickSource } from "@/lib/files";
import { haptics } from "@/lib/haptics";
import { useWorkingLine } from "@/lib/lines";
import { preview } from "@/lib/messages";
import { askForPush, showChatOnScreen } from "@/lib/push";
import { changeAgent, freshStart, loadMessages, loadOlder, markRead, petStateOf, send, useAgent, useMessages, useOnline } from "@/lib/state";
import { type Theme, useTheme } from "@/lib/theme";
import { dayLabel, sameDay } from "@/lib/time";

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const agent = useAgent(id);
  return agent ? <ChatWith agent={agent} /> : null;
}

function ChatWith({ agent }: { agent: AgentWithLatest }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const online = useOnline();
  const petState = petStateOf(agent);
  const messages = useMessages(agent.id);
  const [draft, setDraft] = useState("");
  const [picked, setPicked] = useState<Picked[]>([]);
  // The message the next one answers, set by a swipe on it.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  // A message on its way to the server, shown faded at the chat's end until the server has it.
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);

  useEffect(() => {
    loadMessages(agent.id).catch(() => {});
  }, [agent.id]);

  // While the chat is open, everything in it counts as read.
  const latest = agent.latest?.id;
  useFocusEffect(useCallback(() => markRead(agent.id), [agent.id, latest]));
  // Opening the chat clears its notifications from the phone.
  useFocusEffect(useCallback(() => showChatOnScreen(agent.id), [agent.id]));

  // The list is one built for chat. It opens at the newest message, holds the
  // end as messages arrive and as the keyboard rises, and leaves the person
  // where they are once they scroll up to read. It learns the composer's height
  // from here, so the last message always rests just above the composer.
  const list = useRef<LegendListRef>(null);
  const contentInsetEndAdjustment = useSharedValue(COMPOSER_ESTIMATE + insets.bottom);

  // Scrolling up to the oldest message the app has fetches the page before it, until the chat's beginning.
  const older = useRef<"more" | "loading" | "none">("more");
  function onStartReached() {
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
    setOutgoing({ body: text, files, quote: answering ? preview(answering) : undefined });
    haptics.send();
    void list.current?.scrollToEnd({ animated: true });
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
    try {
      const added = await pick(source, MAX_FILES - picked.length);
      setPicked((current) => [...current, ...added].slice(0, MAX_FILES));
    } catch (failure) {
      problem("Can't add that", failure);
    }
  }

  // The keyboard covers the home indicator, so the list and the composer rise by
  // the keyboard's height less that inset, frame by frame with the keyboard.
  const keyboardOffset = insets.bottom;

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <Stack.Screen options={{ title: agent.name }} />
      {/* The list fills the screen; messages scroll up under the floating header and down behind the composer. */}
      <KeyboardAwareLegendList
        ref={list}
        style={styles.screen}
        data={messages}
        keyExtractor={(message) => message.id}
        estimatedItemSize={72}
        alignItemsAtEnd
        initialScrollAtEnd
        maintainScrollAtEnd={FOLLOW_END}
        maintainVisibleContentPosition
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustsScrollIndicatorInsets={false}
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        keyboardOffset={keyboardOffset}
        keyboardLiftBehavior="whenAtEnd"
        onStartReached={onStartReached}
        onStartReachedThreshold={0.5}
        applyWorkaroundForContentInsetHitTestBug
        // As in Messages: dragging the list pulls the keyboard down with the finger, and a tap anywhere in it lowers the keyboard.
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="never"
        ListHeaderComponent={<View style={{ height: insets.top + BAR_HEIGHT + HEADER_OVERHANG + HEADER_CLEARANCE }} />}
        ListFooterComponent={
          <View style={styles.foot}>
            {outgoing ? (
              <View style={[styles.mine, styles.pending]}>
                <Sent
                  body={outgoing.body}
                  quote={outgoing.quote}
                  photos={outgoing.files.filter((file) => file.photo)}
                  files={outgoing.files.filter((file) => !file.photo)}
                  mine
                  theme={theme}
                />
              </View>
            ) : null}
            {agent.working && online ? <WorkingRow agent={agent} /> : null}
          </View>
        }
        renderItem={({ item, index }) => {
          const older = messages[index - 1];
          return (
            <View style={styles.row}>
              {!older || !sameDay(older.created_at, item.created_at) ? (
                <Text style={[styles.day, { color: theme.ink2 }]}>{dayLabel(item.created_at)}</Text>
              ) : null}
              <Bubble
                message={item}
                quoted={item.reply_to ? messages.find((message) => message.id === item.reply_to) : undefined}
                theme={theme}
                onReply={() => setReplyTo(item)}
                onResend={() => onSend(item.body)}
              />
            </View>
          );
        }}
      />
      <ChatHeader
        name={agent.name}
        petId={agent.pet_id}
        petState={online ? (petState === "replied" ? "resting" : petState) : "resting"}
        dimmed={!online}
        onBack={() => router.back()}
        onAbout={() => router.push(`/agent/${agent.id}`)}
        onFreshStart={() => void freshStart(agent.id).catch((failure) => problem("Couldn't start fresh", failure))}
      />
      <KeyboardStickyView offset={{ closed: 0, opened: keyboardOffset }} style={styles.sticky}>
        <View style={[styles.composer, { paddingBottom: insets.bottom + 8 }]} onLayout={(event) => contentInsetEndAdjustment.set(event.nativeEvent.layout.height)}>
          {replyTo ? (
            <View style={[styles.replying, { backgroundColor: theme.card, borderColor: theme.line }]}>
              <Reply size={16} strokeWidth={2} color={theme.ink2} />
              <View style={styles.replyingText}>
                <Text style={[styles.replyingTitle, { color: theme.ink }]}>Replying to {replyTo.sender === "person" ? "yourself" : agent.name}</Text>
                <Text numberOfLines={1} style={[styles.replyingQuote, { color: theme.ink2 }]}>
                  {preview(replyTo)}
                </Text>
              </View>
              <IconButton icon={X} label="Cancel reply" size={28} iconSize={16} color={theme.ink2} onPress={() => setReplyTo(null)} />
            </View>
          ) : null}
          <Composer
            value={draft}
            onChangeText={setDraft}
            onSend={() => void onSend(draft, picked, replyTo)}
            model={agent.model}
            effort={agent.effort}
            onThinking={(change) => void changeAgent(agent.id, change).catch((failure) => problem("Couldn't change that", failure))}
            placeholder={`Message ${agent.name}`}
            attachments={picked}
            onAttach={onAttach}
            onRemoveAttachment={(file) => setPicked((current) => current.filter((item) => item !== file))}
            attachDisabled={picked.length >= MAX_FILES}
          />
        </View>
      </KeyboardStickyView>
    </View>
  );
}

function WorkingRow({ agent }: { agent: AgentWithLatest }) {
  const theme = useTheme();
  const line = useWorkingLine();
  return (
    <View style={styles.workingRow}>
      <PetView petId={agent.pet_id} state="working" size={48} />
      <Text style={[styles.workingText, { color: theme.ink2 }]}>{line}</Text>
    </View>
  );
}

/**
 * A message in the chat. A swipe right on it replies to it. `quoted` is the
 * message it answers, when it answers one the app has.
 */
function Bubble({ message, quoted, theme, onReply, onResend }: { message: Message; quoted: Message | undefined; theme: Theme; onReply: () => void; onResend: () => void }) {
  if (message.sender === "simon") return <Text style={[styles.note, { color: theme.ink2 }]}>{message.body}</Text>;
  const mine = message.sender === "person";
  const shown = message.attachments.map((path) => ({ uri: attachmentUrl(message.agent_id, path), name: fileName(path) }));
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
        />
        {mine && message.status === "failed" ? (
          <Pressable onPress={onResend} hitSlop={8}>
            <Text style={[styles.resend, { color: theme.tintInk }]}>Send again</Text>
          </Pressable>
        ) : null}
      </View>
    </SwipeToReply>
  );
}

/**
 * A message as the chat draws it: its photos and files above its bubble, as
 * Assist draws one, and the message it answers quoted at the bubble's top.
 */
function Sent({ body, quote, photos, files, mine, theme }: { body: string; quote?: string; photos: Shown[]; files: Shown[]; mine: boolean; theme: Theme }) {
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
          {body ? (
            <Text selectable style={[styles.text, { color: mine ? theme.onTint : theme.ink }]}>
              {body}
            </Text>
          ) : null}
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

/** A message the person sent that the server hasn't answered for yet, with what it quotes when it is a reply. */
type Outgoing = { body: string; files: Picked[]; quote?: string };

// The resting composer's height above the home indicator, used until it is measured.
const COMPOSER_ESTIMATE = 64;
// Keeps the list at its end when a message arrives, a row changes height or the list resizes.
const FOLLOW_END = { animated: false, on: { dataChange: true, itemLayout: true, layout: true } } as const;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  row: { paddingHorizontal: 12 },
  foot: { paddingHorizontal: 12, paddingBottom: 10 },
  day: { alignSelf: "center", fontSize: 13, marginTop: 12, marginBottom: 6 },
  mine: { alignItems: "flex-end", marginTop: 6, gap: 4 },
  theirs: { alignItems: "flex-start", marginTop: 6, gap: 4 },
  pending: { opacity: 0.7 },
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
    marginBottom: 8,
    paddingLeft: 14,
    paddingRight: 8,
    paddingVertical: 8,
    borderRadius: 18,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  replyingText: { flex: 1 },
  replyingTitle: { fontSize: 13, fontWeight: "600" },
  replyingQuote: { fontSize: 13, lineHeight: 18 },
  note: { alignSelf: "center", textAlign: "center", fontSize: 13, lineHeight: 18, marginTop: 10, paddingHorizontal: 24 },
  resend: { fontSize: 13, fontWeight: "600", marginTop: 4, marginRight: 4 },
  workingRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10, paddingLeft: 2 },
  workingText: { fontSize: 15, fontStyle: "italic" },
  sticky: { position: "absolute", left: 0, right: 0, bottom: 0 },
  composer: { paddingHorizontal: 12, paddingTop: 8 },
});
