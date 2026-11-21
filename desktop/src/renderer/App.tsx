// The window: where the app stands with the server on this computer, and once
// it is ready, the agents and their chats, with Settings and the new agent
// dialog over them. Once the window holds a copy of the agents, it keeps
// showing them while the server is out of reach or starting, as the phone
// does, and only nobody set up or another version of the contract takes their
// place.

import { useNotifications } from "./lib/notify.ts";
import { useAvatars, useConnection } from "./lib/store.ts";
import { Settings } from "./settings/Settings.tsx";
import { Frame } from "./shell/Frame.tsx";
import { NewAgent } from "./shell/NewAgent.tsx";
import { Failed, Setup, Starting } from "./shell/Screens.tsx";
import { useShortcuts } from "./shell/shortcuts.ts";
import { ConfirmDialog } from "./ui/Confirm.tsx";
import { ToastProvider } from "./ui/Toast.tsx";
import { TooltipProvider } from "./ui/Tooltip.tsx";

export function App() {
  const connection = useConnection();
  // The avatars come with the server's first answer and are saved with the rest, so the window holds a copy once it has them.
  const held = useAvatars().length > 0;
  const kept = held && (connection.phase === "starting" || (connection.phase === "failed" && !connection.behind));
  return (
    <ToastProvider>
      <TooltipProvider>
        <div data-phase={connection.phase} className="h-full">
          {connection.phase === "ready" || kept ? <Ready /> : connection.phase === "setup" ? <Setup /> : connection.phase === "failed" ? <Failed message={connection.message} /> : <Starting />}
        </div>
        <ConfirmDialog />
      </TooltipProvider>
    </ToastProvider>
  );
}

function Ready() {
  useShortcuts();
  useNotifications();
  return (
    <>
      <Frame />
      <NewAgent />
      <Settings />
    </>
  );
}
