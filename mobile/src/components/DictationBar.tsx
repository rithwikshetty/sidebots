import { memo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
  type EntryExitAnimationFunction,
  type SharedValue,
} from "react-native-reanimated";
import { Check, X } from "lucide-react-native";
import { IconButton } from "@/components/IconButton";
import { LEVEL_COUNT, type DictationState } from "@/lib/dictation";
import { useTheme } from "@/lib/theme";

const BUTTON = 36;
const FADE = { duration: 220, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System } as const;
const FLIP = { duration: 260, easing: Easing.inOut(Easing.cubic), reduceMotion: ReduceMotion.System } as const;
const PERSPECTIVE = 600;
const HALF_ROW = BUTTON / 2;
const BAR_HEIGHT = 22;
const BAR_MIN_HEIGHT = 2;
const BAR_SPACING = 5;
const BAR_TIMING = { duration: 100, easing: Easing.out(Easing.quad), reduceMotion: ReduceMotion.System } as const;

/**
 * A row turning about its middle, as a drum turns to its next face: from
 * `fromDegrees` to `toDegrees` around the horizontal axis, fading out as it
 * turns edge on. The row keeps its middle on the axis, so it sinks as it turns.
 */
function flip(fromDegrees: number, toDegrees: number): EntryExitAnimationFunction {
  return () => {
    "worklet";
    const fromRadians = (fromDegrees * Math.PI) / 180;
    const toRadians = (toDegrees * Math.PI) / 180;
    const fromSine = Math.sin(fromRadians);
    const toSine = Math.sin(toRadians);
    return {
      initialValues: {
        opacity: fromDegrees === 0 ? 1 : 0,
        transform: [{ perspective: PERSPECTIVE }, { translateY: -HALF_ROW * fromSine }, { rotateX: `${fromDegrees}deg` }],
      },
      animations: {
        opacity: withTiming(toDegrees === 0 ? 1 : 0, FLIP),
        transform: [
          { perspective: PERSPECTIVE },
          {
            translateY: withTiming(-HALF_ROW * toSine, {
              ...FLIP,
              easing: (time) => {
                const angle = fromRadians + (toRadians - fromRadians) * FLIP.easing(time);
                return (Math.sin(angle) - fromSine) / (toSine - fromSine);
              },
            }),
          },
          { rotateX: withTiming(`${toDegrees}deg`, FLIP) },
        ],
      },
    };
  };
}

/** The composer's buttons turn up and away as dictation starts, and back down once it ends. */
export const BUTTONS_ENTERING = flip(90, 0);
export const BUTTONS_EXITING = flip(0, 90);
/** The dictation row turns in from below, and back down as it goes. */
export const DICTATION_ENTERING = flip(-90, 0);
export const DICTATION_EXITING = flip(0, -90);

/** Turns the resting line of text away with the buttons while `hidden`, so the dictation row has the field. */
export function useFlipAway(hidden: boolean) {
  const turned = useDerivedValue(() => withTiming(hidden ? 1 : 0, FLIP));
  return useAnimatedStyle(() => ({
    opacity: 1 - turned.value,
    transform: [
      { perspective: PERSPECTIVE },
      { translateY: -HALF_ROW * Math.sin((turned.value * Math.PI) / 2) },
      { rotateX: `${turned.value * 90}deg` },
    ],
  }));
}

/**
 * What the composer's bottom row shows while the person dictates: X to drop
 * it, a waveform of their voice with the time it has run, and ✓ to turn it
 * into text. While the text is made, the waveform gives way to the word
 * Transcribing and the ✓ to a spinner.
 */
export function DictationBar({
  state,
  levels,
  seconds,
  onCancel,
  onConfirm,
  style,
}: {
  state: DictationState;
  levels: SharedValue<number[]>;
  seconds: number;
  onCancel: () => void;
  onConfirm: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const listening = state === "listening";
  const waveformStyle = useAnimatedStyle(() => ({ opacity: withTiming(listening ? 1 : 0, FADE) }));
  const labelStyle = useAnimatedStyle(() => ({ opacity: withTiming(listening ? 0 : 1, FADE) }));
  const tintStyle = useAnimatedStyle(() => ({ opacity: withTiming(listening ? 1 : 0, FADE) }));
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <View style={[styles.row, style]}>
      <IconButton icon={X} label="Cancel dictation" iconSize={19} color={theme.ink2} onPress={onCancel} />
      <View
        accessible
        accessibilityLabel={listening ? `Recording ${time}` : "Transcribing"}
        accessibilityLiveRegion={listening ? "none" : "polite"}
        style={styles.status}>
        <Animated.View style={[styles.layer, styles.waveformLayer, waveformStyle]}>
          <Waveform levels={levels} color={theme.ink} />
          <Text style={[styles.time, { color: theme.ink2 }]}>{time}</Text>
        </Animated.View>
        <Animated.View style={[styles.layer, labelStyle]}>
          <Text style={[styles.label, { color: theme.ink2 }]} numberOfLines={1}>
            Transcribing
          </Text>
        </Animated.View>
      </View>
      <Pressable
        onPress={onConfirm}
        disabled={!listening}
        accessibilityRole="button"
        accessibilityLabel="Finish dictating"
        accessibilityState={{ disabled: !listening, busy: !listening }}
        hitSlop={8}
        style={({ pressed }) => [styles.round, { backgroundColor: theme.field, opacity: pressed ? 0.75 : 1 }]}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.roundFill, { backgroundColor: theme.tint }, tintStyle]} />
        {listening ? <Check size={18} strokeWidth={2.5} color={theme.onTint} /> : <ActivityIndicator color={theme.ink2} />}
      </Pressable>
    </View>
  );
}

/** As many bars as fit, each the loudness of one of the latest moments, the newest at the right. */
const Waveform = memo(function Waveform({ levels, color }: { levels: SharedValue<number[]>; color: string }) {
  const [count, setCount] = useState(0);
  return (
    <View
      style={styles.waveform}
      onLayout={(event) => setCount(Math.max(1, Math.min(LEVEL_COUNT, Math.floor(event.nativeEvent.layout.width / BAR_SPACING))))}>
      {Array.from({ length: count }, (_, index) => (
        <Bar key={index} levels={levels} sample={LEVEL_COUNT - count + index} color={color} />
      ))}
    </View>
  );
});

const Bar = memo(function Bar({ levels, sample, color }: { levels: SharedValue<number[]>; sample: number; color: string }) {
  const style = useAnimatedStyle(() => {
    const level = levels.value[sample] ?? 0;
    return {
      opacity: withTiming(0.22 + level * 0.78, BAR_TIMING),
      transform: [{ scaleY: withTiming((BAR_MIN_HEIGHT + level * (BAR_HEIGHT - BAR_MIN_HEIGHT)) / BAR_HEIGHT, BAR_TIMING) }],
    };
  });
  return <Animated.View style={[styles.bar, { backgroundColor: color }, style]} />;
});

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4, height: BUTTON },
  status: { flex: 1, height: BUTTON, justifyContent: "center" },
  layer: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, justifyContent: "center" },
  waveformLayer: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 },
  waveform: { flex: 1, minWidth: 0, height: BAR_HEIGHT, flexDirection: "row", alignItems: "center", justifyContent: "space-between", overflow: "hidden" },
  bar: { width: 2, height: BAR_HEIGHT, borderRadius: 1 },
  // The system font's figures are all one width, so the time doesn't jitter as it counts.
  time: { fontSize: 12, fontVariant: ["tabular-nums"] },
  label: { fontSize: 14, textAlign: "center" },
  round: { width: BUTTON, height: BUTTON, borderRadius: BUTTON / 2, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  roundFill: { borderRadius: BUTTON / 2 },
});
