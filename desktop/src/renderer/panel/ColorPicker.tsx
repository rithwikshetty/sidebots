import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { CHAT_COLORS } from "@client/colors.ts";
import { Tooltip } from "../ui/Tooltip.tsx";

// What the avatar's own colour is called among the choices, which `value` null means.
const AVATARS = "avatar";

/**
 * The colours an agent's chat can have, as round swatches, with the chosen one
 * ringed. The first is the avatar's own colour, which `value` null means and
 * which follows the avatar when it changes. Arrow keys move between them, and
 * each swatch's tooltip names its colour.
 */
export function ColorPicker({ value, avatarColor, onChange }: { value: string | null; avatarColor: string | null; onChange: (color: string | null) => void }) {
  const others = CHAT_COLORS.filter(({ color }) => color !== avatarColor);
  const chosen = value === null || value === avatarColor ? AVATARS : value;
  return (
    <RadioGroup value={chosen} onValueChange={(next) => onChange(next === AVATARS ? null : (next as string))} aria-label="Chat colour" className="flex flex-wrap gap-1.5">
      {avatarColor ? <Swatch value={AVATARS} color={avatarColor} label="The avatar's colour" /> : null}
      {others.map(({ color, name }) => (
        <Swatch key={color} value={color} color={color} label={name} />
      ))}
    </RadioGroup>
  );
}

function Swatch({ value, color, label }: { value: string; color: string; label: string }) {
  return (
    <Tooltip label={label}>
      <Radio.Root
        value={value}
        aria-label={label}
        className="group relative grid size-8 place-items-center rounded-full transition-[scale] duration-150 ease-out after:pointer-events-none after:absolute after:inset-0 after:rounded-full after:border-2 after:border-ink after:opacity-0 after:transition-opacity after:duration-150 active:scale-[0.92] data-checked:after:opacity-100"
      >
        <span aria-hidden className="size-6 rounded-full shadow-control transition-[scale] duration-150 ease-out group-hover:scale-110 group-data-checked:scale-100" style={{ backgroundColor: color }} />
      </Radio.Root>
    </Tooltip>
  );
}
