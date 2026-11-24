// What the app knows: the person's agents, their messages and the avatars,
// which the store in `client/` keeps for both apps. This is the phone's side
// of it: the computer the phone has paired with, or the demo one, Expo's
// fetch and storage, and iOS's own sheets.

import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { fetch as streamingFetch } from "expo/fetch";
import { File } from "expo-file-system";
import { Image } from "expo-image";
import Storage from "expo-sqlite/kv-store";
import * as WebBrowser from "expo-web-browser";
import type { Avatar } from "@server/contract";
import { createStore } from "@client/store";
import { avatarSheet, isPaired, onPairing, remote, request, unpair } from "./api";
import { demoFetch, isDemo } from "./demo";
import type { Picked } from "./files";

export type { AgentChanges } from "@client/store";

const store = createStore<Picked>({
  request,
  events(signal) {
    const events = remote("/events");
    return (isDemo(events.uri) ? demoFetch : streamingFetch)(events.uri, { headers: { ...events.headers, Accept: "text/event-stream" }, signal });
  },
  storage: { getItem: (key) => Storage.getItemSync(key), setItem: (key, value) => void Storage.setItem(key, value) },
  // iOS drops the stream while the app is in the background, and leaves it open while the app is only covered, as by Control Centre.
  onFront(listener) {
    let dropped = false;
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "background") dropped = true;
      if (next !== "active") return;
      listener(dropped);
      dropped = false;
    });
    return () => appState.remove();
  },
  // Expo's fetch takes a file as its name, its type and a way to read its bytes, which it does as the message goes.
  attach: (form, file) => form.append("files", { name: file.name, type: file.type, bytes: () => new File(file.uri).bytes() } as unknown as Blob),
  // The sign-in opens in the sheet iOS has for one.
  async signIn(url, redirect) {
    const ended = await WebBrowser.openAuthSessionAsync(url, redirect);
    return ended.type === "success" ? ended.url : null;
  },
  // The computer doesn't know this phone, so there is nothing to listen to until it pairs again.
  onRefused: () => unpair(),
  keepSheets,
  useSyncExternalStore,
});

export const {
  useAgents,
  useAgent,
  useMessages,
  useHole,
  useAvatars,
  useChatColor,
  useAbout,
  useUsage,
  useConnections,
  useOnline,
  useBehind,
  onAgents,
  loadMessages,
  loadOlder,
  backToNewest,
  send,
  answerAsk,
  freshStart,
  resend,
  stop,
  createAgent,
  changeAgent,
  deleteAgent,
  loadAbout,
  loadUsage,
  loadConnections,
  connect,
  removeConnection,
  removeJob,
  findMessages,
  markRead,
} = store;

/**
 * Saves every avatar's spritesheet on the phone, so an avatar the phone
 * hasn't drawn yet, as in the avatar picker, shows without a wait for the
 * computer. A sheet the phone already has isn't fetched again.
 */
function keepSheets(avatars: Avatar[]): void {
  const sheets = avatars.map((avatar) => avatarSheet(avatar.id));
  if (sheets.length === 0) return;
  void Image.prefetch(sheets.map((sheet) => sheet.uri), { cachePolicy: "disk", headers: sheets[0].headers }).catch(() => undefined);
}

/** Keeps the app's copy current, once the phone has paired with a computer. */
export function startSync(): void {
  if (isPaired()) store.startSync();
}

// Pairing with a computer starts the sync. Losing the pairing stops it, and clears what the phone kept of that computer.
onPairing(() => {
  if (isPaired()) return store.startSync();
  store.stopSync();
  store.clear();
});
