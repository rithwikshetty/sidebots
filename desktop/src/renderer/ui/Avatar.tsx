import { useState } from "react";
import { AVATAR_SHEET, AVATAR_STATES, avatarFrame, type AvatarState } from "@server/contract.ts";
import { cn } from "../lib/cn.ts";
import { useBeat } from "../lib/motion.ts";
import { useReducedMotion, useVisible } from "../lib/window.ts";

const { columns, cellWidth, cellHeight } = AVATAR_SHEET;
const ROWS = Object.keys(AVATAR_STATES).length;

/** Where the server serves an avatar's spritesheet, through the main process. */
export function avatarSheet(avatarId: string): string {
  return `/api/avatars/${encodeURIComponent(avatarId)}/spritesheet`;
}

type Props = { state: AvatarState; size: number; dimmed?: boolean; label?: string; className?: string };

/**
 * An agent's avatar, playing the animation for `state`. `size` is the width
 * of the avatar's drawing in pixels; the avatar is one drawing pixel taller,
 * for the room above it for a hop. A multiple of 16 keeps every pixel the
 * same size. A `dimmed` avatar, as while the server is out of reach, fades
 * back. It holds still while the window can't be seen, and for a person who
 * asked for less motion. `label` names it for a screen reader, which otherwise
 * passes over it, as beside the agent's name.
 */
export function Avatar({ avatarId, ...props }: Props & { avatarId: string }) {
  return <Sprite sheet={avatarSheet(avatarId)} {...props} />;
}

/** An avatar drawn from a spritesheet at `sheet`, as the app's own mascot is before the server answers. */
export function Sprite({ sheet, state, size, dimmed = false, label, className }: Props & { sheet: string }) {
  const { frames, frameMs, still } = AVATAR_STATES[state];
  const visible = useVisible();
  const reduced = useReducedMotion();
  const moving = visible && !reduced;
  const beat = useBeat(frameMs, moving);
  // A state plays from its first frame, from the beat the avatar took it up on or began to move again.
  const [began, setBegan] = useState({ state, moving, beat });
  if (began.state !== state || began.moving !== moving) setBegan({ state, moving, beat });

  // The element is a window onto the sheet, the size of one frame.
  const shown = avatarFrame(state, moving ? (beat - began.beat) % frames : still);
  const scale = size / shown.width;
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("pixelated block shrink-0 bg-no-repeat transition-opacity duration-200 ease-out", className)}
      style={{
        width: size,
        height: shown.height * scale,
        backgroundImage: `url("${sheet}")`,
        backgroundSize: `${columns * cellWidth * scale}px ${ROWS * cellHeight * scale}px`,
        backgroundPosition: `${-shown.x * scale}px ${-shown.y * scale}px`,
        opacity: dimmed ? 0.4 : 1,
      }}
    />
  );
}
