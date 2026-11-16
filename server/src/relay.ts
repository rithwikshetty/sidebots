// The relay gives this machine its address and tunnel, and passes the server's
// notifications to Apple, under the push key of the developer account that
// publishes the app. This is the only module that talks to it.
// `relay/src/worker.ts` describes how a request is signed.

import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { SendPush } from "./push.ts";
import type { Machine, Store } from "./store.ts";

/** The relay, as the server uses it: `register` brings the machine its id, address and tunnel token, and `notify` sends a notification. */
export type Relay = { register(): Promise<Required<Machine>>; notify: SendPush };

/** Talks to the relay at `origin` for a server listening on `port`. `send` is how the server reaches the relay. */
export function relay(store: Store, origin: string, port: number, send: typeof fetch = fetch): Relay {
  let registering: Promise<Required<Machine>> | null = null;

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

  /**
   * Registers the machine and keeps what the relay answers. Registering again
   * with the same key brings the same machine, and tells the relay it is still
   * in use. Registrations at once share one call.
   */
  const register = (): Promise<Required<Machine>> => {
    registering ??= (async () => {
      const privateKey = key();
      const publicKey = privateKey.export({ format: "jwk" }).x!;
      const response = await call("/machines", publicKey, privateKey, JSON.stringify({ port }));
      if (!response.ok) throw new Error(`The relay answered ${response.status} to registering.`);
      const { id, address, tunnelToken } = (await response.json()) as { id: string; address: string; tunnelToken: string };
      const machine = { privateKey: store.machine()!.privateKey, id, address, tunnelToken };
      store.setMachine(machine);
      return machine;
    })().finally(() => (registering = null));
    return registering;
  };

  /** The machine's id with the relay, which the server registers for when it has none. */
  const machineId = async (): Promise<string> => store.machine()?.id ?? (await register()).id;

  const notify: SendPush = async (to, notice) => {
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

  return { register, notify };
}
