// What the window shows: the chat that is open, what the panel beside it
// shows, Settings, the new agent dialog, search, and the sidebar. It lives
// outside React, so a shortcut, a menu item or a row anywhere can change it.
// The sizes the person gives the sidebar and the panel, and whether the
// sidebar is collapsed, are kept on this computer. It also says whether the
// person is looking at a chat.

import { useSyncExternalStore } from "react";
import { confirming, onConfirm } from "../ui/Confirm.tsx";
import { onFocusChange, onResize, onVisibility } from "./window.ts";

/** The tabs of an agent's page: its settings, and what it works on and from. */
export type AgentTab = "settings" | "work";

/**
 * What the panel at the right shows, always about one agent: a page it sent,
 * its pictures from one message starting at `index`, what it and another
 * agent said to each other, its page, or its instructions or one of its
 * memories. Its page opens on the tab it was last on, or on its work when
 * the view says so.
 */
export type PanelView =
  | { kind: "page"; agentId: string; path: string; title: string }
  | { kind: "images"; agentId: string; paths: string[]; index: number }
  | { kind: "exchange"; agentId: string; messageId: string }
  | { kind: "agent"; agentId: string; tab?: AgentTab }
  | { kind: "note"; agentId: string; note: { kind: "instructions" } | { kind: "memory"; name: string } };

export type SettingsSection = "usage" | "connections" | "phones" | "about";

/** The open chat, and the message to scroll to and flash when it was opened at one. */
export type OpenChat = { agentId: string; messageId?: string };

/** The sidebar's width in pixels: what it starts at, and the least and most it can be dragged to. */
export const SIDEBAR = { initial: 280, least: 220, most: 420 };
/** The panel's width in pixels, and the most it takes of the window, as a fraction. */
export const PANEL = { initial: 480, least: 360, share: 0.6 };
/** The least the chat is ever given, in pixels. */
export const CHAT_LEAST = 380;
// Below this window width, the panel lies over the chat as a sheet.
const SHEET_BELOW = 980;

type View = {
  chat: OpenChat | null;
  panel: PanelView | null;
  settings: { section: SettingsSection } | null;
  newAgent: boolean;
  searching: boolean;
  sidebar: { collapsed: boolean; width: number };
  panelWidth: number;
};

const KEPT_KEY = "view-1";
type Kept = { sidebarCollapsed: boolean; sidebarWidth: number; panelWidth: number };

function kept(): Partial<Kept> {
  try {
    return JSON.parse(localStorage.getItem(KEPT_KEY) ?? "{}");
  } catch {
    return {};
  }
}

const saved = kept();
let view: View = {
  chat: null,
  panel: null,
  settings: null,
  newAgent: false,
  searching: false,
  sidebar: { collapsed: saved.sidebarCollapsed ?? false, width: saved.sidebarWidth ?? SIDEBAR.initial },
  panelWidth: saved.panelWidth ?? PANEL.initial,
};
const listeners = new Set<() => void>();

function set(patch: Partial<View>): void {
  view = { ...view, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useView<T>(pick: (view: View) => T): T {
  return useSyncExternalStore(subscribe, () => pick(view));
}

/** Keeps the sizes and the sidebar's state for the next time the window opens. */
function keep(): void {
  const sizes: Kept = { sidebarCollapsed: view.sidebar.collapsed, sidebarWidth: view.sidebar.width, panelWidth: view.panelWidth };
  localStorage.setItem(KEPT_KEY, JSON.stringify(sizes));
}

/**
 * Opens an agent's chat. With `messageId`, the chat scrolls to that message
 * and flashes it; each call is a new value, so opening the same message again
 * flashes it again. A panel about another agent closes.
 */
export function openChat(agentId: string, messageId?: string): void {
  const panel = view.panel?.agentId === agentId ? view.panel : null;
  set({ chat: { agentId, messageId }, panel });
}

/** Closes the open chat, and the panel with it, as when its agent is deleted. */
export function closeChat(): void {
  set({ chat: null, panel: null });
}

export function useOpenChat(): OpenChat | null {
  return useView((view) => view.chat);
}

export function openPanel(panel: PanelView): void {
  set({ panel });
}

export function closePanel(): void {
  set({ panel: null });
}

export function usePanel(): PanelView | null {
  return useView((view) => view.panel);
}

/** Opens Settings, at `section` or at the first. */
export function openSettings(section: SettingsSection = "usage"): void {
  set({ settings: { section } });
}

export function closeSettings(): void {
  set({ settings: null });
}

export function useSettings(): { section: SettingsSection } | null {
  return useView((view) => view.settings);
}

export function openNewAgent(): void {
  set({ newAgent: true });
}

export function closeNewAgent(): void {
  set({ newAgent: false });
}

export function useNewAgent(): boolean {
  return useView((view) => view.newAgent);
}

/** Opens search at the top of the sidebar, bringing the sidebar back when it is collapsed. */
export function openSearch(): void {
  set({ searching: true, sidebar: { ...view.sidebar, collapsed: false } });
  keep();
}

export function closeSearch(): void {
  set({ searching: false });
}

export function useSearching(): boolean {
  return useView((view) => view.searching);
}

/** Collapses the sidebar, or brings it back. Search closes with it. */
export function toggleSidebar(): void {
  const collapsed = !view.sidebar.collapsed;
  set({ sidebar: { ...view.sidebar, collapsed }, searching: collapsed ? false : view.searching });
  keep();
}

/** Sets the sidebar's width as the person drags it. `done` keeps it, once they let go. */
export function setSidebarWidth(width: number, done = false): void {
  set({ sidebar: { ...view.sidebar, width } });
  if (done) keep();
}

export function useSidebar(): { collapsed: boolean; width: number } {
  return useView((view) => view.sidebar);
}

/**
 * How a window `width` pixels wide is shared out beside the chat: the
 * sidebar's width, which always leaves the chat its least, the room left for
 * the panel, and whether the panel lies over the chat as a sheet for want of
 * that room.
 */
export function columns(width: number, sidebar: { collapsed: boolean; width: number }): { sidebarWidth: number; room: number; sheet: boolean } {
  const sidebarWidth = Math.max(SIDEBAR.least, Math.min(sidebar.width, SIDEBAR.most, width - CHAT_LEAST));
  const room = width - (sidebar.collapsed ? 0 : sidebarWidth) - CHAT_LEAST;
  return { sidebarWidth, room, sheet: width < SHEET_BELOW || room < PANEL.least };
}

/** Sets the panel's width as the person drags it. `done` keeps it, once they let go. */
export function setPanelWidth(width: number, done = false): void {
  set({ panelWidth: width });
  if (done) keep();
}

export function usePanelWidth(): number {
  return useView((view) => view.panelWidth);
}

/**
 * Whether the person is looking at an agent's chat: they are at the computer,
 * the window can be seen and has focus, the chat is open, and nothing lies
 * over it, as Settings, the new agent dialog, a confirm dialog and the panel
 * as a sheet do. A chat left open in front of nobody, as when the person has
 * walked away or locked the screen, isn't looked at.
 */
export function looking(agentId: string): boolean {
  const covered = view.settings !== null || view.newAgent || confirming() || (view.panel !== null && columns(window.innerWidth, view.sidebar).sheet);
  return window.desktop.present() && document.visibilityState === "visible" && document.hasFocus() && view.chat?.agentId === agentId && !covered;
}

/** Calls `listener` when anything `looking` goes by changes. Returns a function that stops it. */
function onLooking(listener: () => void): () => void {
  const stops = [subscribe(listener), onConfirm(listener), onResize(listener), onVisibility(listener), onFocusChange(listener), window.desktop.onPresent(listener)];
  return () => stops.forEach((stop) => stop());
}

/** Whether the person is looking at an agent's chat, as `looking` says, kept up as it changes. */
export function useLooking(agentId: string): boolean {
  return useSyncExternalStore(onLooking, () => looking(agentId));
}
