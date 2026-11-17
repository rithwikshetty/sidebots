// Talks to the Sidebots server on the Mac this phone has paired with.

import { useSyncExternalStore } from "react";
import { deviceName } from "expo-device";
import * as SecureStore from "expo-secure-store";
import Storage from "expo-sqlite/kv-store";
import { CONTRACT_HEADER, CONTRACT_VERSION, type Paired } from "@server/contract";

const HOST_KEY = "host";
// Set while the phone waits to pair again after its Mac removed it.
const REMOVED_KEY = "removed";
const DEVICE_KEY = "device-key";
// The notification extension reads this one by its name, from the Keychain group it shares with the app.
const NOTIFICATION_KEY = "notification-key";
// Readable while the phone is locked, once it has been unlocked since it started, as a notification needs.
const KEYCHAIN = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
const TIMEOUT_MS = 10_000;
// A message carrying photos, over a phone's connection.
const UPLOAD_TIMEOUT_MS = 120_000;
// What Cloudflare or `tailscale serve` answers in Sidebots' place when the Mac or its server can't be reached. 530 is Cloudflare's answer when the Mac's tunnel is down.
const NOT_RUNNING = new Set([502, 503, 504, 530]);

/** A failed call. `status` is the server's answer, or 0 when Sidebots couldn't be reached. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Which of the two to update when the Mac and this app speak different versions of the contract. */
export type Behind = "mac" | "app";
export const UPDATE: Record<Behind, string> = { mac: "Update Sidebots on your Mac", app: "Update Sidebots from the App Store" };

/**
 * Which side to update, from the contract version the Mac sent with its
 * answer, or null when the two match. A Mac too old to send a version is
 * behind. What Cloudflare or `tailscale serve` answers in Sidebots' place
 * carries no version and says nothing about it.
 */
export function behind(response: Pick<Response, "status" | "headers">): Behind | null {
  if (NOT_RUNNING.has(response.status)) return null;
  const version = Number(response.headers.get(CONTRACT_HEADER)) || 0;
  if (version === CONTRACT_VERSION) return null;
  return version < CONTRACT_VERSION ? "mac" : "app";
}

/** A Mac that has paired this phone: its address, the key that proves this phone to it, the key that opens its notifications, and its name. */
export type Pairing = { host: string; key: string; notificationKey: string; machine: string };
/** A file on the Mac: its address, and the header that lets this phone fetch it. */
export type Remote = { uri: string; headers: Record<string, string> };

// The address is in the app's store and the key in the Keychain, so a phone has paired when it holds both.
function kept(): { host: string; key: string } | null {
  const host = Storage.getItemSync(HOST_KEY);
  const key = host ? SecureStore.getItem(DEVICE_KEY) : null;
  return host && key ? { host, key } : null;
}

let pairing = kept();
let removed = Storage.getItemSync(REMOVED_KEY) !== null;
const listeners = new Set<() => void>();

/** Calls `listener` when the phone pairs with a Mac or loses its pairing. Returns a function that stops it. */
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

/** Whether the phone lost its pairing because the Mac no longer knows it. It stays so, through relaunches, until the phone pairs again. */
export function wasRemoved(): boolean {
  return removed;
}

/** The host and code in a pairing link, which is what the Mac's QR code holds. */
export function readPairingLink(link: string): { host: string; code: string } | null {
  const [, query] = /^sidebots:\/\/pair\/?\?(.+)$/.exec(link.trim()) ?? [];
  const params = new URLSearchParams(query ?? "");
  const host = params.get("host");
  const code = params.get("code");
  return host && code ? { host, code } : null;
}

/** Asks the Mac at `host` to pair this phone, with a code the Mac made. The code works once. */
export async function requestPairing({ host, code }: { host: string; code: string }): Promise<Pairing> {
  const paired = await send<Paired>(`https://${host}/pair`, `Pairing ${code}`, { method: "POST", body: { name: deviceName ?? "iPhone" } });
  return { host, ...paired };
}

/** Keeps a pairing, from which point every call goes to that Mac. */
export function keepPairing({ host, key, notificationKey }: Pairing): void {
  Storage.setItemSync(HOST_KEY, host);
  SecureStore.setItem(DEVICE_KEY, key, KEYCHAIN);
  SecureStore.setItem(NOTIFICATION_KEY, notificationKey, KEYCHAIN);
  Storage.removeItemSync(REMOVED_KEY);
  pairing = { host, key };
  removed = false;
  listeners.forEach((listener) => listener());
}

/** Forgets the Mac, once it has answered that it doesn't know this phone. */
export function unpair(): void {
  if (!pairing) return;
  Storage.removeItemSync(HOST_KEY);
  void SecureStore.deleteItemAsync(DEVICE_KEY);
  void SecureStore.deleteItemAsync(NOTIFICATION_KEY);
  Storage.setItemSync(REMOVED_KEY, "yes");
  pairing = null;
  removed = true;
  listeners.forEach((listener) => listener());
}

/** Where a path on the Mac is, with the header that lets this phone fetch it. */
export function remote(path: string): Remote {
  return { uri: `https://${pairing?.host}${path}`, headers: { Authorization: `Bearer ${pairing?.key}` } };
}

export function avatarSheet(avatarId: string): Remote {
  return remote(`/avatars/${avatarId}/spritesheet`);
}

/** A file sent with a message, from its path in the agent's folder. */
export function attachment(agentId: string, path: string): Remote {
  return remote(`/agents/${agentId}/${path}`);
}

/** Calls the Mac this phone has paired with. A `body` is sent as JSON, or as it is when it is a form. */
export async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!pairing) throw new ApiError("This phone isn't paired with a Mac.", 0);
  const { uri, headers } = remote(path);
  try {
    return await send<T>(uri, headers.Authorization, init);
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 401) unpair();
    throw failure;
  }
}

async function send<T>(url: string, authorization: string, init: { method?: string; body?: unknown }): Promise<T> {
  const form = init.body instanceof FormData ? init.body : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), form ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS);
  // The app says which version of the contract it speaks, which the Mac checks before it pairs the phone.
  const headers = { Authorization: authorization, [CONTRACT_HEADER]: String(CONTRACT_VERSION) };
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      // A form names its own content type, with the boundary between its parts.
      headers: form ? headers : { ...headers, "Content-Type": "application/json" },
      body: form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError("Can't reach Sidebots. Check that the phone is online.", 0);
  } finally {
    clearTimeout(timer);
  }
  if (NOT_RUNNING.has(response.status)) throw new ApiError("Can't reach Sidebots. The Mac is asleep or off, or Sidebots isn't running on it.", 0);
  // Nothing a Mac on another version says is used, so it can't be read wrongly. Until one side is updated it is as good as out of reach.
  const side = behind(response);
  if (side) throw new ApiError(`${UPDATE[side]}.`, 0);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error ?? `The server answered ${response.status}.`, response.status);
  return data as T;
}
