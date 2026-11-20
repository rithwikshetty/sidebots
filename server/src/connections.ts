// The apps outside Sidebots that a person's agents use as them. Each app's
// maker runs a server that gives its tools, as MCP. This module signs the
// person in to each, and hands a turn the servers they are signed in to, each
// with a token. The provider the turn runs on does the rest: it reads a
// server's tools and uses them.

import { createHash, randomBytes } from "node:crypto";
import { CONNECTIONS, type Connected, type Connection, type SignIn } from "./contract.ts";
import type { Store } from "./store.ts";

/** What a maker's token address answers when it grants: a token that works for `expires_in` seconds, the one that outlasts it, what they let their holder do, and who signed in. */
type Granted = { access_token: string; expires_in: number; refresh_token?: string; scope?: string; id_token?: string };
type Refused = { error: string; error_description?: string };

/**
 * The tool servers of the connections a person has made, by connection: each
 * with its address and a token that asks it as the person.
 */
export type Servers = Partial<Record<Connection, { url: string; token: string }>>;

const NOTION = "https://mcp.notion.com/mcp";

/**
 * How a person signs in with an app's maker: OAuth's authorization code flow
 * with PKCE, which is how an app that can keep no secret signs in.
 * `authorize` is the maker's page the person signs in on, `asks` is what that
 * page takes besides what OAuth names, and `token` is where the code the page
 * hands back is swapped for tokens. `scopes` go with every sign-in.
 * `resource` is the server the tokens are for, when the maker is told it with
 * every request. `account` reads who signed in from what was granted, when
 * the maker says. `redirect` is the address the page goes to once the person
 * has signed in, for the client id Sidebots signs in with.
 */
type SignInWith = {
  name: string;
  authorize: string;
  asks: Record<string, string>;
  token: string;
  scopes: string[];
  resource?: string;
  account(granted: Granted): string | undefined;
  redirect(client: string): string;
};

/** The makers of the apps. */
const MAKERS: Record<"google" | "notion", SignInWith> = {
  google: {
    name: "Google",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    // Offline access has Google grant a token that lasts, and asking for consent has it grant one at every sign-in, not only the first.
    asks: { access_type: "offline", prompt: "consent" },
    token: "https://oauth2.googleapis.com/token",
    // These have Google say who signed in.
    scopes: ["openid", "email"],
    // The id token names the account. It comes straight from Google, so there is no signature to check.
    account: (granted) => (JSON.parse(Buffer.from(granted.id_token?.split(".")[1] ?? "", "base64url").toString() || "{}") as { email?: string }).email,
    // Google's address for the client of an iOS app: the client id, turned about.
    redirect: (client) => `${client.split(".").reverse().join(".")}:/oauth2redirect`,
  },
  notion: {
    name: "Notion",
    authorize: "https://mcp.notion.com/authorize",
    asks: {},
    token: "https://mcp.notion.com/token",
    scopes: ["default"],
    resource: NOTION,
    account: () => undefined,
    // Notion reads the client from a file, whose address is the client id, and the file lists this address. It is no one app's: the sheet iOS signs in with hands it to the app that opened it.
    redirect: () => "app.sidebots:/oauth2redirect",
  },
};
type Maker = keyof typeof MAKERS;

const GOOGLE = "https://www.googleapis.com/auth";

/**
 * What Sidebots knows of each connection: whose app it is, what its sign-in
 * asks that maker to allow, and where the maker serves its tools.
 */
const APPS: Record<Connection, { maker: Maker; scopes: string[]; server: string }> = {
  gmail: { maker: "google", scopes: [`${GOOGLE}/gmail.readonly`, `${GOOGLE}/gmail.compose`, `${GOOGLE}/gmail.modify`], server: "https://gmailmcp.googleapis.com/mcp/v1" },
  calendar: {
    maker: "google",
    scopes: [`${GOOGLE}/calendar.calendarlist.readonly`, `${GOOGLE}/calendar.events.freebusy`, `${GOOGLE}/calendar.events.readonly`, `${GOOGLE}/calendar.events`],
    server: "https://calendarmcp.googleapis.com/mcp/v1",
  },
  notion: { maker: "notion", scopes: [], server: NOTION },
};

// How long a sign-in a phone started stays open.
const SIGN_IN_MS = 10 * 60_000;
// A token goes to a turn for as long as the turn runs, so one with less than this left is replaced.
const TURN_MS = 30 * 60_000;

/**
 * A person's connections. `clients` holds the client id Sidebots signs in to
 * each maker with, and a maker with none can't be signed in to. A phone
 * starts a sign-in, opens its page, and brings back the address the page
 * ended on, which carries a code that works once. `finish` swaps the code for
 * the maker's tokens and keeps the one that lasts. From then on every turn of
 * the person's agents is handed the connection's server.
 */
export function createConnections(store: Store, clients: Partial<Record<Maker, string>>, request: typeof fetch = fetch, now: () => number = Date.now) {
  // The sign-ins that phones have started and not finished, by the `state` each sent the maker's page off with.
  const signIns = new Map<string, { personId: string; connection: Connection; verifier: string; until: number }>();
  // The token each connection's server is asked with, until it runs out, and the next one while its maker is asked for it.
  const tokens = new Map<string, { token: string; until: number }>();
  const renewals = new Map<string, Promise<string>>();
  const key = (personId: string, connection: Connection) => `${personId} ${connection}`;

  /** Asks a maker for tokens. */
  const grant = async (maker: Maker, fields: Record<string, string>): Promise<Granted | Refused> => {
    const { token, resource } = MAKERS[maker];
    return (await request(token, { method: "POST", body: new URLSearchParams({ client_id: clients[maker] ?? "", ...(resource && { resource }), ...fields }) })).json() as Promise<Granted | Refused>;
  };

  const listed = (personId: string, connection: Connection): Connected => ({ connection, ...CONNECTIONS[connection], account: store.connection(personId, connection)?.account ?? null });

  const hold = (personId: string, connection: Connection, granted: Granted) => {
    tokens.set(key(personId, connection), { token: granted.access_token, until: now() + granted.expires_in * 1000 - TURN_MS });
    return granted.access_token;
  };

  /** The token a connection's server is asked with, while it lasts. */
  const inHand = (personId: string, connection: Connection) => {
    const held = tokens.get(key(personId, connection));
    return held && held.until > now() ? held.token : undefined;
  };

  /** A new token for a connection, from its maker. It fails when the connection isn't made, and when the maker won't renew it. */
  async function renewed(personId: string, connection: Connection): Promise<string> {
    const { name } = CONNECTIONS[connection];
    const kept = store.connection(personId, connection);
    if (!kept) throw new Error(`${name} isn't connected.`);
    const maker = APPS[connection].maker;
    const granted = await grant(maker, { grant_type: "refresh_token", refresh_token: kept.token });
    // The person may have removed the connection, or made it again, while the maker answered. What it said is then of a sign-in that is gone.
    if (store.connection(personId, connection)?.token !== kept.token) return inHand(personId, connection) ?? renewed(personId, connection);
    if (!("error" in granted)) {
      // A maker may answer with a new token that lasts, which ends the one before it.
      if (granted.refresh_token && granted.refresh_token !== kept.token) store.setConnection(personId, connection, { ...kept, token: granted.refresh_token });
      return hold(personId, connection, granted);
    }
    if (granted.error !== "invalid_grant") throw new Error(`${MAKERS[maker].name} wouldn't renew the sign-in to ${name}: ${granted.error_description ?? granted.error}`);
    // The person took the connection back at the maker's, or the maker ended it.
    store.setConnection(personId, connection, null);
    tokens.delete(key(personId, connection));
    throw new Error(`${name} is no longer connected.`);
  }

  /** A token to ask a connection's server with as the person: the one in hand, or a new one from the maker once that has run out. */
  function token(personId: string, connection: Connection): Promise<string> {
    const held = inHand(personId, connection);
    if (held && store.connection(personId, connection)) return Promise.resolve(held);
    // Turns that start at once wait for one new token between them, since a maker may end the token that lasts as it answers with the next.
    const renewal = renewals.get(key(personId, connection)) ?? renewed(personId, connection).finally(() => renewals.delete(key(personId, connection)));
    renewals.set(key(personId, connection), renewal);
    return renewal;
  }

  return {
    /** Every connection, each with the account the person connected it as. */
    list(personId: string): Connected[] {
      return (Object.keys(CONNECTIONS) as Connection[]).map((connection) => listed(personId, connection));
    },

    /** The account the person signed in to a connection with, or null while it isn't connected. */
    account(personId: string, connection: Connection): string | null {
      return listed(personId, connection).account;
    },

    /** Starts the person's sign-in to a connection, and answers where a phone opens it. It fails in words for the person. */
    signIn(personId: string, connection: Connection): SignIn {
      const { maker, scopes } = APPS[connection];
      const { name, authorize, asks, redirect, scopes: who, resource } = MAKERS[maker];
      const client = clients[maker];
      if (!client) throw new Error(`Sidebots on your computer isn't set up to sign in to ${name}.`);
      for (const [state, signIn] of signIns) if (signIn.until <= now()) signIns.delete(state);
      const [state, verifier] = [randomBytes(16).toString("base64url"), randomBytes(32).toString("base64url")];
      signIns.set(state, { personId, connection, verifier, until: now() + SIGN_IN_MS });
      const asked = {
        ...asks,
        ...(resource && { resource }),
        client_id: client,
        redirect_uri: redirect(client),
        response_type: "code",
        scope: [...who, ...scopes].join(" "),
        state,
        // The maker hands tokens only to whoever holds what this is the hash of, so a code read off the phone is no use to anyone else.
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      };
      return { url: `${authorize}?${new URLSearchParams(asked)}`, redirect: redirect(client) };
    },

    /**
     * Makes a connection from the address a sign-in's page ended on, `url`,
     * and keeps it for all the person's agents. It fails in words for the
     * person: when the sign-in is not one they started in the last ten
     * minutes, when the maker didn't sign them in, and when they allowed less
     * than the connection needs.
     */
    async finish(personId: string, connection: Connection, url: string): Promise<Connected> {
      const { maker, scopes } = APPS[connection];
      const { name } = MAKERS[maker];
      const back = URL.parse(url)?.searchParams;
      const state = back?.get("state") ?? "";
      const signIn = signIns.get(state);
      signIns.delete(state);
      if (!signIn || signIn.personId !== personId || signIn.connection !== connection || signIn.until <= now()) throw new Error("That sign-in has run out. Start it again.");
      const code = back?.get("code");
      const granted = code ? await grant(maker, { grant_type: "authorization_code", code, redirect_uri: MAKERS[maker].redirect(clients[maker] ?? ""), code_verifier: signIn.verifier }) : undefined;
      if (!granted || "error" in granted) throw new Error(`${name} didn't sign you in${granted ? `: ${granted.error_description ?? granted.error}` : "."}`);
      // A person can untick part of what a sign-in asks for.
      const allowed = new Set(granted.scope?.split(" "));
      if (!granted.refresh_token || scopes.some((scope) => !allowed.has(scope))) {
        throw new Error(`${name} didn't allow everything ${CONNECTIONS[connection].name} needs. Connect it again, and allow all it asks for.`);
      }
      // A maker that doesn't say who signed in leaves its own name as the account.
      store.setConnection(personId, connection, { account: MAKERS[maker].account(granted) ?? name, token: granted.refresh_token });
      hold(personId, connection, granted);
      return listed(personId, connection);
    },

    /** Forgets a connection the person made, so no agent of theirs can use it. */
    remove(personId: string, connection: Connection): void {
      store.setConnection(personId, connection, null);
      tokens.delete(key(personId, connection));
    },

    /**
     * The tool servers of the connections the person has made, each with a
     * token that lasts a turn. One whose maker won't renew its sign-in, or
     * can't be reached, is left out.
     */
    async servers(personId: string): Promise<Servers> {
      const made = (Object.keys(APPS) as Connection[]).filter((connection) => store.connection(personId, connection));
      const each = await Promise.all(made.map(async (connection) => token(personId, connection).then((held) => [[connection, { url: APPS[connection].server, token: held }]] as const, () => [])));
      return Object.fromEntries(each.flat());
    },
  };
}

export type Connections = ReturnType<typeof createConnections>;
