// Talks to the Simon server whose address the person entered at first launch.

import Storage from "expo-sqlite/kv-store";

const SERVER_KEY = "server";
const TIMEOUT_MS = 10_000;
// A message carrying photos, over a phone's connection.
const UPLOAD_TIMEOUT_MS = 120_000;
// What `tailscale serve` answers in Simon's place when Simon isn't running.
const NOT_RUNNING = new Set([502, 503, 504]);

/** A failed call. `status` is the server's answer, or 0 when Simon couldn't be reached. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function serverUrl(): string | null {
  return Storage.getItemSync(SERVER_KEY);
}

export function petSheetUrl(petId: string): string {
  return `${serverUrl()}/pets/${petId}/spritesheet`;
}

/** The address of a file sent with a message, from its path in the agent's folder. */
export function attachmentUrl(agentId: string, path: string): string {
  return `${serverUrl()}/agents/${agentId}/${path}`;
}

/** Calls the server. A `body` is sent as JSON, or as it is when it is a form. */
export async function request<T>(path: string, init: { method?: string; body?: unknown; base?: string } = {}): Promise<T> {
  const base = init.base ?? serverUrl();
  if (!base) throw new ApiError("Simon has no server address yet.", 0);
  const form = init.body instanceof FormData ? init.body : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), form ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(base + path, {
      method: init.method ?? "GET",
      // A form names its own content type, with the boundary between its parts.
      headers: form ? undefined : { "Content-Type": "application/json" },
      body: form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
      signal: controller.signal,
    });
  } catch {
    throw new ApiError("Can't reach Simon. Check that Tailscale is on.", 0);
  } finally {
    clearTimeout(timer);
  }
  if (NOT_RUNNING.has(response.status)) throw new ApiError("Can't reach Simon. The server isn't running.", 0);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error ?? `The server answered ${response.status}.`, response.status);
  return data as T;
}

/** Checks that a Simon server answers at the address, then remembers it. */
export async function connect(address: string): Promise<void> {
  const trimmed = address.trim().replace(/\/+$/, "");
  if (!trimmed) throw new ApiError("Enter the server's address.", 0);
  const base = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  const pets = await request<unknown>("/pets", { base });
  if (!Array.isArray(pets)) throw new ApiError("That address isn't a Simon server.", 0);
  Storage.setItemSync(SERVER_KEY, base);
}
