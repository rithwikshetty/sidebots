import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useAvatars } from "../lib/store.ts";
import { Avatar } from "./Avatar.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The avatars on the server as tiles, with the chosen one outlined and
 * hopping, as an agent does when its reply comes. Arrow keys move between
 * them. Each tile's tooltip names its avatar.
 */
export function AvatarPicker({ value, onChange }: { value: string | undefined; onChange: (avatarId: string) => void }) {
  const avatars = useAvatars();
  return (
    <RadioGroup value={value ?? null} onValueChange={(next) => onChange(next as string)} aria-label="Avatar" className="grid grid-cols-4 gap-2">
      {avatars.map((avatar) => (
        <Tooltip key={avatar.id} label={avatar.displayName}>
          <Radio.Root
            value={avatar.id}
            aria-label={avatar.displayName}
            className="relative grid h-[72px] place-items-center rounded-lg bg-field transition-[background-color,scale] duration-150 ease-out after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border-2 after:border-tint-ink after:opacity-0 after:transition-opacity after:duration-150 hover:bg-press active:scale-[0.96] data-checked:after:opacity-100"
          >
            <Avatar avatarId={avatar.id} state={avatar.id === value ? "replied" : "resting"} size={48} />
          </Radio.Root>
        </Tooltip>
      ))}
    </RadioGroup>
  );
}
