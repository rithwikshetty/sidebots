import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, ReduceMotion, interpolate, useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from "react-native-reanimated";
import { ChevronRight } from "lucide-react-native";
import type { Message } from "@server/contract";
import { AvatarView } from "@/components/AvatarView";
import { FadingText } from "@/components/FadingText";
import { FlowDot } from "@/components/FlowDot";
import { Markdown } from "@/components/Markdown";
import { haptics } from "@/lib/haptics";
import { EASE, HIDE, SHOW } from "@/lib/motion";
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
 * What one of the person's agents asked another, as one line in both their
 * chats: the two avatars, who asked whom, and where it stands. A tap opens
 * what was asked and, once it has come, the answer. While it waits for the
 * answer, the specks of the line between the avatars light in turn, from the
 * asker to the other. `needsPerson` is true while the agent that was asked
 * waits on the person's answer to an ask of its own, and the specks rest.
 * An `arriving` one came in while the chat was open: a dot crosses from the
 * asker to the other, which nods as it lands.
 */
export function Exchange({ asked, answer, needsPerson, arriving }: { asked: Message; answer: Message | undefined; needsPerson: boolean; arriving: boolean }) {
  const theme = useTheme();
  const from = useAgent(asked.agent_id);
  const to = useAgent(asked.peer_id ?? "");
  const [open, setOpen] = useState(false);
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
  const turned = useAnimatedStyle(() => ({ transform: [{ rotate: withTiming(open ? "90deg" : "0deg", EASE) }] }));
  if (!from || !to) return null;

  const waitsOnPerson = needsPerson && !answer;
  const state = answer ? "Answered" : asked.status === "failed" ? "No answer" : waitsOnPerson ? "Needs your OK" : "Waiting";
  const waiting = state === "Waiting";
  const toggle = () => {
    haptics.select();
    setOpen((shown) => !shown);
  };
  return (
    <View style={styles.exchange}>
      <Pressable
        onPress={toggle}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`${from.name} asked ${to.name}. ${state}`}
        accessibilityState={{ expanded: open }}
        style={styles.head}>
        <AvatarView avatarId={from.avatar_id} state="resting" size={AVATAR} />
        <View style={styles.link}>
          {[0, 1, 2, 3].map((speck) => (
            <FlowDot key={speck} index={speck} running={waiting} size={SPECK} color={waiting ? theme.ink2 : theme.faint} />
          ))}
          <Animated.View style={[styles.courier, { backgroundColor: theme.tint }, crossing]} />
        </View>
        <Animated.View style={nod}>
          <AvatarView avatarId={to.avatar_id} state="resting" size={AVATAR} />
        </Animated.View>
        <Text numberOfLines={1} style={[styles.words, { color: theme.ink2 }]}>
          <Text style={[styles.loud, { color: theme.ink }]}>{from.name}</Text> asked <Text style={[styles.loud, { color: theme.ink }]}>{to.name}</Text> ·
        </Text>
        <FadingText numberOfLines={1} style={[styles.words, waitsOnPerson ? [styles.loud, { color: theme.ink }] : { color: theme.ink2 }]}>
          {state}
        </FadingText>
        <Animated.View style={turned}>
          <ChevronRight size={14} strokeWidth={2.25} color={theme.faint} />
        </Animated.View>
      </Pressable>
      {open ? (
        <Animated.View entering={SHOW} exiting={HIDE} style={styles.body}>
          <View style={[styles.said, { borderColor: theme.line }]}>
            <Markdown text={asked.body} on="page" />
          </View>
          {answer ? (
            <>
              <View style={styles.answered}>
                <AvatarView avatarId={to.avatar_id} state="resting" size={AVATAR} />
                <Text style={[styles.words, { color: theme.ink2 }]}>
                  <Text style={[styles.loud, { color: theme.ink }]}>{to.name}</Text> answered
                </Text>
              </View>
              <View style={[styles.said, { borderColor: theme.line }]}>
                <Markdown text={answer.body} on="page" />
              </View>
            </>
          ) : null}
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  exchange: { alignItems: "flex-start", marginTop: 10 },
  head: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 2, maxWidth: "100%" },
  link: { width: LINK, height: DOT, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  courier: { position: "absolute", left: 0, top: 0, width: DOT, height: DOT, borderRadius: DOT / 2 },
  words: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
  loud: { fontWeight: "600" },
  body: { alignSelf: "stretch", alignItems: "flex-start" },
  said: { maxWidth: "80%", marginTop: 4, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderRadius: 20, borderBottomLeftRadius: 6 },
  answered: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8, marginLeft: 2 },
});
