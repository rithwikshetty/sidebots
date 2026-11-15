import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSharedValue } from "react-native-reanimated";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import type { AgentWithLatest, Message } from "@server/contract";
import { BAR_HEIGHT, ChatHeader, HEADER_CLEARANCE, HEADER_OVERHANG } from "@/components/ChatHeader";
import { Composer } from "@/components/Composer";
import { PetView } from "@/components/PetView";
import { useWorkingLine } from "@/lib/lines";
import { loadMessages, markSeen, send, useAgent, useMessages, useOnline, usePetState } from "@/lib/state";
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
  const petState = usePetState(agent);
  const messages = useMessages(agent.id);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    loadMessages(agent.id).catch(() => {});
  }, [agent.id]);

  // While the chat is open, everything in it counts as seen.
  const latest = agent.latest?.id;
  useFocusEffect(useCallback(() => markSeen(agent.id), [agent.id, latest]));

  // The list is one built for chat. It opens at the newest message, holds the
  // end as messages arrive and as the keyboard rises, and leaves the person
  // where they are once they scroll up to read. It learns the composer's height
  // from here, so the last message always rests just above the composer.
  const list = useRef<LegendListRef>(null);
  const contentInsetEndAdjustment = useSharedValue(COMPOSER_ESTIMATE + insets.bottom);

  async function onSend(body: string) {
    const text = body.trim();
    if (!text) return;
    setDraft("");
    try {
      await send(agent.id, text);
      void list.current?.scrollToEnd({ animated: true });
    } catch (failure) {
      setDraft(text);
      Alert.alert("Not sent", failure instanceof Error ? failure.message : "Something went wrong.");
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
        applyWorkaroundForContentInsetHitTestBug
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={<View style={{ height: insets.top + BAR_HEIGHT + HEADER_OVERHANG + HEADER_CLEARANCE }} />}
        ListFooterComponent={<View style={styles.foot}>{agent.working && online ? <WorkingRow agent={agent} /> : null}</View>}
        renderItem={({ item, index }) => {
          const older = messages[index - 1];
          return (
            <View style={styles.row}>
              {!older || !sameDay(older.created_at, item.created_at) ? (
                <Text style={[styles.day, { color: theme.ink2 }]}>{dayLabel(item.created_at)}</Text>
              ) : null}
              <Bubble message={item} theme={theme} onResend={() => onSend(item.body)} />
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
      />
      <KeyboardStickyView offset={{ closed: 0, opened: keyboardOffset }} style={styles.sticky}>
        <View style={[styles.composer, { paddingBottom: insets.bottom + 8 }]} onLayout={(event) => contentInsetEndAdjustment.set(event.nativeEvent.layout.height)}>
          <Composer value={draft} onChangeText={setDraft} onSend={() => void onSend(draft)} placeholder={`Message ${agent.name}`} />
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

function Bubble({ message, theme, onResend }: { message: Message; theme: Theme; onResend: () => void }) {
  if (message.sender === "simon") return <Text style={[styles.note, { color: theme.ink2 }]}>{message.body}</Text>;
  const mine = message.sender === "person";
  return (
    <View style={mine ? styles.mine : styles.theirs}>
      <View style={[styles.bubble, mine ? [styles.bubbleMine, { backgroundColor: theme.tint }] : [styles.bubbleTheirs, { backgroundColor: theme.bubble }]]}>
        <Text selectable style={[styles.text, { color: mine ? theme.onTint : theme.ink }]}>
          {message.body}
        </Text>
      </View>
      {mine && message.status === "failed" ? (
        <Pressable onPress={onResend} hitSlop={8}>
          <Text style={[styles.resend, { color: theme.tintInk }]}>Send again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// The resting composer's height above the home indicator, used until it is measured.
const COMPOSER_ESTIMATE = 64;
// Keeps the list at its end when a message arrives, a row changes height or the list resizes.
const FOLLOW_END = { animated: false, on: { dataChange: true, itemLayout: true, layout: true } } as const;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  row: { paddingHorizontal: 12 },
  foot: { paddingHorizontal: 12, paddingBottom: 10 },
  day: { alignSelf: "center", fontSize: 13, marginTop: 12, marginBottom: 6 },
  mine: { alignItems: "flex-end", marginTop: 6 },
  theirs: { alignItems: "flex-start", marginTop: 6 },
  bubble: { maxWidth: "80%", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  bubbleMine: { borderBottomRightRadius: 6 },
  bubbleTheirs: { borderBottomLeftRadius: 6 },
  text: { fontSize: 17, lineHeight: 22 },
  note: { alignSelf: "center", textAlign: "center", fontSize: 13, lineHeight: 18, marginTop: 10, paddingHorizontal: 24 },
  resend: { fontSize: 13, fontWeight: "600", marginTop: 4, marginRight: 4 },
  workingRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10, paddingLeft: 2 },
  workingText: { fontSize: 15, fontStyle: "italic" },
  sticky: { position: "absolute", left: 0, right: 0, bottom: 0 },
  composer: { paddingHorizontal: 12, paddingTop: 8 },
});
