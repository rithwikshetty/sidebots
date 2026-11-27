import { useState, type ComponentProps, type ReactNode } from "react";
import type { AvatarState } from "@server/contract.ts";
import moss from "../../../../avatars/moss/spritesheet.png";
import { cn } from "../lib/cn.ts";
import { Button } from "../ui/Button.tsx";
import { Sprite } from "../ui/Avatar.tsx";
import { TopBar } from "./TopBar.tsx";

/** Moss, Sidebots' own avatar, which needs no server to be drawn. */
export function Mascot({ state, className }: { state: AvatarState; className?: string }) {
  return <Sprite sheet={moss} state={state} size={64} className={className} />;
}

/**
 * What the window shows before the agents: Moss acting out where the app
 * stands, with a few words under it and what the person can do about it.
 * `art` takes Moss's place, as an agent's own avatar does.
 */
export function Screen({ state = "resting", art, title, note, children, className }: { state?: AvatarState; art?: ReactNode; title: string; note?: string; children?: ReactNode; className?: string }) {
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <main className={cn("flex flex-1 flex-col items-center justify-center gap-1.5 px-8 pb-13 text-center", className)}>
        {art ?? <Mascot state={state} className="mb-4" />}
        <h1 className="text-lg font-semibold">{title}</h1>
        {note ? <p className="max-w-[340px] text-sm text-pretty text-ink2">{note}</p> : null}
        {children ? <div className="mt-4">{children}</div> : null}
      </main>
    </div>
  );
}

/** While the server starts, or the app pairs with it. It shows only after a moment, so a quick start never flashes it. */
export function Starting() {
  return <Screen state="working" title="Starting Sidebots…" className="[animation:fade-in_200ms_var(--ease-out)_400ms_both]" />;
}

/** When nobody has set Sidebots up on this computer yet. When the app can't send the person to setup, it says where to go instead, in the main process's words. */
export function Setup() {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const setUp = () => {
    setBusy(true);
    setFailure("");
    void window.desktop
      .openSetup()
      .catch((reason: Error) => setFailure(reason.message))
      .finally(() => setBusy(false));
  };
  return (
    <Screen state="resting" title="Set up Sidebots" note="Sign in to Claude Code or Codex on this computer, and your agents will be here.">
      {/* The words hang under the button, so the screen doesn't move when they come. */}
      <div className="relative">
        <Button variant="primary" size="lg" busy={busy} onClick={setUp}>
          Set up
        </Button>
        <p role="status" className="absolute top-full left-1/2 mt-3 w-[340px] -translate-x-1/2 text-sm text-pretty text-ink2" data-testid="setup-failure">
          {failure ? <span className="animate-fade-in">{failure}</span> : null}
        </p>
      </div>
    </Screen>
  );
}

/** When the app can't reach the server, in the main process's words for why. */
export function Failed({ message }: { message: string }) {
  return (
    <Screen state="failed" title={message}>
      <RetryButton variant="primary" size="lg" />
    </Screen>
  );
}

/** Asks the main process to look at the server again now, and to start it when it isn't running. It is busy until the look is over. */
export function RetryButton(props: Pick<ComponentProps<typeof Button>, "variant" | "size">) {
  const [busy, setBusy] = useState(false);
  const retry = () => {
    setBusy(true);
    void window.desktop.retry().finally(() => setBusy(false));
  };
  return (
    <Button {...props} busy={busy} onClick={retry}>
      Retry
    </Button>
  );
}
