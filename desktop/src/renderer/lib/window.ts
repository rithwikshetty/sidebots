// What the window knows about itself and the computer: the system it runs
// on, its width, whether it can be seen or fills the screen, the day it is,
// and the keys the system's shortcuts are made with.

import { useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";

export const mac = window.desktop.platform === "darwin";

/** Room the system's own buttons take over the window, in pixels: a Mac's traffic lights at the left, and Windows' buttons at the right. */
export const SYSTEM_BUTTONS = { mac: 80, windows: 140 };

function listen(target: EventTarget, event: string) {
  return (listener: () => void) => {
    target.addEventListener(event, listener);
    return () => target.removeEventListener(event, listener);
  };
}

export const onResize = listen(window, "resize");
export const onVisibility = listen(document, "visibilitychange");

export function useWindowWidth(): number {
  return useSyncExternalStore(onResize, () => window.innerWidth);
}

/** Whether the window can be seen, which it can't while it is hidden or minimised. */
export function useVisible(): boolean {
  return useSyncExternalStore(onVisibility, () => document.visibilityState === "visible");
}

/** Calls `listener` when the window becomes the one the person is using, and when it stops being it, as while another app or window is in front of it. Returns a function that stops it. */
export function onFocusChange(listener: () => void): () => void {
  window.addEventListener("focus", listener);
  window.addEventListener("blur", listener);
  return () => {
    window.removeEventListener("focus", listener);
    window.removeEventListener("blur", listener);
  };
}

/** Whether the window fills the screen, when a Mac shows no traffic lights over it. */
export function useFullScreen(): boolean {
  return useSyncExternalStore(window.desktop.onFullScreen, window.desktop.fullScreen);
}

// How often the window looks at what day it is. A timer set for midnight would run late after the computer slept.
const DAY_CHECK_MS = 60_000;

function onDayCheck(listener: () => void): () => void {
  const timer = setInterval(listener, DAY_CHECK_MS);
  return () => clearInterval(timer);
}

/** When today began on the computer's clock, kept up as the day changes, for a time told by it, as "Yesterday" is. */
export function useToday(): number {
  return useSyncExternalStore(onDayCheck, () => new Date().setHours(0, 0, 0, 0));
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const onMotion = listen(reducedMotion, "change");

/** Whether the person asked the system for less motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(onMotion, () => reducedMotion.matches);
}

/** The keys of a shortcut with the system's command key, as the system writes them: ⌘K on a Mac, Ctrl+K elsewhere. */
export function shortcut(key: string): string[] {
  return mac ? ["⌘", key] : ["Ctrl", key];
}

/** Whether a key was pressed with the system's command key: ⌘ on a Mac, Ctrl elsewhere. */
export function withCommand(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
