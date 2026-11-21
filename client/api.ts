// What a call to the Sidebots server can end in, for either app. Each app
// makes its calls with its own fetch, to its own address for the server, and
// says in its own words when Sidebots couldn't be reached.

import { CONTRACT_HEADER, CONTRACT_VERSION } from "../server/src/contract.ts";

const TIMEOUT_MS = 10_000;
// A message carrying photos and files, over a slow connection.
const UPLOAD_TIMEOUT_MS = 120_000;
// What Cloudflare or `tailscale serve` answers in Sidebots' place when the computer or its server can't be reached. 530 is Cloudflare's answer when the computer's tunnel is down.
const NOT_RUNNING = new Set([502, 503, 504, 530]);

/** A failed call. `status` is the server's answer, or 0 when Sidebots couldn't be reached. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Which of the two to update when the computer and this app speak different versions of the contract. */
export type Behind = "computer" | "app";

/**
 * Which side to update, from the contract version the computer sent with its
 * answer, or null when the two match. A computer too old to send a version is
 * behind. What Cloudflare or `tailscale serve` answers in Sidebots' place
 * carries no version and says nothing about it.
 */
export function behind(response: Pick<Response, "status" | "headers">): Behind | null {
  if (NOT_RUNNING.has(response.status)) return null;
  const version = Number(response.headers.get(CONTRACT_HEADER)) || 0;
  if (version === CONTRACT_VERSION) return null;
  return version < CONTRACT_VERSION ? "computer" : "app";
}

/** The host and code in a pairing link, which is what the computer's QR code holds. */
export function readPairingLink(link: string): { host: string; code: string } | null {
  const [, query] = /^sidebots:\/\/pair\/?\?(.+)$/.exec(link.trim()) ?? [];
  const params = new URLSearchParams(query ?? "");
  const host = params.get("host");
  const code = params.get("code");
  return host && code ? { host, code } : null;
}

/** An app's side of a call: what makes it, and the app's words for each way it can fail to reach Sidebots. */
export type Caller = {
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: FormData | string; signal: AbortSignal }): Promise<Response>;
  /** Nothing answered, as when the device is offline. */
  unreachable: string;
  /** Something answered in Sidebots' place, as when the computer is asleep. */
  notRunning: string;
  /** What to update when the two speak different versions of the contract, without its full stop. */
  update: Record<Behind, string>;
};

/**
 * Calls the server at `url` and resolves to what it answered. A `body` is
 * sent as JSON, or as it is when it is a form. It fails with an `ApiError`:
 * the server's own refusal with its status, or status 0 when no answer of
 * Sidebots' came in time.
 */
export async function call<T>(caller: Caller, url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<T> {
  // A browser's fetch works only when it is called by itself, not as the caller's.
  const { fetch } = caller;
  const form = init.body instanceof FormData ? init.body : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), form ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS);
  // The app says which version of the contract it speaks, which the computer checks before it pairs a device.
  const headers = { ...init.headers, [CONTRACT_HEADER]: String(CONTRACT_VERSION) };
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
    throw new ApiError(caller.unreachable, 0);
  } finally {
    clearTimeout(timer);
  }
  if (NOT_RUNNING.has(response.status)) throw new ApiError(caller.notRunning, 0);
  // Nothing a computer on another version says is used, so it can't be read wrongly. Until one side is updated it is as good as out of reach.
  const side = behind(response);
  if (side) throw new ApiError(`${caller.update[side]}.`, 0);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error ?? `The server answered ${response.status}.`, response.status);
  return data as T;
}
