// The apps outside Sidebots that a person's agents use as them: how the person
// signs in to each, and the tools it gives their agents. It is the only
// module that talks to those apps.

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { CONNECTIONS, type Connected, type Connection, type SignIn } from "./contract.ts";
import type { Store } from "./store.ts";

/** What a maker's token address answers when it grants: a token that works for `expires_in` seconds, the one that outlasts it, what they let their holder do, and who signed in. */
type Granted = { access_token: string; expires_in: number; refresh_token?: string; scope?: string; id_token?: string };
type Refused = { error: string; error_description?: string };

/**
 * The makers of the apps, and how a person signs in with each: OAuth's
 * authorization code flow with PKCE, which is how an app that can keep no
 * secret signs in. `authorize` is the maker's page the person signs in on,
 * `asks` is what that page takes besides what OAuth names, and `token` is
 * where the code the page hands back is swapped for tokens. `scopes` go with
 * every sign-in, to learn who signed in, which `account` reads from what was
 * granted. `redirect` is the address the page goes to once the person has
 * signed in, for the client id the maker gave Sidebots.
 */
const MAKERS = {
  google: {
    name: "Google",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    // Offline access has Google grant a token that lasts, and asking for consent has it grant one at every sign-in, not only the first.
    asks: { access_type: "offline", prompt: "consent" },
    token: "https://oauth2.googleapis.com/token",
    scopes: ["openid", "email"],
    // The id token names the account. It comes straight from Google, so there is no signature to check.
    account: (granted: Granted) => (JSON.parse(Buffer.from(granted.id_token?.split(".")[1] ?? "", "base64url").toString() || "{}") as { email?: string }).email,
    // Google's address for the client of an iOS app: the client id, turned about.
    redirect: (client: string) => `${client.split(".").reverse().join(".")}:/oauth2redirect`,
  },
};
type Maker = keyof typeof MAKERS;

/** Something a tool can't do, in words the agent reads. */
class Told extends Error {}

/** Asks an app something as the person, and answers what the app said. */
type Call = <Said>(url: string, request?: { method?: string; body?: unknown }) => Promise<Said>;

/**
 * A tool an app gives the agents: its name, what the agent is told it does,
 * what it takes, and what it does through `call`, in words the agent reads. A
 * tool that is `checked` acts as the person: it changes something in the app
 * or speaks as them, as sending a mail does.
 */
type AppTool<Input extends z.ZodRawShape = z.ZodRawShape> = {
  name: string;
  description: string;
  checked?: "acts";
  input: Input;
  run(input: z.infer<z.ZodObject<Input>>, call: Call): Promise<string>;
};
const define = <Input extends z.ZodRawShape>(tool: AppTool<Input>): AppTool => tool as AppTool;

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
// The most of a mail's words an agent is given.
const MAIL_CHARS = 40_000;
type Part = { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string }; parts?: Part[] };
type Mail = { id: string; threadId: string; labelIds?: string[]; snippet?: string; payload?: Part };

const header = (mail: Mail, name: string) => mail.payload?.headers?.find((each) => each.name.toLowerCase() === name.toLowerCase())?.value ?? "";
/** The headers a mail has among `names`, a line each. */
const headers = (mail: Mail, names: string[]) => names.flatMap((name) => (header(mail, name) ? [`${name}: ${header(mail, name)}`] : []));
const everyPart = (part: Part): Part[] => [part, ...(part.parts ?? []).flatMap(everyPart)];
/** Text with HTML's names for characters as the characters. */
const unescaped = (text: string) =>
  text.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
/** A page of HTML as the words on it. */
const wordsOn = (html: string) =>
  unescaped(
    html
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
/** What a mail says: its plain text when it has some, and otherwise its HTML as words. */
function mailWords(mail: Mail): string {
  const parts = everyPart(mail.payload ?? {}).filter((part) => !part.filename && part.body?.data);
  const read = (type: string) => parts.filter((part) => part.mimeType === type).map((part) => Buffer.from(part.body!.data!, "base64url").toString().trim()).find(Boolean);
  const page = read("text/html");
  const words = read("text/plain") ?? (page ? wordsOn(page) : "");
  return words.length > MAIL_CHARS ? `${words.slice(0, MAIL_CHARS)}\n\nThe mail goes on past here.` : words;
}
/** A value as one line of a mail's header. */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
/** A subject as a mail's header carries it: as it is in ASCII, and encoded otherwise. */
const subjectLine = (subject: string) => (/^[\x20-\x7e]*$/.test(oneLine(subject)) ? oneLine(subject) : `=?UTF-8?B?${Buffer.from(oneLine(subject)).toString("base64")}?=`);

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
// The most events one look at the calendar answers with, and the most of an event's notes.
const EVENTS_MOST = 50;
const NOTES_CHARS = 300;
type Moment = { date?: string; dateTime?: string };
type Event = {
  id: string;
  summary?: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  start?: Moment;
  end?: Moment;
  attendees?: { email: string; responseStatus?: string }[];
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A time as an agent writes one, as an instant. A time with no zone is this machine's own. */
function instant(time: string, name: string): string {
  const at = new Date(time);
  if (Number.isNaN(at.getTime())) throw new Told(`${name} must be a time such as 2026-11-16T17:00.`);
  return at.toISOString();
}
/** When an event starts or ends, as Google takes it: a day alone for an event that takes whole days, and otherwise an instant. Naming the other as null changes an event from one to the other. */
const moment = (time: string, name: string) => (DAY.test(time) ? { date: time, dateTime: null } : { date: null, dateTime: instant(time, name) });
/** An event as Google takes one, from the parts of it an agent gave. */
const eventOf = ({ title, start, end, place, notes, guests }: { title?: string; start?: string; end?: string; place?: string; notes?: string; guests?: string[] }) => ({
  ...(title !== undefined && { summary: title }),
  ...(start !== undefined && { start: moment(start, "start") }),
  ...(end !== undefined && { end: moment(end, "end") }),
  ...(place !== undefined && { location: place }),
  ...(notes !== undefined && { description: notes }),
  ...(guests !== undefined && { attendees: guests.map((email) => ({ email })) }),
});
/** An event as an agent reads it. */
const eventLines = (event: Event) =>
  [
    `id ${event.id}`,
    event.summary ?? "(No title)",
    `${event.start?.dateTime ?? event.start?.date} to ${event.end?.dateTime ?? event.end?.date}`,
    event.location && `At ${event.location}`,
    event.attendees?.length && `With ${event.attendees.map((guest) => `${guest.email} (${guest.responseStatus ?? "needsAction"})`).join(", ")}`,
    event.description && (event.description.length > NOTES_CHARS ? `${event.description.slice(0, NOTES_CHARS - 1)}…` : event.description),
  ]
    .filter(Boolean)
    .join("\n");

const EVENT_PARTS = {
  place: z.string().optional().describe("Where it is"),
  notes: z.string().optional().describe("What the event says about itself"),
  guests: z.array(z.string()).optional().describe("Who is invited, each an email address. Google mails each of them the invitation."),
};
const WHEN = "as YYYY-MM-DDTHH:MM by this machine's clock, or as YYYY-MM-DD for an event that takes whole days";

/**
 * What Sidebots knows of each connection: whose app it is, what its sign-in
 * asks that maker to allow, and the tools it gives the agents.
 */
const APPS: Record<Connection, { maker: Maker; scopes: string[]; tools: AppTool[] }> = {
  gmail: {
    maker: "google",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
    tools: [
      define({
        name: "gmail_search",
        description: "Search the person's Gmail. Answers the mail that matches, newest first, each with its id, who it is from, its subject, its date and how it starts. Read one in full with gmail_read.",
        input: {
          query: z.string().describe("What to look for, in the words Gmail's own search takes, such as `from:anna newer_than:7d`, `is:unread` or `subject:invoice`"),
          most: z.number().optional().describe("How many to answer at most, up to 25. 10 when left out."),
        },
        run: async ({ query, most = 10 }, call) => {
          const { messages = [] } = await call<{ messages?: { id: string }[] }>(`${GMAIL}/messages?${new URLSearchParams({ q: query, maxResults: String(Math.min(Math.max(Math.trunc(most), 1), 25)) })}`);
          const found = await Promise.all(messages.map(({ id }) => call<Mail>(`${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
          return (
            found
              .map((mail) => [`id ${mail.id}${mail.labelIds?.includes("UNREAD") ? ", unread" : ""}`, ...headers(mail, ["From", "Subject", "Date"]), unescaped(mail.snippet ?? "")].join("\n"))
              .join("\n\n") || "No mail matches."
          );
        },
      }),
      define({
        name: "gmail_read",
        description: "Read one mail in the person's Gmail in full: who it is from and to, its subject, its date, what it says and the names of the files sent with it.",
        input: { id: z.string().describe("The mail's id, as gmail_search gives it") },
        run: async ({ id }, call) => {
          const mail = await call<Mail>(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
          const files = everyPart(mail.payload ?? {}).flatMap((part) => (part.filename ? [part.filename] : []));
          return [...headers(mail, ["From", "To", "Cc", "Subject", "Date"]), ...(files.length ? [`Files: ${files.join(", ")}`] : []), "", mailWords(mail)].join("\n");
        },
      }),
      define({
        name: "gmail_send",
        description: "Send a mail from the person's Gmail, as them. Use it only for a mail the person asked for, to the people they named.",
        checked: "acts",
        input: {
          to: z.array(z.string()).describe("Who it goes to, each an email address"),
          subject: z.string().optional().describe("The mail's subject. Leave it out of an answer, which takes the subject of the mail it answers."),
          body: z.string().describe("What the mail says, as plain text"),
          cc: z.array(z.string()).optional().describe("Who gets a copy, each an email address"),
          answers: z.string().optional().describe("The id of the mail this one answers, as gmail_search gives it. The mail then joins that one's thread."),
        },
        run: async ({ to, subject, body, cc = [], answers }, call) => {
          if (to.length === 0) throw new Told("Say who the mail goes to.");
          const answered = answers ? await call<Mail>(`${GMAIL}/messages/${encodeURIComponent(answers)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`) : undefined;
          const id = answered && header(answered, "Message-ID");
          // Gmail keeps an answer in a thread only under the subject of the mail it answers.
          const about = answered ? header(answered, "Subject").replace(/^(?!re:)/i, "Re: ") : subject;
          if (!about) throw new Told("Say the mail's subject.");
          const head = [
            `To: ${to.map(oneLine).join(", ")}`,
            ...(cc.length ? [`Cc: ${cc.map(oneLine).join(", ")}`] : []),
            `Subject: ${subjectLine(about)}`,
            ...(id ? [`In-Reply-To: ${id}`, `References: ${[header(answered, "References"), id].filter(Boolean).join(" ")}`] : []),
            "MIME-Version: 1.0",
            "Content-Type: text/plain; charset=utf-8",
            "Content-Transfer-Encoding: base64",
          ];
          const raw = `${head.join("\r\n")}\r\n\r\n${Buffer.from(body).toString("base64").replace(/.{76}/g, "$&\r\n")}`;
          await call(`${GMAIL}/messages/send`, { method: "POST", body: { raw: Buffer.from(raw).toString("base64url"), ...(answered && { threadId: answered.threadId }) } });
          return `Sent to ${[...to, ...cc].map(oneLine).join(", ")}.`;
        },
      }),
    ],
  },
  calendar: {
    maker: "google",
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    tools: [
      define({
        name: "calendar_events",
        description: "Look at the person's Google Calendar: the events between two times, earliest first, each with its id, its title, when it starts and ends, where it is and who is invited.",
        input: {
          from: z.string().describe("The start of the time to look in, as YYYY-MM-DDTHH:MM by this machine's clock"),
          to: z.string().describe("The end of the time to look in, written the same way"),
          text: z.string().optional().describe("Words the events have in them"),
        },
        run: async ({ from, to, text }, call) => {
          const asked = { timeMin: instant(from, "from"), timeMax: instant(to, "to"), singleEvents: "true", orderBy: "startTime", maxResults: String(EVENTS_MOST), ...(text && { q: text }) };
          const { items = [], nextPageToken } = await call<{ items?: Event[]; nextPageToken?: string }>(`${EVENTS}?${new URLSearchParams(asked)}`);
          const more = nextPageToken ? `\n\nThe calendar has more then than these ${EVENTS_MOST}. Look in a shorter time for the rest.` : "";
          return `${items.map(eventLines).join("\n\n") || "The calendar has nothing then."}${more}`;
        },
      }),
      define({
        name: "calendar_add_event",
        description: "Add an event to the person's Google Calendar.",
        checked: "acts",
        input: {
          title: z.string().describe("What the event is called"),
          start: z.string().describe(`When it starts, ${WHEN}`),
          end: z.string().describe("When it ends, written the same way. An event that takes whole days ends on the day after its last."),
          ...EVENT_PARTS,
        },
        run: async (event, call) => {
          const added = await call<Event>(`${EVENTS}?sendUpdates=all`, { method: "POST", body: eventOf(event) });
          return `Added, as event ${added.id}: ${added.htmlLink}`;
        },
      }),
      define({
        name: "calendar_change_event",
        description: "Change an event in the person's Google Calendar. Give only what changes. Google mails the event's guests the change.",
        checked: "acts",
        input: {
          id: z.string().describe("The event's id, as calendar_events gives it"),
          title: z.string().optional().describe("What the event is called"),
          start: z.string().optional().describe(`When it starts, ${WHEN}`),
          end: z.string().optional().describe("When it ends, written the same way"),
          ...EVENT_PARTS,
        },
        run: async ({ id, ...changes }, call) => eventLines(await call<Event>(`${EVENTS}/${encodeURIComponent(id)}?sendUpdates=all`, { method: "PATCH", body: eventOf(changes) })),
      }),
      define({
        name: "calendar_remove_event",
        description: "Remove an event from the person's Google Calendar. Google mails its guests that it is off.",
        checked: "acts",
        input: { id: z.string().describe("The event's id, as calendar_events gives it") },
        run: async ({ id }, call) => {
          await call(`${EVENTS}/${encodeURIComponent(id)}?sendUpdates=all`, { method: "DELETE" });
          return "Removed.";
        },
      }),
    ],
  },
};

/** Every connection's tools, each with the connection it is of. */
export const CONNECTION_TOOLS = (Object.keys(APPS) as Connection[]).flatMap((connection) => APPS[connection].tools.map((tool) => ({ ...tool, connection })));

// How long a sign-in a phone started stays open.
const SIGN_IN_MS = 10 * 60_000;
// How long before a token runs out it is replaced.
const EARLY_MS = 60_000;

/**
 * A person's connections. `clients` holds the client id each maker gave this
 * Sidebots, and a maker with none can't be signed in to. A phone starts a
 * sign-in, opens its page, and brings back the address the page ended on,
 * which carries a code that works once. `finish` swaps the code for the
 * maker's tokens and keeps the one that lasts. From then on every agent of
 * the person's can `use` the connection's tools.
 */
export function createConnections(store: Store, clients: Partial<Record<Maker, string>>, request: typeof fetch = fetch, now: () => number = Date.now) {
  // The sign-ins that phones have started and not finished, by the `state` each sent the maker's page off with.
  const signIns = new Map<string, { personId: string; connection: Connection; verifier: string; until: number }>();
  // The token each connection is asking its app with, until it runs out.
  const tokens = new Map<string, { token: string; until: number }>();
  const key = (personId: string, connection: Connection) => `${personId} ${connection}`;

  /** Asks a maker for tokens. */
  const grant = async (maker: Maker, fields: Record<string, string>): Promise<Granted | Refused> =>
    (await request(MAKERS[maker].token, { method: "POST", body: new URLSearchParams({ client_id: clients[maker] ?? "", ...fields }) })).json() as Promise<Granted | Refused>;

  const listed = (personId: string, connection: Connection): Connected => ({ connection, ...CONNECTIONS[connection], account: store.connection(personId, connection)?.account ?? null });

  const hold = (personId: string, connection: Connection, granted: Granted) => {
    tokens.set(key(personId, connection), { token: granted.access_token, until: now() + granted.expires_in * 1000 - EARLY_MS });
    return granted.access_token;
  };

  /** A token to ask a connection's app with as the person: the one in hand, or a new one from the maker once that has run out. */
  async function token(personId: string, connection: Connection): Promise<string> {
    const { name } = CONNECTIONS[connection];
    const connect = `Call \`connect\` with \`${connection}\`, which asks the person to sign in to it.`;
    const kept = store.connection(personId, connection);
    if (!kept) throw new Told(`${name} isn't connected. ${connect}`);
    const held = tokens.get(key(personId, connection));
    if (held && held.until > now()) return held.token;
    const maker = APPS[connection].maker;
    const granted = await grant(maker, { grant_type: "refresh_token", refresh_token: kept.token });
    // The person may have removed the connection, or made it again, while the maker answered. What it said is then of a sign-in that is gone.
    if (store.connection(personId, connection)?.token !== kept.token) return token(personId, connection);
    if (!("error" in granted)) return hold(personId, connection, granted);
    if (granted.error !== "invalid_grant") throw new Told(`${MAKERS[maker].name} wouldn't renew the sign-in to ${name}: ${granted.error_description ?? granted.error}`);
    // The person took the connection back at the maker's, or the maker ended it.
    store.setConnection(personId, connection, null);
    tokens.delete(key(personId, connection));
    throw new Told(`${name} is no longer connected. ${connect}`);
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
      const { name, authorize, asks, redirect, scopes: who } = MAKERS[maker];
      const client = clients[maker];
      if (!client) throw new Error(`Sidebots on your computer isn't set up to sign in to ${name}.`);
      for (const [state, signIn] of signIns) if (signIn.until <= now()) signIns.delete(state);
      const [state, verifier] = [randomBytes(16).toString("base64url"), randomBytes(32).toString("base64url")];
      signIns.set(state, { personId, connection, verifier, until: now() + SIGN_IN_MS });
      const asked = {
        ...asks,
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
      store.setConnection(personId, connection, { account: MAKERS[maker].account(granted) ?? name, token: granted.refresh_token });
      hold(personId, connection, granted);
      return listed(personId, connection);
    },

    /** Forgets a connection the person made, so no agent of theirs can use it. */
    remove(personId: string, connection: Connection): void {
      store.setConnection(personId, connection, null);
      tokens.delete(key(personId, connection));
    },

    /** Uses a tool of one of the person's connections as them. Answers in words the agent reads, also when the connection isn't made or its app refuses. */
    async use(personId: string, toolName: string, input: unknown): Promise<string> {
      const tool = CONNECTION_TOOLS.find((each) => each.name === toolName);
      if (!tool) return `You have no tool called ${toolName}.`;
      const { name } = CONNECTIONS[tool.connection];
      try {
        const held = await token(personId, tool.connection);
        const call: Call = async <Said>(url: string, { method = "GET", body }: { method?: string; body?: unknown } = {}) => {
          const response = await request(url, {
            method,
            headers: { Authorization: `Bearer ${held}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          // An app answers some things, such as a removal, with nothing.
          const answered = (await response.json().catch(() => ({}))) as Said & { error?: { message?: string } };
          if (!response.ok) throw new Told(`${name} refused that: ${answered.error?.message ?? response.statusText}`);
          return answered;
        };
        return await tool.run(input as never, call);
      } catch (error) {
        return error instanceof Told ? error.message : `${name} couldn't be reached: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

export type Connections = ReturnType<typeof createConnections>;
