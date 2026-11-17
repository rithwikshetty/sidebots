import * as Haptics from "expo-haptics";

// Haptics are a courtesy: a phone without them, or a failure, changes nothing.
const quietly = (feedback: Promise<void>) => void feedback.catch(() => {});

export const haptics = {
  /** A message left the composer. */
  send: () => quietly(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** The microphone started or stopped listening. */
  listen: () => quietly(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** The camera's shutter was pressed. */
  shutter: () => quietly(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** A swipe reached the point where letting go acts. */
  threshold: () => quietly(Haptics.selectionAsync()),
  /** The phone paired with a computer. */
  paired: () => quietly(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  /** The side menu opened. */
  menu: () => quietly(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** A choice was made, such as the flash, or a photo opened full screen. */
  select: () => quietly(Haptics.selectionAsync()),
};
