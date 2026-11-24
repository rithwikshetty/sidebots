// The relay gives each Sidebots server an address under the zone, through a
// Cloudflare Tunnel, and passes the server's notifications to Apple, under the
// push key of the developer account that publishes the app. Each notification
// comes encrypted for the phone it goes to, so the relay can't read it. It
// also tells a phone that something was read on another device, without
// saying what, and ends a Live Activity for the server, which says only the
// state the avatar is left in. It knows each server as a machine: a public key the server
// registered, an id, and its tunnel. As a machine registers it may say how
// much it is used: the version of the Mac app it runs in, how many agents and
// paired phones it has, and how many turns its agents ran each day, by provider
// and kind of turn. The relay keeps those numbers, and nothing about who
// anyone is or what was said.
//
// Every request is signed with the machine's private key, in the header
//
//   Authorization: Signature <machine>:<time>:<signature>
//
// where `machine` is the machine's id, or for `POST /machines` the public key
// it registers, `time` is milliseconds since 1970, and the Ed25519 signature
// covers `<method> <path>\n<time>\n<sha256 of the body, in hex>`.

import { ENDED, endActivity, notify, tellRead, type Ended, type PushKey } from "./apple.ts";
import { capacity, makeTunnel, removeTunnel, routeTunnel, type Tunnels } from "./cloudflare.ts";

export type Env = {
  DB: D1Database;
  /** The push key's text, as Apple downloads it. */
  APNS_KEY: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  /** The bundle identifiers of the apps the relay notifies, between spaces. The first is the published app, for a notice that names none. */
  APNS_TOPICS: string;
  /** How many notifications one machine may send in a day. */
  NOTICES_PER_DAY: string;
  /** The zone machines' addresses are under, such as `sidebots.app`, and its id. */
  ZONE: string;
  ZONE_ID: string;
  /** The Cloudflare account the zone and the tunnels are in, and an API token that can edit its tunnels and the zone's DNS records. */
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  /** How many tunnels the account may hold: the 1,000 Cloudflare gives every account, and any it bought. */
  TUNNELS: string;
  /** Limits how many new machines one network address registers in a minute. */
  NEW_MACHINES: RateLimit;
};

// How far a request's time may be from the relay's, either way.
const SKEW_MS = 5 * 60_000;
// A machine that sends nothing for this long is removed.
const STALE_MS = 60 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const ID_LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";
const PUBLIC_KEY = /^[\w-]{43}$/;
// A token of Apple's as the phone reports it, in hex: 32 bytes for a phone today and 128 for a Live Activity, with room for Apple to lengthen either.
const DEVICE_TOKEN = /^[0-9a-f]{64,512}$/;
// An encrypted notice, in base64, small enough that Apple takes the notification it rides in, which is at most 4096 bytes.
const SEALED = /^[A-Za-z0-9+/]{1,3800}={0,2}$/;
const MESSAGE_ID = /^[\w-]{1,64}$/;
// The server's port on its machine, when a machine registers without one.
const DEFAULT_PORT = 4317;
// What a machine may say of its use. The relay keeps a count or one of these words, and never words of the machine's choosing. It leaves out what is neither and registers the machine all the same, since a machine needs its address whatever it counts.
const VERSION = /^\d{1,4}(\.\d{1,4}){1,3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDERS = ["claude", "codex"];
const KINDS = ["reply", "job", "memory"];
// The most a machine may say it has of anything.
const MOST = 1_000_000;

const fromBase64 = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
const answer = (body: object, status = 200) => Response.json(body, { status });

/** A machine's id: 16 random letters and digits, which is also the label of its address. */
function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => ID_LETTERS[byte % ID_LETTERS.length]).join("");
}

/** A count a machine gave, or null when it is no count. */
const countOf = (value: unknown): number | null => (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MOST ? (value as number) : null);

/** The turns a machine said its agents ran, less what is no day near `now`, no provider or kind of turn the relay knows, or no count. */
function turnsIn(said: unknown, now: number): { day: string; provider: string; kind: string; turns: number }[] {
  if (!Array.isArray(said)) return [];
  return said.slice(0, 100).flatMap((each: Record<string, unknown> | null) => {
    const { day, provider, kind, turns } = each ?? {};
    // A day is the date on the machine, which is up to a day ahead of the relay's. A machine counts back a week.
    const age = typeof day === "string" && DAY.test(day) ? now - Date.parse(day) : NaN;
    const known = age > -DAY_MS && age < 9 * DAY_MS && PROVIDERS.includes(provider as string) && KINDS.includes(kind as string) && countOf(turns);
    return known ? [{ day: day as string, provider: provider as string, kind: kind as string, turns: turns as number }] : [];
  });
}

const tunnelsOf = (env: Env): Tunnels => ({ token: env.CLOUDFLARE_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID, zoneId: env.ZONE_ID });
const addressOf = (id: string, env: Env) => `${id}.${env.ZONE}`;

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

/** How full the zone and the account are, in a sentence, and whether either has no room for another machine. Each machine takes one of the zone's DNS records and one of the account's tunnels. */
async function roomOf(env: Env, send: typeof fetch): Promise<{ full: boolean; said: string }> {
  const { records, recordsMost, tunnels } = await capacity(tunnelsOf(env), send);
  const tunnelsMost = Number(env.TUNNELS);
  return { full: records >= recordsMost || tunnels >= tunnelsMost, said: `The zone holds ${records} of ${recordsMost} DNS records, and the account ${tunnels} of ${tunnelsMost} tunnels.` };
}

/** Removes a machine with its tunnel and its address. */
async function forget(env: Env, machine: { id: string; tunnel_id: string | null }, send: typeof fetch): Promise<void> {
  if (machine.tunnel_id) await removeTunnel(tunnelsOf(env), machine.tunnel_id, addressOf(machine.id, env), send);
  await env.DB.prepare("delete from machines where id = ?").bind(machine.id).run();
}

/** Answers one request. `send` is how the relay reaches Apple's push service and Cloudflare's API, and `now` is the time. */
export async function handle(request: Request<unknown, unknown>, env: Env, send: typeof fetch = fetch, now = Date.now()): Promise<Response> {
  const { pathname } = new URL(request.url);
  const route = /^DELETE \/machines\/[a-z0-9]+$/.test(`${request.method} ${pathname}`) ? "DELETE /machines/:id" : `${request.method} ${pathname}`;
  if (route !== "POST /machines" && route !== "DELETE /machines/:id" && route !== "POST /notifications") return answer({ error: "No such route." }, 404);

  const [, machine = "", time = "", signature = ""] = /^Signature ([^:]+):(\d+):([\w-]+)$/.exec(request.headers.get("Authorization") ?? "") ?? [];
  if (Math.abs(now - Number(time)) > SKEW_MS) return answer({ error: "The request is unsigned, or its time is too far from the relay's." }, 401);
  const body = await request.arrayBuffer();

  if (route === "POST /machines") {
    if (!PUBLIC_KEY.test(machine) || !(await signedBy(machine, request, pathname, time, signature, body))) {
      return answer({ error: "A machine registers with a public key, and signs with it." }, 401);
    }
    // The server says which port it listens on, and an empty body means the usual one. It may say how much it is used.
    const { port = DEFAULT_PORT, version, agents, phones, turns } = (body.byteLength ? JSON.parse(new TextDecoder().decode(body)) : {}) as Record<string, unknown>;
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return answer({ error: "A machine's port is a whole number up to 65535." }, 400);
    const registered = await env.DB.prepare("select 1 from machines where public_key = ?").bind(machine).first();
    if (!registered && !(await env.NEW_MACHINES.limit({ key: request.headers.get("CF-Connecting-IP") ?? "" })).success) {
      return answer({ error: "This network has registered too many machines in the last minute. Try again in a minute." }, 429);
    }
    // A key that is already registered keeps its id and its tunnel. What the machine says of itself replaces what it said before.
    const { id, tunnel_id } = (await env.DB.prepare(
      `insert into machines (id, public_key, created_at, seen_at, version, agents, phones) values (?1, ?2, ?3, ?3, ?4, ?5, ?6)
         on conflict (public_key) do update set seen_at = ?3, version = ?4, agents = ?5, phones = ?6 returning id, tunnel_id`,
    )
      .bind(newId(), machine, now, typeof version === "string" && VERSION.test(version) ? version : null, countOf(agents), countOf(phones))
      .first<{ id: string; tunnel_id: string | null }>())!;
    // A machine says each of its last days again as it registers, and a day's count only grows: an agent that is deleted takes its turns out of the machine's own count. SQLite reads `on conflict` after a select as part of a join unless a `where` comes first.
    const ran = turnsIn(turns, now);
    if (ran.length) {
      await env.DB.prepare(
        `insert into turns (machine_id, day, provider, kind, turns)
           select ?1, json_extract(value, '$.day'), json_extract(value, '$.provider'), json_extract(value, '$.kind'), json_extract(value, '$.turns') from json_each(?2) where true
           on conflict (machine_id, day, provider, kind) do update set turns = max(turns, excluded.turns)`,
      )
        .bind(id, JSON.stringify(ran))
        .run();
    }
    const address = addressOf(id, env);
    try {
      let tunnelId = tunnel_id;
      if (!tunnelId) {
        const made = await makeTunnel(tunnelsOf(env), address, send);
        // Two registrations at once both make a tunnel, and the one that is saved first stays.
        const { meta } = await env.DB.prepare("update machines set tunnel_id = ?1 where id = ?2 and tunnel_id is null").bind(made, id).run();
        if (meta.changes === 0) await removeTunnel(tunnelsOf(env), made, address, send);
        tunnelId = (await env.DB.prepare("select tunnel_id from machines where id = ?").bind(id).first<{ tunnel_id: string }>())!.tunnel_id;
      }
      const tunnelToken = await routeTunnel(tunnelsOf(env), tunnelId, address, port as number, send);
      return answer({ id, address, tunnelToken }, 201);
    } catch (failure) {
      console.error(failure);
      // Cloudflare refuses a new machine's tunnel or DNS record when the account or the zone is full.
      const room = tunnel_id ? null : await roomOf(env, send).catch(() => null);
      if (!room?.full) return answer({ error: "The relay couldn't make the machine's tunnel." }, 502);
      console.error(`The relay has no room for another machine. ${room.said}`);
      return answer({ error: "The relay has no room for another machine." }, 503);
    }
  }

  const known = await env.DB.prepare("select id, public_key, tunnel_id from machines where id = ?").bind(machine).first<{ id: string; public_key: string; tunnel_id: string | null }>();
  // A machine the relay doesn't know registers again, so the answer says so apart from a bad signature.
  if (!known) return answer({ error: "No such machine." }, 404);
  if (!(await signedBy(known.public_key, request, pathname, time, signature, body))) return answer({ error: "The signature isn't the machine's." }, 401);

  if (route === "DELETE /machines/:id") {
    if (pathname !== `/machines/${known.id}`) return answer({ error: "A machine removes only itself." }, 403);
    await forget(env, known, send);
    return new Response(null, { status: 204 });
  }

  const { token, environment, app, sealed, messageId, ended, read } = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  const topics = env.APNS_TOPICS.split(" ");
  // A notice is an encrypted notification with the message it is about, word that something was read, or the end of a Live Activity.
  const notice = typeof sealed === "string" && SEALED.test(sealed) && typeof messageId === "string" && MESSAGE_ID.test(messageId) ? { sealed, messageId } : null;
  const end = ENDED.includes(ended as Ended) ? (ended as Ended) : null;
  if (
    (app !== undefined && !topics.includes(app as string)) ||
    typeof token !== "string" ||
    !DEVICE_TOKEN.test(token) ||
    (environment !== "sandbox" && environment !== "production") ||
    (read !== undefined ? read !== true : ended === undefined ? !notice : !end)
  ) {
    return answer(
      {
        error:
          "A notice comes with the phone's token, its push service, and one of the relay's apps if it names one. It is encrypted, with the message it is about, or it says that something was read, or it ends a Live Activity on one of the avatar's states.",
      },
      400,
    );
  }
  const day = Math.floor(now / DAY_MS);
  const { sent } = (await env.DB.prepare(
    "update machines set seen_at = ?1, sent_count = case when sent_day = ?2 then sent_count + 1 else 1 end, sent_day = ?2 where id = ?3 returning sent_count as sent",
  )
    .bind(now, day, machine)
    .first<{ sent: number }>())!;
  if (sent > Number(env.NOTICES_PER_DAY)) return answer({ error: "This machine has sent all the notifications it may today." }, 429);

  const push: PushKey = { key: env.APNS_KEY, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID };
  const topic = (app as string | undefined) ?? topics[0];
  const to = { token, environment } as const;
  return answer({ result: await (read ? tellRead(push, topic, to, send, now) : end ? endActivity(push, topic, to, end, send, now) : notify(push, topic, to, notice!, send, now)) });
}

/** Removes the machines that have been quiet for 60 days, with their tunnels and addresses. One that Cloudflare fails to remove stays for the next day's run. */
export async function removeStale(env: Env, send: typeof fetch = fetch, now = Date.now()): Promise<void> {
  const { results } = await env.DB.prepare("select id, tunnel_id from machines where seen_at < ?").bind(now - STALE_MS).all<{ id: string; tunnel_id: string | null }>();
  for (const machine of results) await forget(env, machine, send).catch((failure) => console.error(failure));
}

/** Says in the relay's log how full the zone and the account are, so their owner sees a limit coming. */
export async function logRoom(env: Env, send: typeof fetch = fetch): Promise<void> {
  console.log((await roomOf(env, send)).said);
}

export default {
  fetch: (request, env) => handle(request, env),
  scheduled: async (_controller, env) => {
    await removeStale(env);
    await logRoom(env);
  },
} satisfies ExportedHandler<Env>;
