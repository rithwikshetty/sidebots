// Talks to the Sidebots server on the computer this phone has paired with.
// For Apple's review that computer is the demo one inside the app, which
// answers the same calls.

import { useSyncExternalStore } from "react";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { deviceName } from "expo-device";
import * as SecureStore from "expo-secure-store";
import Storage from "expo-sqlite/kv-store";
import type { Paired } from "@server/contract";
import { ApiError, call, type Behind } from "@client/api";
import { DEMO_HOST, demoFetch, demoFile, demoSheet, isDemo } from "./demo";

export { ApiError, readPairingLink, type Behind } from "@client/api";

const HOST_KEY = "host";
const MACHINE_KEY = "machine";
// Set while the phone waits to pair again after its computer removed it.
const REMOVED_KEY = "removed";
const DEVICE_KEY = "device-key";
// The notification extension reads this one by its name, from the Keychain group it shares with the app.
const NOTIFICATION_KEY = "notification-key";
// Readable while the phone is locked, once it has been unlocked since it started, as a notification needs.
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

/** What to update when the computer and this app speak different versions of the contract. */
export const UPDATE: Record<Behind, string> = { computer: "Update Sidebots on your computer", app: "Update Sidebots on this phone" };
// The phone's words for a call that never reached Sidebots.
const WORDS = {
  unreachable: "Can't reach Sidebots. Check that the phone is online.",
  notRunning: "Can't reach Sidebots. The computer is asleep or off, or Sidebots isn't running on it.",
  update: UPDATE,
};

/** A computer that has paired this phone: its address, the key that proves this phone to it, the key that opens its notifications, and its name. */
export type Pairing = { host: string; key: string; notificationKey: string; machine: string };
/** A file on the computer: its address, and the header that lets this phone fetch it. */
export type Remote = { uri: string; headers: Record<string, string> };

// The address and the computer's name are in the app's store and the key in the Keychain, so a phone has paired when it holds the address and the key.
function kept(): { host: string; key: string; machine: string | null } | null {
  const host = Storage.getItemSync(HOST_KEY);
  const key = host ? SecureStore.getItem(DEVICE_KEY) : null;
  return host && key ? { host, key, machine: Storage.getItemSync(MACHINE_KEY) } : null;
}

let pairing = kept();
let removed = Storage.getItemSync(REMOVED_KEY) !== null;
let fresh = false;
const listeners = new Set<() => void>();

/** Calls `listener` when the phone pairs with a computer or loses its pairing. Returns a function that stops it. */
export function onPairing(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isPaired(): boolean {
  return pairing !== null;
}

export function usePaired(): boolean {
  return useSyncExternalStore(onPairing, isPaired);
}

/** The name of the computer this phone has paired with, or null when the phone holds none. */
export function useMachine(): string | null {
  return useSyncExternalStore(onPairing, () => pairing?.machine ?? null);
}

/** Whether the phone lost its pairing because the computer no longer knows it. It stays so, through relaunches, until the phone pairs again. */
export function wasRemoved(): boolean {
  return removed;
}

/**
 * Asks the computer at `host` to pair this phone, with a code the computer
 * made. The code works once. A key still in the Keychain is from a pairing
 * the app lost, as when it is deleted and installed again, since the Keychain
 * outlives the app. The phone sends that key's hash, which is all a computer
 * keeps of a key and lets nobody in, and the computer puts this pairing in
 * that one's place.
 */
export async function requestPairing({ host, code }: { host: string; code: string }): Promise<Pairing> {
  const lost = SecureStore.getItem(DEVICE_KEY);
  const replaces = lost ? await digestStringAsync(CryptoDigestAlgorithm.SHA256, lost) : undefined;
  const paired = await send<Paired>(`https://${host}/pair`, `Pairing ${code}`, { method: "POST", body: { name: deviceName ?? "Phone", replaces } });
  return { host, ...paired };
}

/** Keeps a pairing, from which point every call goes to that computer. The phone is fresh until the person has seen what it paired with. */
export function keepPairing({ host, key, notificationKey, machine }: Pairing): void {
  Storage.setItemSync(HOST_KEY, host);
  Storage.setItemSync(MACHINE_KEY, machine);
  SecureStore.setItem(DEVICE_KEY, key, KEYCHAIN);
  SecureStore.setItem(NOTIFICATION_KEY, notificationKey, KEYCHAIN);
  Storage.removeItemSync(REMOVED_KEY);
  pairing = { host, key, machine };
  removed = false;
  fresh = true;
  listeners.forEach((listener) => listener());
}

/** Whether the phone has just paired, and the person hasn't yet seen what with. It lasts until they have, or until the app next starts. */
export function useFresh(): boolean {
  return useSyncExternalStore(onPairing, () => fresh);
}

/** The person has seen what the phone paired with. */
export function greeted(): void {
  fresh = false;
  listeners.forEach((listener) => listener());
}

/**
 * Forgets the computer. `byComputer` says the computer let go of the phone,
 * having answered that it doesn't know it, which the welcome screen then
 * tells the person.
 */
export function unpair(byComputer = true): void {
  if (!pairing) return;
  Storage.removeItemSync(HOST_KEY);
  Storage.removeItemSync(MACHINE_KEY);
  void SecureStore.deleteItemAsync(DEVICE_KEY);
  void SecureStore.deleteItemAsync(NOTIFICATION_KEY);
  if (byComputer) Storage.setItemSync(REMOVED_KEY, "yes");
  pairing = null;
  removed = byComputer;
  listeners.forEach((listener) => listener());
}

/**
 * Disconnects from the computer, as the person asked. The computer forgets
 * the phone first, so it sends it nothing more, and then the phone forgets
 * the computer. It fails, with the phone still paired, when the computer
 * can't be told. `untold` disconnects the phone without telling it.
 */
export async function disconnect(untold = false): Promise<void> {
  if (!pairing) return;
  const { uri, headers } = remote("/device");
  if (!untold) {
    await send(uri, headers.Authorization, { method: "DELETE" }).catch((failure) => {
      // A computer that doesn't know the phone has nothing left to forget.
      if (!(failure instanceof ApiError && failure.status === 401)) throw failure;
    });
  }
  unpair(false);
}

/** Where a path on the computer is, with the header that lets this phone fetch it. */
export function remote(path: string): Remote {
  return { uri: `https://${pairing?.host}${path}`, headers: { Authorization: `Bearer ${pairing?.key}` } };
}

/** An avatar's spritesheet. The demo computer's are in the app's own files. */
export function avatarSheet(avatarId: string): Remote {
  return pairing?.host === DEMO_HOST ? { uri: demoSheet(avatarId), headers: {} } : remote(`/avatars/${avatarId}/spritesheet`);
}

/** A file sent with a message, from its path in the agent's folder. The demo computer's are in the app's own files. */
export function attachment(agentId: string, path: string): Remote {
  return pairing?.host === DEMO_HOST ? { uri: demoFile(path), headers: {} } : remote(`/agents/${agentId}/${path}`);
}

/** Calls the computer this phone has paired with. A `body` is sent as JSON, or as it is when it is a form. It fails when the phone leaves that computer before the answer comes. */
export async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!pairing) throw new ApiError("This phone isn't paired with a computer.", 0);
  const asked = pairing;
  const { uri, headers } = remote(path);
  try {
    const answer = await send<T>(uri, headers.Authorization, init);
    // An answer from a computer the phone has left since it asked is kept by nobody.
    if (pairing !== asked) throw new ApiError("This phone isn't paired with that computer.", 0);
    return answer;
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 401 && pairing === asked) unpair();
    throw failure;
  }
}

/** Calls a computer at `url`, or the demo computer when the address is its own. */
function send<T>(url: string, authorization: string, init: { method?: string; body?: unknown }): Promise<T> {
  return call<T>({ ...WORDS, fetch: isDemo(url) ? demoFetch : fetch }, url, { ...init, headers: { Authorization: authorization } });
}
