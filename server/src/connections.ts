// The apps outside Sidebots that a person's agents use as them: how the person
// signs in to each, and the tools it gives their agents. An app whose maker
// runs a server that gives its tools, as MCP, has no tools here: a turn is
// handed the server with a token, and the provider it runs on reads the
// server's tools and uses them. For the rest, this is the only module that
// talks to the app.

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { CONNECTIONS, type Connected, type Connection, type SignIn } from "./contract.ts";
import type { Store } from "./store.ts";

/** What a maker's token address answers when it grants: a token that works for `expires_in` seconds, the one that outlasts it, what they let their holder do, and who signed in: to Google, in `id_token`, and to Notion, the workspace they chose. */
type Granted = { access_token: string; expires_in: number; refresh_token?: string; scope?: string; id_token?: string; workspace_name?: string };
type Refused = { error: string; error_description?: string };

/**
 * The tool servers of the connections a person has made whose makers run one,
 * by connection: each with its address and a token that asks it as the person.
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
    // Notion names the workspace the person signed in to, and not the person.
    account: (granted) => granted.workspace_name,
    // Notion reads the client from a file, whose address is the client id, and the file lists this address. It is no one app's: the sheet iOS signs in with hands it to the app that opened it.
    redirect: () => "app.sidebots:/oauth2redirect",
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
      // A link keeps the address it goes to, and the cells of a row stay apart.
      .replace(/<a(?=\s)[^>]*?\shref=(?:"(https?:[^"]+)"|'(https?:[^']+)')[^>]*>([\s\S]*?)<\/a>/gi, (_, double: string | undefined, single: string | undefined, text: string) => `${text} (${double ?? single})`)
      .replace(/<\/t[dh]>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
/** What a mail says: its plain text when it has some, and otherwise its HTML as words. */
function mailWords(mail: Mail): string {
  const parts = everyPart(mail.payload ?? {}).filter((part) => !part.filename && part.body?.data);
  // A mail can say what it says in several parts, as one does with a picture set between its paragraphs.
  const read = (type: string) => parts.filter((part) => part.mimeType === type).map((part) => Buffer.from(part.body!.data!, "base64url").toString().trim()).filter(Boolean).join("\n\n") || undefined;
  const page = read("text/html");
  const words = read("text/plain") ?? (page ? wordsOn(page) : "");
  return words.length > MAIL_CHARS ? `${words.slice(0, MAIL_CHARS)}\n\nThe mail goes on past here.` : words;
}
/** A search with each day it looks before or after as the instant that day starts by this machine's clock. Gmail reads a day alone as one that starts at midnight in California. */
const byThisClock = (query: string) =>
  query.replace(/\b(after|before|newer|older):(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/gi, (_, word: string, year: string, month: string, day: string) => `${word}:${Math.floor(new Date(Number(year), Number(month) - 1, Number(day)).getTime() / 1000)}`);
/** A value as one line of a mail's header. */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
/** A subject as a mail's header carries it: as it is in ASCII, and encoded otherwise. */
const subjectLine = (subject: string) => (/^[\x20-\x7e]*$/.test(oneLine(subject)) ? oneLine(subject) : `=?UTF-8?B?${Buffer.from(oneLine(subject)).toString("base64")}?=`);

const CALENDAR = "https://www.googleapis.com/calendar/v3";
// The most events one look at the calendars answers, and asks Google for of each calendar, and the most of an event's notes.
const EVENTS_MOST = 50;
const NOTES_CHARS = 300;
/** A calendar in the person's list in Google Calendar: their own, which is `primary`, and each one they made, follow or were shared. `selected` is whether they have it ticked there, `summaryOverride` is the name they gave it, and `accessRole` is what they may do with its events. */
type Calendar = { id: string; summary?: string; summaryOverride?: string; primary?: boolean; selected?: boolean; accessRole?: string };
const nameOf = (calendar: Calendar) => calendar.summaryOverride ?? calendar.summary ?? "(No name)";
/** Whether the person can read a calendar's events and not change them, as with one they follow. */
const readOnly = (calendar: Calendar) => calendar.accessRole === "reader" || calendar.accessRole === "freeBusyReader";
/** The person's own calendar, by the name Google has for it whoever asks. */
const OWN: Calendar = { id: "primary", primary: true };
/** The person's calendars in Google Calendar, ticked or not. */
const calendarsOf = async (call: Call) => (await call<{ items?: Calendar[] }>(`${CALENDAR}/users/me/calendarList?maxResults=250`)).items ?? [];
/** The calendar an agent named, by its id or by its name when one calendar has it. With none named it is the person's own. */
async function calendarNamed(call: Call, named?: string): Promise<Calendar> {
  const wanted = named?.trim();
  if (!wanted || wanted === OWN.id) return OWN;
  const calendars = await calendarsOf(call);
  const called = calendars.filter((calendar) => nameOf(calendar).toLowerCase() === wanted.toLowerCase());
  const found = calendars.find((calendar) => calendar.id === wanted) ?? (called.length === 1 ? called[0] : undefined);
  if (!found) throw new Told(`The person has no one calendar called ${wanted}. Their calendars: ${calendars.map((calendar) => `${nameOf(calendar)} (id ${calendar.id})`).join(", ")}.`);
  return found;
}
/** Where Google keeps a calendar's events. */
const eventsOf = (calendar: Calendar) => `${CALENDAR}/calendars/${encodeURIComponent(calendar.id)}/events`;
/** The zone of this machine's clock, which Google is asked to answer an event's times in. */
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
type Moment = { date?: string; dateTime?: string };
type Event = {
  id: string;
  // The same for every calendar's copy of an event, and for every time of one that repeats.
  iCalUID?: string;
  summary?: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  recurringEventId?: string;
  start?: Moment;
  end?: Moment;
  attendees?: { email: string; responseStatus?: string; self?: boolean }[];
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A time as an agent writes one, as an instant. A time with no zone is this machine's own, and a day alone is the start of it. */
function instant(time: string, name: string): string {
  const at = new Date(DAY.test(time) ? `${time}T00:00` : time);
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
/** When an event starts, as a number to sort by. One that takes whole days starts with its first day, by this machine's clock. */
const starts = (event: Event) => Date.parse(event.start?.dateTime ?? `${event.start?.date}T00:00`);
/** An event as an agent reads it, on the calendar it is on, with its notes cut to `notes` characters. One on a calendar that isn't the person's own names the calendar. Google marks as `self` the guest whose calendar an event is on, who is the person only on their own. */
const eventLines = (event: Event, calendar: Calendar, notes = NOTES_CHARS) => {
  const join = event.hangoutLink ?? event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri;
  return [
    `id ${event.id}`,
    !calendar.primary && `Calendar: ${nameOf(calendar)}, id ${calendar.id}${readOnly(calendar) ? ", read only" : ""}`,
    event.summary ?? "(No title)",
    `${event.start?.dateTime ?? event.start?.date} to ${event.end?.dateTime ?? event.end?.date}`,
    event.recurringEventId && "One time of an event that repeats. Changing or removing it leaves the other times as they are.",
    event.location && `At ${event.location}`,
    join && `Join at ${join}`,
    event.attendees?.length && `With ${event.attendees.map((guest) => `${guest.email} (${guest.self && calendar.primary ? "the person, " : ""}${guest.responseStatus ?? "needsAction"})`).join(", ")}`,
    event.description && (event.description.length > notes ? `${event.description.slice(0, notes - 1)}…` : event.description),
  ]
    .filter(Boolean)
    .join("\n");
};

const EVENT_PARTS = {
  place: z.string().optional().describe("Where it is"),
  notes: z.string().optional().describe("What the event says about itself"),
  guests: z.array(z.string()).optional().describe("Who is invited, each an email address. Google mails each of them the invitation."),
};
const WHEN = "as YYYY-MM-DDTHH:MM by this machine's clock, or as YYYY-MM-DD for an event that takes whole days";
const ON = { calendar: z.string().optional().describe("The calendar the event is on: its id or its name, as calendar_events and calendar_list give them. Leave it out for the person's own calendar.") };

/**
 * What Sidebots knows of each connection: whose app it is, what its sign-in
 * asks that maker to allow, and the tools it gives the agents, or `server`,
 * where its maker serves them.
 */
const APPS: Record<Connection, { maker: Maker; scopes: string[]; tools: AppTool[]; server?: string }> = {
  gmail: {
    maker: "google",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
    tools: [
      define({
        name: "gmail_search",
        description: "Search the person's Gmail. Answers the mail that matches, newest first, each with its id, who it is from and to, its subject, its date and how it starts, and says so when more mail matches than it answers. Read one in full with gmail_read.",
        input: {
          query: z.string().describe("What to look for, in the words Gmail's own search takes, such as `from:anna newer_than:7d`, `is:unread` or `subject:invoice`"),
          most: z.number().optional().describe("How many to answer at most, up to 25. 10 when left out."),
        },
        run: async ({ query, most = 10 }, call) => {
          const { messages = [], nextPageToken } = await call<{ messages?: { id: string }[]; nextPageToken?: string }>(`${GMAIL}/messages?${new URLSearchParams({ q: byThisClock(query), maxResults: String(Math.min(Math.max(Math.trunc(most), 1), 25)) })}`);
          const found = await Promise.all(messages.map(({ id }) => call<Mail>(`${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)));
          const more = nextPageToken ? ["More mail matches than this. Ask for more at once, up to 25, or search for less."] : [];
          return (
            [...found.map((mail) => [`id ${mail.id}${mail.labelIds?.includes("UNREAD") ? ", unread" : ""}`, ...headers(mail, ["From", "To", "Subject", "Date"]), unescaped(mail.snippet ?? "")].join("\n")), ...more].join("\n\n") ||
            "No mail matches."
          );
        },
      }),
      define({
        name: "gmail_read",
        description: "Read one mail in the person's Gmail in full: who it is from and to, where it asks for answers to go, its subject, its date, what it says and the names of the files sent with it.",
        input: { id: z.string().describe("The mail's id, as gmail_search gives it") },
        run: async ({ id }, call) => {
          const mail = await call<Mail>(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
          const files = everyPart(mail.payload ?? {}).flatMap((part) => (part.filename ? [part.filename] : []));
          return [...headers(mail, ["From", "Reply-To", "To", "Cc", "Subject", "Date"]), ...(files.length ? [`Files: ${files.join(", ")}`] : []), "", mailWords(mail)].join("\n");
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
    // The first is for the events of every calendar, and the second for which calendars the person has.
    scopes: ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"],
    tools: [
      define({
        name: "calendar_events",
        description:
          "Look at the person's Google Calendar: the events between two times on every calendar they have ticked there, earliest first, each with its id, its title, when it starts and ends by this machine's clock, where it is, who is invited and how its notes start. An event that takes whole days ends on the day after its last. An event on a calendar that isn't their own, such as one they follow or were shared, names that calendar and its id. A calendar Google copies in from elsewhere, whose id ends in @import.calendar.google.com, can be hours behind where it comes from. Read one event in full with calendar_event, and see which calendars there are with calendar_list.",
        input: {
          from: z.string().describe("The start of the time to look in, as YYYY-MM-DDTHH:MM by this machine's clock"),
          to: z.string().describe("The end of the time to look in, written the same way"),
          text: z.string().optional().describe("Words the events have in them"),
          calendar: z.string().optional().describe("The one calendar to look at, ticked or not: its id or its name. Leave it out for every calendar the person has ticked."),
        },
        run: async ({ from, to, text, calendar }, call) => {
          const [since, until] = [instant(from, "from"), instant(to, "to")];
          const asked = new URLSearchParams({ timeMin: since, timeMax: until, timeZone: zone(), singleEvents: "true", orderBy: "startTime", maxResults: String(EVENTS_MOST), ...(text && { q: text }) });
          const named = calendar?.trim() ? await calendarNamed(call, calendar) : undefined;
          const calendars = named ? [named] : await calendarsOf(call);
          const looked = named ? calendars : calendars.filter((each) => each.selected);
          // A calendar that can't be looked at, as one whose owner took it back, is left out and said, and the rest are still looked at.
          const answers = await Promise.allSettled(looked.map((on) => call<{ items?: Event[]; nextPageToken?: string }>(`${eventsOf(on)}?${asked}`)));
          const failed = answers.flatMap((answer, at) => (answer.status === "rejected" ? [{ on: looked[at], why: answer.reason as unknown }] : []));
          // When none can be looked at, the look itself is what failed.
          if (failed.length && failed.length === looked.length) throw failed[0].why;
          const found = answers.flatMap((answer, at) => (answer.status === "fulfilled" ? [{ on: looked[at], ...answer.value }] : []));
          const told = new Set<string>();
          const events = found
            .sort((one, other) => Number(other.on.primary ?? false) - Number(one.on.primary ?? false))
            .flatMap(({ on, items = [] }) => items.map((event) => ({ event, on })))
            // Google reads a whole day by the clock of the calendar it is on, so one from the day before the look or the day after it by this machine's clock can come too.
            .filter(({ event }) => !event.start?.date || (starts(event) < Date.parse(until) && Date.parse(`${event.end?.date}T00:00`) > Date.parse(since)))
            // An event the person is a guest of is on their own calendar as well as its host's, so one that two calendars have is told once, as theirs.
            .filter(({ event }) => {
              const one = `${event.iCalUID ?? event.id} ${starts(event)}`;
              return !told.has(one) && told.add(one);
            })
            .sort((one, other) => starts(one.event) - starts(other.event));
          // Google can answer part of what a calendar has, and even none of it, with more to come.
          const more = events.length > EVENTS_MOST || found.some((look) => look.nextPageToken) ? ["The calendars have more then than this. Look in a shorter time for the rest."] : [];
          const left = failed.map(({ on, why }) => `The calendar ${nameOf(on)} is left out. ${why instanceof Error ? why.message : String(why)}`);
          const unticked = calendars.filter((each) => !looked.includes(each)).map(nameOf);
          return (
            [...events.slice(0, EVENTS_MOST).map(({ event, on }) => eventLines(event, on)), ...more, ...left].join("\n\n") ||
            `The calendars have nothing then.${unticked.length ? ` Not looked at, since the person has them unticked: ${unticked.join(", ")}.` : ""}`
          );
        },
      }),
      define({
        name: "calendar_event",
        description: "Read one event in the person's Google Calendar in full, with all its notes, which is where the link to join a call often is.",
        input: { id: z.string().describe("The event's id, as calendar_events gives it"), ...ON },
        run: async ({ id, calendar }, call) => {
          const on = await calendarNamed(call, calendar);
          return eventLines(await call<Event>(`${eventsOf(on)}/${encodeURIComponent(id)}?${new URLSearchParams({ timeZone: zone() })}`), on, Infinity);
        },
      }),
      define({
        name: "calendar_list",
        description: "List the person's calendars in Google Calendar: each with its name and its id, and whether it is their own, whether they have it ticked there, and whether its events can only be read.",
        input: {},
        run: async (_, call) =>
          (await calendarsOf(call))
            .map((calendar) => [nameOf(calendar), `id ${calendar.id}`, calendar.primary && "the person's own", calendar.selected ? "ticked" : "unticked", readOnly(calendar) && "read only"].filter(Boolean).join(", "))
            .join("\n") || "The person has no calendars.",
      }),
      define({
        name: "calendar_add_event",
        description: "Add an event to the person's Google Calendar.",
        checked: "acts",
        input: {
          title: z.string().describe("What the event is called"),
          start: z.string().describe(`When it starts, ${WHEN}`),
          end: z.string().describe("When it ends, written the same way. An event that takes whole days ends on the day after its last."),
          ...ON,
          ...EVENT_PARTS,
        },
        run: async ({ calendar, ...event }, call) => {
          const added = await call<Event>(`${eventsOf(await calendarNamed(call, calendar))}?sendUpdates=all`, { method: "POST", body: eventOf(event) });
          return `Added, as event ${added.id}: ${added.htmlLink}`;
        },
      }),
      define({
        name: "calendar_change_event",
        description: "Change an event in the person's Google Calendar. Give only what changes. Google mails the event's guests the change.",
        checked: "acts",
        input: {
          id: z.string().describe("The event's id, as calendar_events gives it"),
          ...ON,
          title: z.string().optional().describe("What the event is called"),
          start: z.string().optional().describe(`When it starts, ${WHEN}`),
          end: z.string().optional().describe("When it ends, written the same way"),
          ...EVENT_PARTS,
          guests: z.array(z.string()).optional().describe("Everyone who is invited from now on, each an email address. It takes the place of the whole list, so name those who stay too."),
        },
        run: async ({ id, calendar, ...changes }, call) => {
          const on = await calendarNamed(call, calendar);
          return eventLines(await call<Event>(`${eventsOf(on)}/${encodeURIComponent(id)}?sendUpdates=all`, { method: "PATCH", body: eventOf(changes) }), on);
        },
      }),
      define({
        name: "calendar_remove_event",
        description: "Remove an event from the person's Google Calendar. Google mails its guests that it is off.",
        checked: "acts",
        input: { id: z.string().describe("The event's id, as calendar_events gives it"), ...ON },
        run: async ({ id, calendar }, call) => {
          await call(`${eventsOf(await calendarNamed(call, calendar))}/${encodeURIComponent(id)}?sendUpdates=all`, { method: "DELETE" });
          return "Removed.";
        },
      }),
    ],
  },
  notion: { maker: "notion", scopes: [], tools: [], server: NOTION },
};

/** Whether what a maker granted allows all a connection needs. It allows less when the person unticked part of what the sign-in asked for, and when the sign-in asked for less than the connection needs. */
const allowsAll = (connection: Connection, granted: Granted) => APPS[connection].scopes.every((scope) => granted.scope?.split(" ").includes(scope));

/** Every connection's tools, each with the connection it is of. */
export const CONNECTION_TOOLS = (Object.keys(APPS) as Connection[]).flatMap((connection) => APPS[connection].tools.map((tool) => ({ ...tool, connection })));

// How long a sign-in a phone started stays open.
const SIGN_IN_MS = 10 * 60_000;
// A token can go to a turn for as long as the turn runs, so one in hand with less than this left is replaced.
const TURN_MS = 30 * 60_000;
// How long a maker has to answer a request for tokens, since a turn waits for it before it starts.
const GRANT_MS = 10_000;

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
  // The token each connection is asking its app with, until it runs out, and the next one while its maker is asked for it.
  const tokens = new Map<string, { token: string; until: number }>();
  const renewals = new Map<string, Promise<string>>();
  const key = (personId: string, connection: Connection) => `${personId} ${connection}`;

  /** Asks a maker for tokens. */
  const grant = async (maker: Maker, fields: Record<string, string>): Promise<Granted | Refused> => {
    const { token, resource } = MAKERS[maker];
    const asked = { method: "POST", body: new URLSearchParams({ client_id: clients[maker] ?? "", ...(resource && { resource }), ...fields }), signal: AbortSignal.timeout(GRANT_MS) };
    return (await request(token, asked)).json() as Promise<Granted | Refused>;
  };

  const listed = (personId: string, connection: Connection): Connected => ({ connection, ...CONNECTIONS[connection], account: store.connection(personId, connection)?.account ?? null });

  const hold = (personId: string, connection: Connection, granted: Granted) => {
    tokens.set(key(personId, connection), { token: granted.access_token, until: now() + granted.expires_in * 1000 - TURN_MS });
    return granted.access_token;
  };

  /** The token a connection is asking its app with, while it lasts. */
  const inHand = (personId: string, connection: Connection) => {
    const held = tokens.get(key(personId, connection));
    return held && held.until > now() ? held.token : undefined;
  };

  /** A new token for a connection, from its maker. */
  async function renewed(personId: string, connection: Connection): Promise<string> {
    const { name } = CONNECTIONS[connection];
    const connect = `Call \`connect\` with \`${connection}\`, which asks the person to sign in to it.`;
    const kept = store.connection(personId, connection);
    if (!kept) throw new Told(`${name} isn't connected. ${connect}`);
    const maker = APPS[connection].maker;
    const granted = await grant(maker, { grant_type: "refresh_token", refresh_token: kept.token });
    // The person may have removed the connection, or made it again, while the maker answered. What it said is then of a sign-in that is gone.
    if (store.connection(personId, connection)?.token !== kept.token) return inHand(personId, connection) ?? renewed(personId, connection);
    if (!("error" in granted) && allowsAll(connection, granted)) {
      // A maker may answer with a new token that lasts, which ends the one before it.
      if (granted.refresh_token && granted.refresh_token !== kept.token) store.setConnection(personId, connection, { ...kept, token: granted.refresh_token });
      return hold(personId, connection, granted);
    }
    if ("error" in granted && granted.error !== "invalid_grant") throw new Told(`${MAKERS[maker].name} wouldn't renew the sign-in to ${name}: ${granted.error_description ?? granted.error}`);
    // The person took the connection back at the maker's, the maker ended it, or its sign-in allows less than the connection needs.
    store.setConnection(personId, connection, null);
    tokens.delete(key(personId, connection));
    throw new Told(`${name} is no longer connected. ${connect}`);
  }

  /** A token to ask a connection's app with as the person: the one in hand, or a new one from the maker once that has run out. */
  function token(personId: string, connection: Connection): Promise<string> {
    const held = inHand(personId, connection);
    if (held && store.connection(personId, connection)) return Promise.resolve(held);
    // Those that ask at once wait for one new token between them, since a maker may end the token that lasts as it answers with the next.
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
      const { maker } = APPS[connection];
      const { name } = MAKERS[maker];
      const back = URL.parse(url)?.searchParams;
      const state = back?.get("state") ?? "";
      const signIn = signIns.get(state);
      signIns.delete(state);
      if (!signIn || signIn.personId !== personId || signIn.connection !== connection || signIn.until <= now()) throw new Error("That sign-in has run out. Start it again.");
      const code = back?.get("code");
      const granted = code ? await grant(maker, { grant_type: "authorization_code", code, redirect_uri: MAKERS[maker].redirect(clients[maker] ?? ""), code_verifier: signIn.verifier }) : undefined;
      if (!granted || "error" in granted) throw new Error(`${name} didn't sign you in${granted ? `: ${granted.error_description ?? granted.error}` : "."}`);
      if (!granted.refresh_token || !allowsAll(connection, granted)) {
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

    /**
     * The tool servers of the connections the person has made whose makers
     * run one, each with a token that lasts a turn. One whose maker won't
     * renew its sign-in, or can't be reached, is left out.
     */
    async servers(personId: string): Promise<Servers> {
      const made = (Object.keys(APPS) as Connection[]).flatMap((connection) => (APPS[connection].server && store.connection(personId, connection) ? [{ connection, url: APPS[connection].server }] : []));
      const each = await Promise.all(made.map(({ connection, url }) => token(personId, connection).then((held) => [[connection, { url, token: held }]] as const, () => [])));
      return Object.fromEntries(each.flat());
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
