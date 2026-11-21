import { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { exchanges, type AgentWithLatest, type Message } from "@server/contract";
import { standingOf } from "@client/exchanges";
import { AvatarView } from "@/components/AvatarView";
import { ChatBubble } from "@/components/ChatBubble";
import { BAR_HEIGHT, HEADER_CLEARANCE, HEADER_OVERHANG, Named } from "@/components/ChatHeader";
import { EdgeFade } from "@/components/EdgeFade";
import { Specks } from "@/components/Exchange";
import { Markdown } from "@/components/Markdown";
import { WorkingLine } from "@/components/WorkingLine";
import { useAgent, useChatColor, useMessages } from "@/lib/state";
import { ChatColor, useTheme } from "@/lib/theme";

/**
 * An exchange between two of the person's agents, to read in full: a chat of
 * the two agents' own, with no message field, since nothing in it is the
 * person's to say. `agent` is the agent whose chat it was opened from, and
 * `message` is a message of the exchange. The agent that asked first has the
 * right of the chat and its chat's colour, as the person has in their own.
 */
export default function ExchangeSheet() {
  const theme = useTheme();
  const router = useRouter();
  const { agent, message } = useLocalSearchParams<{ agent: string; message: string }>();
  const messages = useMessages(agent);
  const exchange = useMemo(() => exchanges(messages).find((each) => each.some((said) => said.id === message)), [messages, message]);
  const first = useAgent(exchange?.[0].agent_id ?? "");
  const other = useAgent(exchange?.[0].peer_id ?? "");
  const color = useChatColor(first);
  return (
    <View style={[styles.sheet, { backgroundColor: theme.bg }]}>
      {exchange && first && other ? (
        <ChatColor value={color}>
          <Said exchange={exchange} messages={messages} first={first} other={other} />
        </ChatColor>
      ) : null}
      <Pressable onPress={() => router.back()} accessibilityRole="button" hitSlop={10} style={styles.done}>
        <Text style={[styles.doneText, { color: theme.tintInk }]}>Done</Text>
      </Pressable>
    </View>
  );
}

/**
 * What the two agents said, as a chat draws it: the newest at the foot, under
 * a header of both avatars that the messages pass under. While the newest
 * thing asked has no answer, a line at the foot says where it stands.
 */
function Said({ exchange, messages, first, other }: { exchange: Message[]; messages: Message[]; first: AgentWithLatest; other: AgentWithLatest }) {
  const insets = useSafeAreaInsets();
  const newestFirst = useMemo(() => [...exchange].reverse(), [exchange]);
  const { asked, state } = standingOf(exchange, messages);
  // The header reads as the chat's line does: from the agent that asked last to the one it asked.
  const [from, to] = asked.agent_id === first.id ? [first, other] : [other, first];
  return (
    <>
      <FlatList
        data={newestFirst}
        inverted
        keyExtractor={(said) => said.id}
        // Upside down, the list's header is its foot, and its bottom padding is the room at the top for the floating header.
        contentContainerStyle={styles.said}
        ListHeaderComponent={
          <View style={{ paddingBottom: insets.bottom + FOOT }}>
            {state === "Answered" ? null : <WorkingLine running={state === "Waiting"}>{state === "Waiting" ? `Waiting on ${to.name}` : state}</WorkingLine>}
          </View>
        }
        renderItem={({ item }) => {
          const mine = item.agent_id === first.id;
          const by = mine ? first : other;
          // The avatar beside a message names who said it.
          const avatar = (
            <View accessible accessibilityRole="image" accessibilityLabel={by.name}>
              <AvatarView avatarId={by.avatar_id} state="resting" size={BESIDE} />
            </View>
          );
          return (
            <View style={[styles.row, mine ? styles.mine : styles.theirs]}>
              {mine ? null : avatar}
              <ChatBubble mine={mine}>
                <Markdown text={item.body} on={mine ? "tint" : "bubble"} />
              </ChatBubble>
              {mine ? avatar : null}
            </View>
          );
        }}
      />
      <EdgeFade edge="top" height={HEADER + HEADER_CLEARANCE} solid={TOP} />
      <View pointerEvents="none" style={styles.header}>
        <Named name={`${from.name} and ${to.name}`}>
          <AvatarView avatarId={from.avatar_id} state="resting" size={AVATAR} />
          <Specks flowing={state === "Waiting"} width={LINK} size={SPECK} />
          <AvatarView avatarId={to.avatar_id} state="resting" size={AVATAR} />
        </Named>
      </View>
    </>
  );
}

// The header's avatars, as a chat's, the dotted line between them and its specks, and the smaller avatar beside each message.
const AVATAR = 40;
const LINK = 26;
const SPECK = 3;
const BESIDE = 22;
// The room above the header's avatars, and how far down the sheet the header reaches, as a chat's does under the status bar.
const TOP = 10;
const HEADER = TOP + BAR_HEIGHT + HEADER_OVERHANG;
// The room under the last message, above the home indicator.
const FOOT = 10;

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  // Done stays at the sheet's top while the messages scroll under it.
  done: { position: "absolute", top: 0, right: 0, zIndex: 3, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 },
  doneText: { fontSize: 17, fontWeight: "600" },
  header: { position: "absolute", top: TOP, left: 0, right: 0, alignItems: "center", zIndex: 2 },
  said: { paddingBottom: HEADER + HEADER_CLEARANCE, paddingHorizontal: 12 },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 6, marginTop: 6 },
  mine: { justifyContent: "flex-end" },
  theirs: { justifyContent: "flex-start" },
});
