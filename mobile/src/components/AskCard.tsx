import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import { Cable, ChevronRight, FilePenLine, Globe, Lightbulb, Plug, Terminal } from "lucide-react-native";
import { fenced, type Question } from "@server/contract";
import type { Stacked } from "@client/suggestions";
import { AvatarView } from "@/components/AvatarView";
import { BrandLogo } from "@/components/BrandLogo";
import { Markdown } from "@/components/Markdown";
import { haptics } from "@/lib/haptics";
import { EASE, HIDE, SHOW } from "@/lib/motion";
import { useAgent, useConnections } from "@/lib/state";
import { useTheme } from "@/lib/theme";

const ICONS = { command: Terminal, page: Globe, file: FilePenLine, tool: Plug, connection: Cable, work: Lightbulb };
// What an ask of each kind keeps behind its tap, as the words after "Show" and "Hide". An ask for a connection keeps nothing there.
const DETAIL = { command: "the command", page: "the address", file: "the file", tool: "everything it was given", connection: "", work: "what it will do" };

/**
 * What an agent asks to do, inside its bubble: the sort of thing it is, this
 * one in plain words, the facts that matter and the provider's reason for
 * asking. The thing itself, such as the command, opens on a tap, so a person
 * reads words first and can still see all that Allow lets happen. `from` is
 * the agent that asks, for an ask shown in another agent's chat, and the card
 * then says whose it is. An ask for a connection wears the connection's logo,
 * once the phone has the computer's list of them. A suggestion is drawn the
 * same way, with the work it offers as its words and the agent's reason
 * under them. At the top of a stack of several it says its `place` there.
 */
export function AskCard({ question, from, place }: { question: Question; from?: string; place?: Stacked }) {
  const theme = useTheme();
  const asker = useAgent(from ?? "");
  const [open, setOpen] = useState(false);
  const turned = useAnimatedStyle(() => ({ transform: [{ rotate: withTiming(open ? "90deg" : "0deg", EASE) }] }));
  const Icon = ICONS[question.kind];
  const logo = useConnections()?.find((each) => each.connection === question.connection)?.logo;
  const toggle = () => {
    haptics.select();
    setOpen((shown) => !shown);
  };
  return (
    <View>
      {asker ? (
        <View style={styles.asker}>
          <AvatarView avatarId={asker.avatar_id} state="resting" size={18} />
          <Text style={[styles.small, { color: theme.ink2 }]}>{asker.name} asks</Text>
        </View>
      ) : null}
      <View style={styles.kind}>
        {logo ? <BrandLogo logo={logo} size={14} /> : <Icon size={14} strokeWidth={2.25} color={theme.ink2} />}
        <Text style={[styles.small, { color: theme.ink2 }]}>{question.title}</Text>
        {place && place.of > 1 ? (
          <Text style={[styles.small, styles.place, { color: theme.ink2 }]}>
            {place.at} of {place.of}
          </Text>
        ) : null}
      </View>
      <Text selectable style={[styles.what, { color: theme.ink }]}>
        {question.what}
      </Text>
      {question.facts.map(([label, value]) => (
        <Text key={label} selectable style={[styles.line, { color: theme.ink }]}>
          <Text style={{ color: theme.ink2 }}>{label}  </Text>
          {value}
        </Text>
      ))}
      {question.why ? <Text style={[styles.line, styles.why, { color: theme.ink2 }]}>{question.why}</Text> : null}
      {question.detail ? (
        <Pressable onPress={toggle} hitSlop={8} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.more}>
          <Animated.View style={turned}>
            <ChevronRight size={14} strokeWidth={2.25} color={theme.tintInk} />
          </Animated.View>
          <Text style={[styles.small, { color: theme.tintInk }]}>
            {open ? "Hide" : "Show"} {DETAIL[question.kind]}
          </Text>
        </Pressable>
      ) : null}
      {open ? (
        <Animated.View entering={SHOW} exiting={HIDE}>
          <Markdown text={fenced(question.detail)} />
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  asker: { flexDirection: "row", alignItems: "center", gap: 6, marginLeft: -2, marginBottom: 6 },
  kind: { flexDirection: "row", alignItems: "center", gap: 5 },
  small: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  place: { flex: 1, textAlign: "right", fontWeight: "400", fontVariant: ["tabular-nums"], marginLeft: 12 },
  what: { fontSize: 17, lineHeight: 22, fontWeight: "600", marginTop: 1, marginBottom: 6 },
  line: { fontSize: 15, lineHeight: 20 },
  why: { marginTop: 6 },
  more: { flexDirection: "row", alignItems: "center", gap: 3, marginLeft: -3, marginTop: 8, marginBottom: 8 },
});
