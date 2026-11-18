import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import { ChevronRight, FilePenLine, Globe, Plug, Terminal } from "lucide-react-native";
import { fenced, type Question } from "@server/contract";
import { Markdown } from "@/components/Markdown";
import { haptics } from "@/lib/haptics";
import { EASE, HIDE, SHOW } from "@/lib/motion";
import { useTheme } from "@/lib/theme";

const ICONS = { command: Terminal, page: Globe, file: FilePenLine, tool: Plug };
// What an ask of each kind keeps behind its tap, as the words after "Show" and "Hide".
const DETAIL = { command: "the command", page: "the address", file: "the file", tool: "everything it was given" };

/**
 * What an agent asks to do, inside its bubble: the sort of thing it is, this
 * one in plain words, the facts that matter and the provider's reason for
 * asking. The thing itself, such as the command, opens on a tap, so a person
 * reads words first and can still see all that Allow lets happen.
 */
export function AskCard({ question }: { question: Question }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const turned = useAnimatedStyle(() => ({ transform: [{ rotate: withTiming(open ? "90deg" : "0deg", EASE) }] }));
  const Icon = ICONS[question.kind];
  const toggle = () => {
    haptics.select();
    setOpen((shown) => !shown);
  };
  return (
    <View>
      <View style={styles.kind}>
        <Icon size={14} strokeWidth={2.25} color={theme.ink2} />
        <Text style={[styles.small, { color: theme.ink2 }]}>{question.title}</Text>
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
  kind: { flexDirection: "row", alignItems: "center", gap: 5 },
  small: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
  what: { fontSize: 17, lineHeight: 22, fontWeight: "600", marginTop: 1, marginBottom: 6 },
  line: { fontSize: 15, lineHeight: 20 },
  why: { marginTop: 6 },
  more: { flexDirection: "row", alignItems: "center", gap: 3, marginLeft: -3, marginTop: 8, marginBottom: 8 },
});
