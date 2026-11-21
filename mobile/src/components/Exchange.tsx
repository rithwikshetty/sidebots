import { useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, ReduceMotion, interpolate, useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from "react-native-reanimated";
import { ChevronRight } from "lucide-react-native";
import type { Message } from "@server/contract";
import type { Standing } from "@client/exchanges";
import { AvatarView } from "@/components/AvatarView";
import { FadingText } from "@/components/FadingText";
import { FlowDot } from "@/components/FlowDot";
import { haptics } from "@/lib/haptics";
import { useAgent } from "@/lib/state";
import { useTheme } from "@/lib/theme";

const AVATAR = 22;
// The dotted line between the two avatars, its specks, and the dot that crosses it.
const LINK = 20;
const SPECK = 2;
const DOT = 4;
// The dot leaves once the line has risen into the chat, and the other avatar nods as it lands.
const CROSS = { duration: 700, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.System } as const;
const CROSS_AFTER_MS = 260;
const NOD = { duration: 180, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System } as const;
const NOD_AFTER_MS = CROSS_AFTER_MS + CROSS.duration - 60;

/**
 * An exchange between two of the person's agents, as one line in both their
 * chats: the two avatars, who asked whom last, and where that stands. A tap
 * opens the exchange to read. While it waits for the answer, the specks of
 * the line between the avatars light in turn, from the asker to the other,
 * and they rest while it needs the person's OK. `asked` is the newest thing
 * asked in it. An `arriving` one was asked while the chat was open: a dot
 * crosses from the asker to the other, which nods as it lands.
 */
export function Exchange({ asked, state, arriving, onOpen }: { asked: Message; state: Standing; arriving: boolean; onOpen: () => void }) {
  const theme = useTheme();
  const from = useAgent(asked.agent_id);
  const to = useAgent(asked.peer_id ?? "");
  const [crosses] = useState(arriving);
  const crossed = useSharedValue(crosses ? 0 : 1);
  const nodded = useSharedValue(1);
  useEffect(() => {
    if (!crosses) return;
    crossed.value = withDelay(CROSS_AFTER_MS, withTiming(1, CROSS));
    nodded.value = withDelay(NOD_AFTER_MS, withSequence(withTiming(1.14, NOD), withTiming(1, NOD)));
  }, [crosses, crossed, nodded]);
  const crossing = useAnimatedStyle(() => ({
    opacity: interpolate(crossed.value, [0, 0.2, 0.8, 1], [0, 1, 1, 0]),
    transform: [{ translateX: crossed.value * (LINK - DOT) }],
  }));
  const nod = useAnimatedStyle(() => ({ transform: [{ scale: nodded.value }] }));
  if (!from || !to) return null;

  const open = () => {
    haptics.select();
    onOpen();
  };
  return (
    <View style={styles.exchange}>
      <Pressable onPress={open} hitSlop={8} accessibilityRole="button" accessibilityLabel={`${from.name} asked ${to.name}. ${state}`} style={styles.head}>
        <AvatarView avatarId={from.avatar_id} state="resting" size={AVATAR} />
        <Specks flowing={state === "Waiting"} width={LINK} size={SPECK}>
          <Animated.View style={[styles.courier, { backgroundColor: theme.tint }, crossing]} />
        </Specks>
        <Animated.View style={nod}>
          <AvatarView avatarId={to.avatar_id} state="resting" size={AVATAR} />
        </Animated.View>
        <Text numberOfLines={1} style={[styles.words, { color: theme.ink2 }]}>
          <Text style={[styles.loud, { color: theme.ink }]}>{from.name}</Text> asked <Text style={[styles.loud, { color: theme.ink }]}>{to.name}</Text> ·
        </Text>
        <FadingText numberOfLines={1} style={[styles.words, state === "Needs your OK" ? [styles.loud, { color: theme.ink }] : { color: theme.ink2 }]}>
          {state}
        </FadingText>
        <ChevronRight size={14} strokeWidth={2.25} color={theme.faint} />
      </Pressable>
    </View>
  );
}

/**
 * The dotted line between two agents' avatars, `width` across. While
 * `flowing`, its specks light in turn, from the agent that asked to the
 * other. What crosses the line is drawn over it.
 */
export function Specks({ flowing, width, size, children }: { flowing: boolean; width: number; size: number; children?: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.link, { width }]}>
      {[0, 1, 2, 3].map((speck) => (
        <FlowDot key={speck} index={speck} running={flowing} size={size} color={flowing ? theme.ink2 : theme.faint} />
      ))}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  exchange: { alignItems: "flex-start", marginTop: 10 },
  head: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 2, maxWidth: "100%" },
  link: { height: DOT, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  courier: { position: "absolute", left: 0, top: 0, width: DOT, height: DOT, borderRadius: DOT / 2 },
  words: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
  loud: { fontWeight: "600" },
});
