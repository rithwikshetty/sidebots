import type { ComponentProps } from "react";
import Animated from "react-native-reanimated";
import { HIDE, SHOW } from "@/lib/motion";

/**
 * Text that crossfades when its words change: the old words fade out where
 * they were as the new ones fade in, so nothing snaps from one to the other.
 * It fades in as it first shows, and out as it goes.
 */
export function FadingText({ children, ...props }: Omit<ComponentProps<typeof Animated.Text>, "children"> & { children: string }) {
  return (
    <Animated.Text key={children} entering={SHOW} exiting={HIDE} {...props}>
      {children}
    </Animated.Text>
  );
}
