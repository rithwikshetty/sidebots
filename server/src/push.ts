// Push sends notifications through Apple's push service (APNs).

import { sign } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";
import { plainText } from "./contract.ts";
import type { Device } from "./contract.ts";
import type { PushKey, Store } from "./store.ts";

/** A notification: the agent's name over what it said, and the number the app's icon shows, which is everything the person hasn't read. */
export type Notice = { title: string; body: string; badge: number; agentId: string; messageId: string };
/** `gone` means Apple will never deliver to this phone's token again. */
export type SendPush = (device: Device, notice: Notice) => Promise<"sent" | "gone" | "failed">;

const ORIGINS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" } as const;
// Apple accepts a provider token for an hour and refuses one renewed more often than every 20 minutes.
const PROVIDER_TOKEN_MS = 45 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const GONE_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);
const STALE_TOKEN_REASONS = new Set(["ExpiredProviderToken", "InvalidProviderToken"]);
// A notification shows a few lines, and Apple takes at most 4096 bytes.
const BODY_CHARS = 600;
// The app's own sound, which it carries in its bundle.
const SOUND = "simon.wav";

/** Tells the person's phones when an agent replies or a turn fails, unless the agent is muted. An update while it works tells nobody. Returns a function that stops it. */
export function startPush(store: Store, send: SendPush): () => void {
  return store.onMessage((message) => {
    const finished = (message.sender === "agent" && !message.interim) || (message.sender === "simon" && message.status === "failed");
    const agent = finished ? store.agent(message.agent_id) : undefined;
    if (!agent || agent.muted) return;
    // A muted agent's unread replies show on its own row, and never on the app's icon.
    const badge = store.agentsFor(agent.person_id).reduce((total, each) => total + (each.muted ? 0 : each.unread), 0);
    const notice: Notice = { title: agent.name, body: plainText(message.body).slice(0, BODY_CHARS), badge, agentId: agent.id, messageId: message.id };
    for (const device of store.devicesFor(agent.person_id)) {
      void send(device, notice).then((result) => {
        if (result === "gone") store.removeDevice(device.token);
      });
    }
  });
}

/** Sends through APNs, signed with the developer account's push key. */
export function apns(key: PushKey): SendPush {
  let providerToken: { value: string; madeAt: number } | null = null;
  const sessions = new Map<string, ClientHttp2Session>();

  const token = (): string => {
    const now = Date.now();
    if (!providerToken || now - providerToken.madeAt >= PROVIDER_TOKEN_MS) {
      const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const unsigned = `${part({ alg: "ES256", kid: key.keyId })}.${part({ iss: key.teamId, iat: Math.floor(now / 1000) })}`;
      const signature = sign("sha256", Buffer.from(unsigned), { key: key.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
      providerToken = { value: `${unsigned}.${signature}`, madeAt: now };
    }
    return providerToken.value;
  };

  // APNs speaks HTTP/2 and wants one connection kept open and reused.
  const session = (origin: string): ClientHttp2Session => {
    const open = sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const fresh = connect(origin);
    fresh.on("error", () => fresh.destroy());
    fresh.on("close", () => sessions.get(origin) === fresh && sessions.delete(origin));
    sessions.set(origin, fresh);
    return fresh;
  };

  return (device, notice) =>
    new Promise((resolve) => {
      const request = session(ORIGINS[device.environment]).request({
        ":method": "POST",
        ":path": `/3/device/${device.token}`,
        authorization: `bearer ${token()}`,
        "apns-topic": device.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-collapse-id": notice.messageId,
      });
      let status = 0;
      let answer = "";
      request.setEncoding("utf8");
      request.setTimeout(REQUEST_TIMEOUT_MS, () => request.close());
      request.on("response", (headers) => (status = Number(headers[":status"])));
      request.on("data", (chunk: string) => (answer += chunk));
      request.on("error", () => resolve("failed"));
      request.on("close", () => {
        if (status === 200) return resolve("sent");
        let reason = "";
        try {
          reason = (JSON.parse(answer) as { reason?: string }).reason ?? "";
        } catch {
          // No reason given.
        }
        if (STALE_TOKEN_REASONS.has(reason)) providerToken = null;
        resolve(status === 410 || GONE_REASONS.has(reason) ? "gone" : "failed");
      });
      request.end(
        JSON.stringify({
          // One agent's notifications stack together on the Lock Screen.
          aps: { alert: { title: notice.title, body: notice.body }, badge: notice.badge, sound: SOUND, "thread-id": notice.agentId },
          // expo-notifications hands the app whatever is under "body" as the notification's data.
          body: { agent_id: notice.agentId },
        }),
      );
    });
}
