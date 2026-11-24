// Apple sends a notification to a phone only for the developer account whose push key signed the request.

import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";

/** A push key from Apple: the key's text as Apple downloads it, its ID, and the account's team ID. */
export type PushKey = { key: string; keyId: string; teamId: string };
/**
 * A notification as a server encrypted it for one phone, in base64, and the
 * message it is about. Only the phone can read it. The app opens it as it
 * arrives, and shows what the agent said in place of the relay's words.
 */
export type Sealed = { sealed: string; messageId: string };
/**
 * How a Live Activity ends: the state its agent's work left the avatar in.
 * The phone drew the activity with the agent's name and picture when it
 * started it, so its end carries no more than this.
 */
export const ENDED = ["resting", "replied", "failed"] as const;
export type Ended = (typeof ENDED)[number];
/** `gone` means Apple will never deliver to this token again. */
export type Result = "sent" | "gone" | "failed";

const ORIGINS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" } as const;
// Apple accepts a provider token for an hour and refuses one renewed more often than every 20 minutes.
const TOKEN_SECONDS = 45 * 60;
const GONE_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
// The app's own sound, which it carries in its bundle.
const SOUND = "sidebots.wav";
// How long an ended Live Activity stays on the Lock Screen with the reply or the failure it ended on.
const LINGER_SECONDS = 15 * 60;

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const fromBase64 = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));

/** The push key's secret number, which signs provider tokens. Web Crypto reads the key, and hands the number over as a JWK's `d`. */
async function scalarOf(key: string): Promise<Uint8Array> {
  const der = fromBase64(key.replace(/-----[^-]+-----|\s/g, ""));
  const imported = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const { d } = await crypto.subtle.exportKey("jwk", imported);
  if (!d) throw new Error("The push key isn't a P-256 private key.");
  return fromBase64(d);
}

let cached: { key: string; issuedAt: number; token: string } | null = null;

/**
 * The token that proves to Apple who is sending, for the 45 minutes the
 * current time falls in. The relay runs as many copies at once, and each makes
 * its own token. Signing is deterministic and the time is rounded down to the
 * 45 minutes, so every copy makes the same one, and Apple never sees it renewed
 * too often.
 */
async function providerToken(push: PushKey, now: number): Promise<string> {
  const issuedAt = Math.floor(now / 1000 / TOKEN_SECONDS) * TOKEN_SECONDS;
  if (cached?.key === push.key && cached.issuedAt === issuedAt) return cached.token;
  const part = (value: object) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${part({ alg: "ES256", kid: push.keyId })}.${part({ iss: push.teamId, iat: issuedAt })}`;
  const signature = p256.sign(sha256(new TextEncoder().encode(unsigned)), await scalarOf(push.key), { prehash: false }).toCompactRawBytes();
  cached = { key: push.key, issuedAt, token: `${unsigned}.${base64url(signature)}` };
  return cached.token;
}

type Phone = { token: string; environment: "sandbox" | "production" };

/** Sends Apple one request for one token, at once. `send` is how the relay reaches Apple. */
async function deliver(push: PushKey, to: Phone, headers: Record<string, string>, body: object, send: typeof fetch, now: number): Promise<Result> {
  let response: Response;
  try {
    response = await send(`${ORIGINS[to.environment]}/3/device/${to.token}`, {
      method: "POST",
      headers: { authorization: `bearer ${await providerToken(push, now)}`, "apns-priority": "10", ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    return "failed";
  }
  if (response.ok) return "sent";
  const { reason = "" } = await response.json<{ reason?: string }>().catch(() => ({ reason: "" }));
  return response.status === 410 || GONE_REASONS.has(reason) ? "gone" : "failed";
}

/** Sends one notification to one phone, for the app `topic` names. */
export function notify(push: PushKey, topic: string, to: Phone, notice: Sealed, send: typeof fetch, now: number): Promise<Result> {
  return deliver(
    push,
    to,
    { "apns-topic": topic, "apns-push-type": "alert", "apns-collapse-id": notice.messageId },
    {
      // What shows if the app can't open the notice. `mutable-content` has iOS hand it to the app's notification extension first.
      aps: { alert: { title: "Sidebots", body: "New message" }, sound: SOUND, "mutable-content": 1 },
      sealed: notice.sealed,
    },
    send,
    now,
  );
}

/**
 * Tells one phone, for the app `topic` names, that the person has read on
 * another device what it shows notifications for. It shows and sounds
 * nothing: iOS wakes the app, which asks its computer what is left unread and
 * takes the rest away. Apple sends these when it suits the phone, so one can
 * come late, and none reaches an app the person has quit.
 */
export function tellRead(push: PushKey, topic: string, to: Phone, send: typeof fetch, now: number): Promise<Result> {
  return deliver(push, to, { "apns-topic": topic, "apns-push-type": "background", "apns-priority": "5" }, { aps: { "content-available": 1 } }, send, now);
}

/**
 * Ends one Live Activity of the app `topic` names, by the token Apple gave the
 * phone for it. The activity shows the state it ended on and leaves the Lock
 * Screen a while later, or at once when the agent is left resting, with
 * nothing to show.
 */
export function endActivity(push: PushKey, topic: string, to: Phone, ended: Ended, send: typeof fetch, now: number): Promise<Result> {
  const seconds = Math.floor(now / 1000);
  return deliver(
    push,
    to,
    { "apns-topic": `${topic}.push-type.liveactivity`, "apns-push-type": "liveactivity" },
    { aps: { timestamp: seconds, event: "end", "content-state": { state: ended }, "dismissal-date": ended === "resting" ? seconds : seconds + LINGER_SECONDS } },
    send,
    now,
  );
}
