import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { PROVIDERS, type Provider } from "@server/contract.ts";
import { cn } from "../lib/cn.ts";
import { createAgent, loadUsage, useAvatars, useUsage } from "../lib/store.ts";
import { closeNewAgent, openChat, useNewAgent } from "../lib/view.ts";
import { AvatarPicker } from "../ui/AvatarPicker.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog, DialogClose, DialogFooter, DialogHeader } from "../ui/Dialog.tsx";
import { Segmented } from "../ui/Segmented.tsx";

/** A stable number from a name, so a name always suggests the same avatar. */
function hash(text: string): number {
  let sum = 0;
  for (const letter of text) sum = (sum * 31 + letter.charCodeAt(0)) >>> 0;
  return sum;
}

/** The dialog for a new agent, which starts afresh each time it opens. */
export function NewAgent() {
  const open = useNewAgent();
  const name = useRef<HTMLInputElement>(null);
  // Each opening is a new form.
  const [opened, setOpened] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpened(opened + 1);
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeNewAgent()} initialFocus={name} className="w-[460px]" testId="new-agent">
      <NewAgentForm key={opened} name={name} />
    </Dialog>
  );
}

/**
 * A new agent: its name, its avatar, and Create agent, which opens its chat.
 * A person who has set up more than one provider on their computer also picks
 * the one it runs on, which starts as the first they set up.
 */
function NewAgentForm({ name }: { name: RefObject<HTMLInputElement | null> }) {
  const avatars = useAvatars();
  const [typed, setTyped] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  // The providers the person has set up, which the computer lists with how each is signed in to.
  const providers = (useUsage()?.accounts ?? []).map((account) => account.provider);
  const [chosen, setChosen] = useState<Provider | null>(null);
  const provider = chosen ?? providers[0];
  useEffect(() => {
    loadUsage().catch(() => {});
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = typed.trim();
  // Until the person picks, the name suggests an avatar.
  const avatarId = picked ?? avatars[hash(trimmed) % Math.max(avatars.length, 1)]?.id;
  const ready = Boolean(trimmed && avatarId && provider);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await createAgent(trimmed, avatarId!, provider);
      closeNewAgent();
      openChat(agent.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={create} className="flex min-h-0 flex-col">
      <DialogHeader title="New agent" />
      <div className="flex flex-col gap-4 overflow-y-auto px-5 pt-1 pb-3">
        <input
          ref={name}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="Name"
          aria-label="Name"
          maxLength={24}
          spellCheck={false}
          data-testid="agent-name"
          className="h-11 rounded-lg bg-field px-3 text-center text-xl font-semibold text-ink outline-none transition-shadow duration-150 placeholder:font-medium placeholder:text-ink3 focus:shadow-[0_0_0_1px_var(--tint-ink),0_0_0_3.5px_color-mix(in_srgb,var(--tint-ink)_22%,transparent)]"
        />
        <AvatarPicker value={avatarId} onChange={setPicked} />
        {providers.length > 1 ? (
          <Segmented label="Provider" options={Object.fromEntries(providers.map((id) => [id, PROVIDERS[id].name]))} value={provider} onChange={setChosen} />
        ) : null}
        <p role={error ? "alert" : undefined} className={cn("text-center text-sm", error ? "text-danger" : "text-ink2")}>
          {error ?? "Tell it what it's for in the chat."}
        </p>
      </div>
      <DialogFooter>
        <DialogClose render={<Button>Cancel</Button>} />
        <Button type="submit" variant="primary" busy={busy} disabled={!ready} data-testid="create-agent">
          Create agent
        </Button>
      </DialogFooter>
    </form>
  );
}
