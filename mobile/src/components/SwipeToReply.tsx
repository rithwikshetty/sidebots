import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { interpolate, useAnimatedReaction, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Reply } from "lucide-react-native";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";

// A swipe left past this replies, and the arrow is fully in.
const REPLY_AT = 56;
// The reply arrow's width, centred in the space the message leaves when it reaches REPLY_AT.
const REPLY_ARROW = 26;

/**
 * A message that swipes left to reply, as in Telegram: it follows the finger
 * with a reply arrow coming in behind it at the right, gives a tap at the
 * point where letting go replies, and springs back. A swipe right is left to
 * the system, which goes back from anywhere in the chat, and a swipe up or
 * down scrolls it.
 */
export function SwipeToReply({ onReply, children }: { onReply: () => void; children: ReactNode }) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const offset = useSharedValue(0);
  const pan = usePanGesture({
    activeOffsetX: -12,
    failOffsetX: 12,
    failOffsetY: [-10, 10],
    onUpdate: (event) => {
      "worklet";
      // It follows the finger at a damped pace, and slows further past the point.
      const pulled = Math.max(0, -event.translationX) * 0.6;
      offset.value = pulled > REPLY_AT ? REPLY_AT + (pulled - REPLY_AT) * 0.3 : pulled;
    },
    onDeactivate: (event) => {
      "worklet";
      if (!event.canceled && offset.value >= REPLY_AT) scheduleOnRN(onReply);
      offset.value = reduceMotion ? withTiming(0, { duration: 160 }) : withSpring(0, { damping: 22, stiffness: 260 });
    },
  });
  useAnimatedReaction(
    () => offset.value >= REPLY_AT,
    (past, before) => {
      if (past && before === false) scheduleOnRN(haptics.threshold);
    },
  );
  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: -offset.value }] }));
  const arrow = useAnimatedStyle(() => ({
    opacity: interpolate(offset.value, [12, REPLY_AT], [0, 1], "clamp"),
    transform: [{ scale: interpolate(offset.value, [12, REPLY_AT], [0.6, 1], "clamp") }],
  }));
  return (
    <GestureDetector gesture={pan}>
      <View>
        <Animated.View pointerEvents="none" style={[styles.arrow, { backgroundColor: theme.field }, arrow]}>
          <Reply size={15} strokeWidth={2.2} color={theme.ink2} />
        </Animated.View>
        <Animated.View style={moved}>{children}</Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  arrow: {
    position: "absolute",
    right: (REPLY_AT - REPLY_ARROW) / 2,
    top: "50%",
    marginTop: -REPLY_ARROW / 2,
    width: REPLY_ARROW,
    height: REPLY_ARROW,
    borderRadius: REPLY_ARROW / 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
