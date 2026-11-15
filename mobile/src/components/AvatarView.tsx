import { useEffect, useState } from "react";
import { Image } from "expo-image";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import { AVATAR_SHEET, AVATAR_STATES, type AvatarState } from "@server/contract";
import { avatarSheetUrl } from "@/lib/api";
import { EASE } from "@/lib/motion";

const { columns, cellWidth, cellHeight, art } = AVATAR_SHEET;
const ROWS = Object.keys(AVATAR_STATES) as AvatarState[];
// The window onto a cell: the drawing plus the room above it for a hop.
const WINDOW_TOP = art.top - art.pixel;
const WINDOW_HEIGHT = art.size + art.pixel;

/**
 * An agent's avatar, playing the animation for `state`. `size` is the width of
 * the avatar's drawing in points; the view is one drawing pixel taller. A
 * `dimmed` avatar, as while the server is out of reach, fades to grey and back.
 */
export function AvatarView({ avatarId, state, size, dimmed = false }: { avatarId: string; state: AvatarState; size: number; dimmed?: boolean }) {
  const { frames, frameMs } = AVATAR_STATES[state];
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    setFrame(0);
    const timer = setInterval(() => setFrame((current) => (current + 1) % frames), frameMs);
    return () => clearInterval(timer);
  }, [frames, frameMs]);

  const fade = useAnimatedStyle(() => ({ opacity: withTiming(dimmed ? 0.4 : 1, EASE) }));

  const scale = size / art.size;
  const row = ROWS.indexOf(state);
  return (
    <Animated.View style={[{ width: size, height: WINDOW_HEIGHT * scale, overflow: "hidden" }, fade]}>
      <Image
        source={{ uri: avatarSheetUrl(avatarId) }}
        cachePolicy="disk"
        contentFit="fill"
        style={{
          position: "absolute",
          width: columns * cellWidth * scale,
          height: ROWS.length * cellHeight * scale,
          left: -((frame % frames) * cellWidth + art.left) * scale,
          top: -(row * cellHeight + WINDOW_TOP) * scale,
        }}
      />
    </Animated.View>
  );
}
