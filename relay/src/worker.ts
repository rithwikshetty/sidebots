// The relay passes Sidebots servers' notifications to Apple, under the push key
// of the developer account that publishes the app. It knows each server as a
// machine: a public key the server registered, and an id. It keeps nothing
// about people, agents or messages.
//
// Every request is signed with the machine's private key, in the header
//
//   Authorization: Signature <machine>:<time>:<signature>
//
// where `machine` is the machine's id, or for `POST /machines` the public key
// it registers, `time` is milliseconds since 1970, and the Ed25519 signature
// covers `<method> <path>\n<time>\n<sha256 of the body, in hex>`.

import { notify, type Notice, type PushKey } from "./apple.ts";

export type Env = {
  DB: D1Database;
  /** The push key's text, as Apple downloads it. */
  APNS_KEY: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  /** The identifier of the app the relay notifies. */
  APNS_TOPIC: string;
  /** How many notifications one machine may send in a day. */
  NOTICES_PER_DAY: string;
};

// How far a request's time may be from the relay's, either way.
const SKEW_MS = 5 * 60_000;
// A machine that sends nothing for this long is removed.
const STALE_MS = 60 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const ID_LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";
const PUBLIC_KEY = /^[\w-]{43}$/;
// An Apple device token as the iPhone reports it: hex, 32 bytes today, with room for Apple to lengthen it.
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/;

const fromBase64 = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
const answer = (body: object, status = 200) => Response.json(body, { status });

/** A machine's id: 16 random letters and digits, which in a later slice is also the label of its address. */
function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => ID_LETTERS[byte % ID_LETTERS.length]).join("");
}

/** Whether `signature` is the machine's, by `publicKey`, over this request. */
async function signedBy(publicKey: string, request: Request<unknown, unknown>, path: string, time: string, signature: string, body: ArrayBuffer): Promise<boolean> {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const signed = new TextEncoder().encode(`${request.method} ${path}\n${time}\n${hash}`);
  try {
    const key = await crypto.subtle.importKey("raw", fromBase64(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64(signature), signed);
  } catch {
    return false;
  }
}

/** Answers one request. `apple` is how the relay reaches Apple's push service, and `now` is the time. */
export async function handle(request: Request<unknown, unknown>, env: Env, apple: typeof fetch = fetch, now = Date.now()): Promise<Response> {
  const { pathname } = new URL(request.url);
  const route = `${request.method} ${pathname}`;
  if (route !== "POST /machines" && route !== "POST /notifications") return answer({ error: "No such route." }, 404);

  const [, machine = "", time = "", signature = ""] = /^Signature ([^:]+):(\d+):([\w-]+)$/.exec(request.headers.get("Authorization") ?? "") ?? [];
  if (Math.abs(now - Number(time)) > SKEW_MS) return answer({ error: "The request is unsigned, or its time is too far from the relay's." }, 401);
  const body = await request.arrayBuffer();

  if (route === "POST /machines") {
    if (!PUBLIC_KEY.test(machine) || !(await signedBy(machine, request, pathname, time, signature, body))) {
      return answer({ error: "A machine registers with a public key, and signs with it." }, 401);
    }
    // A key that is already registered keeps its id.
    const { id } = (await env.DB.prepare(
      "insert into machines (id, public_key, created_at, seen_at) values (?1, ?2, ?3, ?3) on conflict (public_key) do update set seen_at = ?3 returning id",
    )
      .bind(newId(), machine, now)
      .first<{ id: string }>())!;
    return answer({ id }, 201);
  }

  const known = await env.DB.prepare("select public_key from machines where id = ?").bind(machine).first<{ public_key: string }>();
  // A machine the relay doesn't know registers again, so the answer says so apart from a bad signature.
  if (!known) return answer({ error: "No such machine." }, 404);
  if (!(await signedBy(known.public_key, request, pathname, time, signature, body))) return answer({ error: "The signature isn't the machine's." }, 401);

  const { token, environment, notice } = JSON.parse(new TextDecoder().decode(body)) as { token?: string; environment?: string; notice?: Notice };
  if (!token || !DEVICE_TOKEN.test(token) || (environment !== "sandbox" && environment !== "production") || !notice) {
    return answer({ error: "A notice comes with the phone's token and its push service." }, 400);
  }
  const day = Math.floor(now / DAY_MS);
  const { sent } = (await env.DB.prepare(
    "update machines set seen_at = ?1, sent_count = case when sent_day = ?2 then sent_count + 1 else 1 end, sent_day = ?2 where id = ?3 returning sent_count as sent",
  )
    .bind(now, day, machine)
    .first<{ sent: number }>())!;
  if (sent > Number(env.NOTICES_PER_DAY)) return answer({ error: "This machine has sent all the notifications it may today." }, 429);

  const push: PushKey = { key: env.APNS_KEY, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID };
  return answer({ result: await notify(push, env.APNS_TOPIC, { token, environment }, notice, apple, now) });
}

/** Removes the machines that have sent nothing for 60 days. */
export async function removeStale(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("delete from machines where seen_at < ?").bind(now - STALE_MS).run();
}

export default {
  fetch: (request, env) => handle(request, env),
  scheduled: async (_controller, env) => removeStale(env),
} satisfies ExportedHandler<Env>;
