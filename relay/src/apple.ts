// Apple sends a notification to a phone only for the developer account whose push key signed the request.

import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";

/** A push key from Apple: the key's text as Apple downloads it, its ID, and the account's team ID. */
export type PushKey = { key: string; keyId: string; teamId: string };
/** What a notification says: the agent's name over what it said, and the number for the app's icon. */
export type Notice = { title: string; body: string; badge: number; agentId: string; messageId: string };
/** `gone` means Apple will never deliver to this phone's token again. */
export type Result = "sent" | "gone" | "failed";

const ORIGINS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" } as const;
// Apple accepts a provider token for an hour and refuses one renewed more often than every 20 minutes.
const TOKEN_SECONDS = 45 * 60;
const GONE_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
// The app's own sound, which it carries in its bundle.
const SOUND = "sidebots.wav";

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

/** Sends one notification to one phone, for the app `topic` names. `send` is how the relay reaches Apple. */
export async function notify(
  push: PushKey,
  topic: string,
  to: { token: string; environment: "sandbox" | "production" },
  notice: Notice,
  send: typeof fetch,
  now: number,
): Promise<Result> {
  let response: Response;
  try {
    response = await send(`${ORIGINS[to.environment]}/3/device/${to.token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${await providerToken(push, now)}`,
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-collapse-id": notice.messageId,
      },
      body: JSON.stringify({
        // One agent's notifications stack together on the Lock Screen.
        aps: { alert: { title: notice.title, body: notice.body }, badge: notice.badge, sound: SOUND, "thread-id": notice.agentId },
        // expo-notifications hands the app whatever is under "body" as the notification's data.
        body: { agent_id: notice.agentId },
      }),
    });
  } catch {
    return "failed";
  }
  if (response.ok) return "sent";
  const { reason = "" } = await response.json<{ reason?: string }>().catch(() => ({ reason: "" }));
  return response.status === 410 || GONE_REASONS.has(reason) ? "gone" : "failed";
}
