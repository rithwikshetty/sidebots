import { useEffect, useRef, useState } from "react";
import type { Connected } from "@server/contract.ts";
import { ApiError } from "@client/api.ts";
import { ConnectionLogo } from "../chat/AskCard.tsx";
import { confirmRemoveConnection, problem } from "../lib/alerts.ts";
import { UPDATE, connect, loadConnections, useConnections } from "../lib/store.ts";
import { Button } from "../ui/Button.tsx";
import { Spinner } from "../ui/Spinner.tsx";
import { Failure, Group, Loading, SectionTitle } from "./Group.tsx";

/**
 * The apps the person's agents can use as them: each with its logo and what
 * connecting it lets the agents do, or the account it is connected as, and a
 * button that connects it through the app's own sign-in in the browser or
 * removes it. It shows what the app last had while it asks the computer again.
 */
export function Connections() {
  const connections = useConnections();
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    loadConnections().catch((reason) => {
      // A Sidebots on the computer that has no connections answers that it has no such thing.
      if (reason instanceof ApiError && reason.status === 404) return setFailure(`${UPDATE.computer} to connect your apps.`);
      setFailure(reason instanceof Error ? reason.message : "Something went wrong.");
    });
  }, []);
  return (
    <>
      <SectionTitle>Connections</SectionTitle>
      {connections ? (
        <>
          <p className="mb-4 px-0.5 text-sm text-pretty text-ink2">An app you connect is there for all your agents. You sign in on the app's own page, and what it gives Sidebots stays on your computer.</p>
          <Group testId="connections">
            {connections.map((connected) => (
              <ConnectionRow key={connected.connection} connected={connected} />
            ))}
          </Group>
        </>
      ) : failure ? (
        <Failure>{failure}</Failure>
      ) : (
        <Loading label="Loading connections" />
      )}
    </>
  );
}

/**
 * One app: its logo, its name, what connecting it allows or the account it is
 * connected as, and Connect or Remove. While its sign-in is open in the
 * browser, the row says so, and Cancel stops waiting for it. A sign-in the
 * person still finishes after that connects the app all the same.
 */
function ConnectionRow({ connected }: { connected: Connected }) {
  const [waiting, setWaiting] = useState(false);
  // Each Connect is a new wait, so one that was cancelled says nothing when it ends.
  const wait = useRef(0);
  const start = () => {
    const mine = ++wait.current;
    setWaiting(true);
    connect(connected.connection)
      .catch((reason) => wait.current === mine && problem("Couldn't connect", reason))
      .finally(() => wait.current === mine && setWaiting(false));
  };
  const cancel = () => {
    wait.current++;
    setWaiting(false);
  };
  return (
    <div className="flex items-center gap-3 px-3.5 py-3" data-testid={`connection-${connected.connection}`}>
      <ConnectionLogo logo={connected.logo} size={24} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{connected.name}</span>
        {waiting ? (
          <span role="status" className="flex items-center gap-1.5 text-xs text-ink2">
            <Spinner size={12} />
            Finish signing in in your browser…
          </span>
        ) : (
          <span className="text-xs text-pretty text-ink2">{connected.account ? `Connected as ${connected.account}` : connected.allows}</span>
        )}
      </div>
      {waiting ? (
        <Button size="sm" onClick={cancel} aria-label={`Cancel signing in to ${connected.name}`}>
          Cancel
        </Button>
      ) : connected.account ? (
        <Button size="sm" variant="ghost" className="text-danger" onClick={() => void confirmRemoveConnection(connected)} aria-label={`Remove ${connected.name}`}>
          Remove
        </Button>
      ) : (
        <Button size="sm" onClick={start} aria-label={`Connect ${connected.name}`}>
          Connect
        </Button>
      )}
    </div>
  );
}
