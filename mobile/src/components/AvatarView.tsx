import { useState } from "react";
import { Image } from "expo-image";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import { AVATAR_SHEET, AVATAR_STATES, avatarFrame, type AvatarState } from "@server/contract";
import { avatarSheet } from "@/lib/api";
import { EASE, useBeat } from "@/lib/motion";

const { columns, cellWidth, cellHeight } = AVATAR_SHEET;
const ROWS = Object.keys(AVATAR_STATES).length;

/**
 * An agent's avatar, playing the animation for `state`. `size` is the width of
 * the avatar's drawing in points; the view is one drawing pixel taller. A
 * `dimmed` avatar, as while the server is out of reach, fades to grey and back.
 */
export function AvatarView({ avatarId, state, size, dimmed = false }: { avatarId: string; state: AvatarState; size: number; dimmed?: boolean }) {
  const { frames, frameMs } = AVATAR_STATES[state];
  const beat = useBeat(frameMs);
  // A state plays from its first frame, from the beat the avatar took it up on.
  const [began, setBegan] = useState({ state, beat });
  if (began.state !== state) setBegan({ state, beat });

  const fade = useAnimatedStyle(() => ({ opacity: withTiming(dimmed ? 0.4 : 1, EASE) }));

  // The view is a window onto the sheet, the size of one frame.
  const shown = avatarFrame(state, (beat - began.beat) % frames);
  const scale = size / shown.width;
  return (
    <Animated.View style={[{ width: size, height: shown.height * scale, overflow: "hidden" }, fade]}>
      <Image
        source={avatarSheet(avatarId)}
        cachePolicy="disk"
        contentFit="fill"
        style={{
          position: "absolute",
          width: columns * cellWidth * scale,
          height: ROWS * cellHeight * scale,
          left: -shown.x * scale,
          top: -shown.y * scale,
        }}
      />
    </Animated.View>
  );
}
