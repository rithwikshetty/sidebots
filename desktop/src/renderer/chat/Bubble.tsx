import type { CSSProperties, ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

/**
 * The bubble a message is said in. One at the `end` is in the chat's colour,
 * with its tail at the bottom right, as the person's messages are in a chat
 * with an agent. One at the `start` is on the neutral bubble, with its tail
 * at the bottom left, as an agent's are. `color` fills either side with a
 * colour of its own instead, as an agent's in an exchange between two agents,
 * and what is in a coloured bubble takes the colour that reads on it. A
 * bubble takes at most 85% of the column it sits in, and as narrow as what it
 * holds; code and tables inside it take its full width and scroll sideways.
 */
export function Bubble({ side, color, className, style, children, ...props }: ComponentProps<"div"> & { side: "start" | "end"; color?: string }) {
  const colored = side === "end" || color !== undefined;
  return (
    <div
      data-side={side}
      className={cn(
        "max-w-[85%] min-w-0 rounded-bubble px-3.5 py-2 text-message break-words",
        side === "end" ? "rounded-br-sm" : "rounded-bl-sm",
        colored ? "bg-chat text-on-tint" : "bg-bubble text-ink",
        className,
      )}
      style={color ? ({ ...style, "--chat": color } as CSSProperties) : style}
      {...props}
    >
      {children}
    </div>
  );
}
