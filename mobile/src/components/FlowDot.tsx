import { useEffect } from "react";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import { EASE } from "@/lib/motion";

// How bright a dot gets, how long one round takes, and how far apart the dots light.
const DIM = 0.25;
const LIT = 0.9;
const ROUND_MS = 1400;
const STEP_MS = 180;

/**
 * One of a row of dots that say something is under way. While `running` it
 * brightens and dims in turn with the others, by its `index` in the row, and
 * otherwise it rests at its colour.
 */
export function FlowDot({ index, running = true, size, color }: { index: number; running?: boolean; size: number; color: string }) {
  const lit = useSharedValue(running ? DIM : 1);
  useEffect(() => {
    const rest = ROUND_MS - 2 * EASE.duration;
    // A round repeats from the brightness it began at, so the dot dims before its first one.
    lit.value = running
      ? withSequence(withTiming(DIM, EASE), withDelay(index * STEP_MS, withRepeat(withSequence(withTiming(LIT, EASE), withTiming(DIM, EASE), withTiming(DIM, { ...EASE, duration: rest })), -1)))
      : withTiming(1, EASE);
  }, [index, running, lit]);
  const style = useAnimatedStyle(() => ({ opacity: lit.value }));
  return <Animated.View style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]} />;
}
