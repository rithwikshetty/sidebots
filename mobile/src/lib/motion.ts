import { Easing, FadeIn, FadeOut, LinearTransition, ReduceMotion, ZoomIn, ZoomOut, withTiming, type EntryExitAnimationFunction } from "react-native-reanimated";

/**
 * How the app moves, so a change looks the same wherever it happens:
 * something new fades in, something going fades out a little quicker, and
 * what stays slides to make room. Every animation here follows the phone's
 * Reduce Motion setting and jumps straight to its end when it is on.
 */
export const SHOW_MS = 220;
export const HIDE_MS = 160;

/** Something coming into view. */
export const SHOW = FadeIn.duration(SHOW_MS);
/** Something leaving. */
export const HIDE = FadeOut.duration(HIDE_MS);
/** What stays, sliding to where it now sits. */
export const MOVE = LinearTransition.duration(SHOW_MS);
/** A small mark, such as an unread count, growing in and shrinking away. */
export const POP_IN = ZoomIn.duration(SHOW_MS);
export const POP_OUT = ZoomOut.duration(HIDE_MS);

/** The timing for a value that eases to where it should be, such as a selection sliding to its choice. */
export const EASE = { duration: SHOW_MS, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System } as const;

const ARRIVE = { duration: 320, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System } as const;

/**
 * A message coming into the chat: it fades in from `opacity` as it rises
 * `rise` points into place, growing a little as it comes when it rises.
 */
export function arrive(opacity: number, rise: number): EntryExitAnimationFunction {
  const scale = rise ? 0.97 : 1;
  return () => {
    "worklet";
    return {
      initialValues: { opacity, transform: [{ translateY: rise }, { scale }] },
      animations: {
        opacity: withTiming(1, ARRIVE),
        transform: [{ translateY: withTiming(0, ARRIVE) }, { scale: withTiming(1, ARRIVE) }],
      },
    };
  };
}
