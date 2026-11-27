import { useEffect, useState } from "react";
import type { Connection } from "@server/contract.ts";
import { useAgents, useAvatars, useConnections } from "../lib/store.ts";
import { openChat } from "../lib/view.ts";
import { ConnectionRow } from "../settings/Connections.tsx";
import { Group } from "../settings/Group.tsx";
import { Pairing } from "../settings/Phones.tsx";
import { Avatar } from "../ui/Avatar.tsx";
import { Button } from "../ui/Button.tsx";
import { Screen } from "./Screens.tsx";

// The apps the first agent's brief reads, which its first message offers too.
const READS: Connection[] = ["calendar", "gmail"];

/**
 * What someone new sees once the computer has set them up, before their
 * agents: the apps their first agent reads, to connect now or later, and the
 * code that pairs a phone. Each step can be skipped, since Settings and the
 * agent's own chat offer both again. It ends by opening the first agent's
 * chat, and tells `onNobody` when there is no agent to meet.
 */
export function Welcome({ onNobody }: { onNobody: () => void }) {
  const [step, setStep] = useState<"apps" | "phone">("apps");
  const agent = useAgents().at(0);
  const loaded = useAvatars().length > 0;
  const connections = useConnections();
  useEffect(() => {
    if (loaded && !agent) onNobody();
  }, [loaded, agent, onNobody]);
  if (!agent) return null;

  const art = <Avatar avatarId={agent.avatar_id} state={step === "apps" ? "resting" : "replied"} size={64} className="mb-4" />;
  if (step === "apps") {
    const reads = connections?.filter((connected) => READS.includes(connected.connection)) ?? [];
    const connected = reads.some((read) => read.account);
    return (
      <Screen key={step} art={art} title={`Show ${agent.name} your day`} note={`Connect what ${agent.name} should read. You sign in on the app's own page, and what it gives Sidebots stays on your computer.`} className="animate-fade-in">
        <div className="flex w-[480px] max-w-full flex-col items-center gap-4 text-left" data-testid="welcome-apps">
          <div className="w-full">
            <Group>{reads.length ? reads.map((read) => <ConnectionRow key={read.connection} connected={read} />) : null}</Group>
          </div>
          <Button variant={connected ? "primary" : "secondary"} size="lg" onClick={() => setStep("phone")} data-testid="welcome-next">
            {connected ? "Continue" : "Not now"}
          </Button>
        </div>
      </Screen>
    );
  }
  return (
    <Screen key={step} art={art} title={`Take ${agent.name} with you`} note={`Sidebots is also on iPhone and iPad. What ${agent.name} sends arrives there as a notification, and you can answer from anywhere.`} className="animate-fade-in">
      <div className="w-[520px] max-w-full text-left" data-testid="welcome-phone">
        <Pairing onDone={() => openChat(agent.id)} leave="Not now" />
      </div>
    </Screen>
  );
}
