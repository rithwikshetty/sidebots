// The relay passes this server's notifications to Apple, under the push key of
// the developer account that publishes the app. This is the only module that
// talks to it. `relay/src/worker.ts` describes how a request is signed.

import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { SendPush } from "./push.ts";
import type { Store } from "./store.ts";

/** Sends notifications through the relay at `origin`. The server registers with it the first time it sends one. `send` is how the server reaches the relay. */
export function relay(store: Store, origin: string, send: typeof fetch = fetch): SendPush {
  let registering: Promise<string> | null = null;

  /** The machine's signing key. The server makes one the first time it needs it, and keeps it. */
  const key = (): KeyObject => {
    const kept = store.machine();
    if (kept) return createPrivateKey(kept.privateKey);
    const { privateKey } = generateKeyPairSync("ed25519");
    store.setMachine({ privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
    return privateKey;
  };

  /** Calls the relay as `machine`, which is its id, or the public key when it registers. */
  const call = (path: string, machine: string, privateKey: KeyObject, body: string) => {
    const time = String(Date.now());
    const hash = createHash("sha256").update(body).digest("hex");
    const signature = sign(null, Buffer.from(`POST ${path}\n${time}\n${hash}`), privateKey).toString("base64url");
    return send(origin + path, {
      method: "POST",
      headers: { Authorization: `Signature ${machine}:${time}:${signature}`, "Content-Type": "application/json" },
      body,
    });
  };

  /** The machine's id with the relay, which the server asks for once and keeps. */
  const machineId = (): Promise<string> => {
    const kept = store.machine()?.id;
    if (kept) return Promise.resolve(kept);
    // Notices that go at once share one registration.
    registering ??= (async () => {
      const privateKey = key();
      const publicKey = privateKey.export({ format: "jwk" }).x!;
      const response = await call("/machines", publicKey, privateKey, "");
      if (!response.ok) throw new Error(`The relay answered ${response.status} to registering.`);
      const { id } = (await response.json()) as { id: string };
      store.setMachine({ privateKey: store.machine()!.privateKey, id });
      return id;
    })().finally(() => (registering = null));
    return registering;
  };

  return async (to, notice) => {
    const body = JSON.stringify({ token: to.token, environment: to.environment, ...notice });
    try {
      let response = await call("/notifications", await machineId(), key(), body);
      // The relay removes a machine it hasn't heard from in 60 days. The machine registers again with the key it has.
      if (response.status === 404) {
        store.setMachine({ privateKey: store.machine()!.privateKey });
        response = await call("/notifications", await machineId(), key(), body);
      }
      if (!response.ok) return "failed";
      return ((await response.json()) as { result: "sent" | "gone" | "failed" }).result;
    } catch {
      return "failed";
    }
  };
}
