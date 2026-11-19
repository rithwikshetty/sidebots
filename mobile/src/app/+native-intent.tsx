import { openChat } from "@/lib/push";

/**
 * A link to a chat that comes while the app runs, as a tap on a working
 * agent's Live Activity sends, opens it as the app's own taps do, in place
 * of a chat already open. A link the app opens with, and any other link,
 * goes where it says.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  const agentId = /chat\/([^/?#]+)/.exec(path)?.[1];
  if (initial || !agentId) return path;
  openChat(agentId);
  return null;
}
