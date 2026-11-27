import { useEffect, useRef } from "react";
import type { MenuAction } from "../../bridge.ts";
import { useAgents } from "../lib/store.ts";
import { closeNewAgent, closeSettings, openChat, openNewAgent, openSearch, openSettings, toggleSidebar, write } from "../lib/view.ts";
import { withCommand } from "../lib/window.ts";

/** What each item of the app menu does in the window. The menu holds their shortcuts: ⌘N, ⌘, ⌘B, ⌘K and ⌘/ on a Mac, with Ctrl elsewhere. */
const MENU: Record<MenuAction, () => void> = {
  "new-agent": () => {
    closeSettings();
    openNewAgent();
  },
  settings: () => {
    closeNewAgent();
    openSettings();
  },
  "toggle-sidebar": toggleSidebar,
  search: openSearch,
  write,
};

/**
 * Carries out what the app menu asks, and the shortcuts the menu doesn't
 * hold: ⌘1 to ⌘9, with Ctrl elsewhere, open the first nine agents of the
 * sidebar.
 */
export function useShortcuts(): void {
  const agents = useAgents();
  const listed = useRef(agents);
  listed.current = agents;

  useEffect(() => window.desktop.onMenu((action) => MENU[action]()), []);

  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (!digit || !withCommand(event) || event.altKey || event.shiftKey) return;
      const agent = listed.current.filter((each) => !each.hidden)[Number(digit) - 1];
      if (!agent) return;
      event.preventDefault();
      openChat(agent.id);
    };
    window.addEventListener("keydown", press);
    return () => window.removeEventListener("keydown", press);
  }, []);
}
