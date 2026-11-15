import { useEffect, useState } from "react";
import { Image } from "expo-image";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import { PET_SHEET, PET_STATES, type PetState } from "@server/contract";
import { petSheetUrl } from "@/lib/api";
import { EASE } from "@/lib/motion";

const { columns, cellWidth, cellHeight, art } = PET_SHEET;
const ROWS = Object.keys(PET_STATES) as PetState[];
// The window onto a cell: the drawing plus the room above it for a hop.
const WINDOW_TOP = art.top - art.pixel;
const WINDOW_HEIGHT = art.size + art.pixel;

/**
 * An agent's pet, playing the animation for `state`. `size` is the width of
 * the pet's drawing in points; the view is one drawing pixel taller. A
 * `dimmed` pet, as while the server is out of reach, fades to grey and back.
 */
export function PetView({ petId, state, size, dimmed = false }: { petId: string; state: PetState; size: number; dimmed?: boolean }) {
  const { frames, frameMs } = PET_STATES[state];
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
        source={{ uri: petSheetUrl(petId) }}
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
