import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.ts";
import { createConnections } from "../src/connections.ts";

// What a sign-in to Gmail and one to Google Calendar ask Google to allow, as Google names it back.
const EVERYTHING = ["openid", "userinfo.email", "gmail.readonly", "gmail.send", "calendar.events", "calendar.calendarlist.readonly"].map((scope) => (scope === "openid" ? scope : `https://www.googleapis.com/auth/${scope}`)).join(" ");

/** A person with Gmail and Google Calendar connected, and a Google that answers each request as `answer` does, with a refusal when that is a `Response`, and keeps what it was sent. Its sign-ins let their holder do what `allows` names. */
function setup(answer: (request: string) => unknown = () => ({}), allows = EVERYTHING) {
  const store = openStore(mkdtempSync(join(tmpdir(), "sidebots-test-")));
  const person = store.addPerson({ name: "Alex", provider: "claude", configDir: "/config/alex" });
  store.setConnection(person.id, "gmail", { account: "alex@example.com", token: "lasting" });
  store.setConnection(person.id, "calendar", { account: "alex@example.com", token: "lasting" });
  const sent: [request: string, body: unknown][] = [];
  const connections = createConnections(store, { google: "sidebots-test.apps.googleusercontent.com" }, async (url, init) => {
    if (String(url) === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "access", expires_in: 3600, scope: allows });
    const request = `${init?.method ?? "GET"} ${String(url)}`;
    sent.push([request, init?.body ? JSON.parse(String(init.body)) : undefined]);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const answered = answer(request);
    return answered instanceof Response ? answered : Response.json(answered);
  });
  return { sent, use: (tool: string, input: unknown) => connections.use(person.id, tool, input), account: () => connections.account(person.id, "calendar") };
}

test("a mail is sent as the person, with a subject outside ASCII encoded, and an answer joins the thread of the mail it answers", async () => {
  const { sent, use } = setup(() => ({
    id: "m1",
    threadId: "t1",
    payload: { headers: [{ name: "Message-Id", value: "<one@mail.example>" }, { name: "References", value: "<zero@mail.example>" }, { name: "Subject", value: "Friday" }] },
  }));
  /** The mail Gmail was last sent, as its thread, the lines of its head and what it says. */
  const mailed = () => {
    const [request, mail] = sent.at(-1) as [string, { raw: string; threadId?: string }];
    assert.equal(request, "POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    const [head, encoded] = Buffer.from(mail.raw, "base64url").toString().split("\r\n\r\n");
    assert.ok(encoded.split("\r\n").every((line) => line.length <= 76));
    return { thread: mail.threadId, head: head.split("\r\n"), body: Buffer.from(encoded, "base64").toString() };
  };
  const body = "Hello Anna,\n\nFriday at 3 works. I'll bring the old cable so you can match it.\n\nAlex";
  const how = ["MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"];

  assert.equal(await use("gmail_send", { to: ["anna@example.com"], subject: "Café on Friday\nBcc: someone@else.example", body, cc: ["sam@example.com"] }), "Sent to anna@example.com, sam@example.com.");
  // A line break in a subject can't start a header of its own.
  assert.deepEqual(mailed(), {
    thread: undefined,
    head: ["To: anna@example.com", "Cc: sam@example.com", `Subject: =?UTF-8?B?${Buffer.from("Café on Friday Bcc: someone@else.example").toString("base64")}?=`, ...how],
    body,
  });

  // An answer goes under the subject of the mail it answers, whatever subject it was given, since Gmail keeps the two together only then.
  await use("gmail_send", { to: ["anna@example.com"], subject: "See you there", body: "Yes.", answers: "m1" });
  assert.deepEqual(mailed(), {
    thread: "t1",
    head: ["To: anna@example.com", "Subject: Re: Friday", "In-Reply-To: <one@mail.example>", "References: <zero@mail.example> <one@mail.example>", ...how],
    body: "Yes.",
  });
  assert.equal(await use("gmail_send", { to: [], subject: "Hello", body: "Hi" }), "Say who the mail goes to.");
  assert.equal(await use("gmail_send", { to: ["anna@example.com"], body: "Hi" }), "Say the mail's subject.");
});

test("a token asked for under a sign-in the person has since replaced is not used, and its refusal leaves the new connection be", async () => {
  const store = openStore(mkdtempSync(join(tmpdir(), "sidebots-test-")));
  const person = store.addPerson({ name: "Alex", provider: "claude", configDir: "/config/alex" });
  store.setConnection(person.id, "gmail", { account: "old@example.com", token: "old" });
  const used: string[] = [];
  const connections = createConnections(store, { google: "sidebots-test.apps.googleusercontent.com" }, async (url, init) => {
    if (String(url) !== "https://oauth2.googleapis.com/token") return (used.push(new Headers(init?.headers).get("Authorization")!), Response.json({ messages: [] }));
    const lasting = new URLSearchParams(String(init?.body)).get("refresh_token");
    if (lasting === "new") return Response.json({ access_token: "access-new", expires_in: 3600, scope: EVERYTHING });
    // The person connects another account while Google is asked about the one before.
    store.setConnection(person.id, "gmail", { account: "new@example.com", token: "new" });
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  });
  assert.equal(await connections.use(person.id, "gmail_search", { query: "is:unread" }), "No mail matches.");
  assert.deepEqual([used, connections.account(person.id, "gmail")], [["Bearer access-new"], "new@example.com"]);
});

test("a mail with no plain text is read as the words of its page", async () => {
  const page = "<html><head><style>p { color: red }</style></head><body><p>Your order &amp; receipt</p><table><tr><td>Total:</td><td>&lt;£20&gt;</td></tr></table><div>Thanks<br><a class='button' href='https://shop.example/track?order=7&amp;key=k'>Track it</a></div></body></html>";
  const { use } = setup(() => ({
    id: "m2",
    threadId: "t2",
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "From", value: "Shop <shop@example.com>" }, { name: "Reply-To", value: "orders@shop.example" }],
      parts: [
        // A plain part with nothing in it is no reason to pass over the page.
        { mimeType: "text/plain", body: { data: Buffer.from(" \r\n").toString("base64url") } },
        { mimeType: "text/html", body: { data: Buffer.from(page).toString("base64url") } },
        { mimeType: "application/pdf", filename: "receipt.pdf", body: {} },
      ],
    },
  }));
  // The cells of a row stay apart, a link keeps where it goes, and the mail says where an answer to it goes.
  assert.equal(await use("gmail_read", { id: "m2" }), "From: Shop <shop@example.com>\nReply-To: orders@shop.example\nFiles: receipt.pdf\n\nYour order & receipt\nTotal: <£20>\nThanks\nTrack it (https://shop.example/track?order=7&key=k)");
});

test("a search reads a day by this machine's clock, and says when more mail matches than it answers", async () => {
  const { sent, use } = setup((request) => (request.includes("/messages?") ? { messages: [{ id: "m1" }], ...(request.includes("maxResults=1&") || request.endsWith("maxResults=1") ? { nextPageToken: "more" } : {}) } : { id: "m1", snippet: "See you at 3" }));
  assert.equal(await use("gmail_search", { query: "from:anna after:2026/11/20 before:2026-11-21", most: 1 }), "id m1\nSee you at 3\n\nMore mail matches than this. Search for less at once for the rest.");
  // Gmail takes a day alone as one in California, and an instant as it is.
  const seconds = (day: Date) => Math.floor(day.getTime() / 1000);
  assert.equal(new URL(sent[0][0].slice("GET ".length)).searchParams.get("q"), `from:anna after:${seconds(new Date(2026, 10, 20))} before:${seconds(new Date(2026, 10, 21))}`);
  assert.equal(await use("gmail_search", { query: "newer_than:2d" }), "id m1\nSee you at 3");
  assert.equal(new URL(sent.at(-2)![0].slice("GET ".length)).searchParams.get("q"), "newer_than:2d");
});

test("the events of every calendar the person has ticked are looked at as one, and an event is added, changed and removed on the calendar named, with times read by this machine's clock", async () => {
  const event = { id: "e1", summary: "Bike repair", htmlLink: "https://calendar.example/e1", start: { dateTime: "2026-11-20T15:00:00+11:00" }, end: { dateTime: "2026-11-20T16:00:00+11:00" }, location: "The shop", attendees: [{ email: "anna@example.com", responseStatus: "accepted" }] };
  // The person's own calendar, one from work that they follow and gave a name, one they have unticked, and one whose owner has taken it back.
  const WORK = "work@import.calendar.google.com";
  const calendars = [
    { id: "alex@example.com", summary: "alex@example.com", primary: true, selected: true },
    { id: WORK, summary: "Calendar", summaryOverride: "Work", selected: true },
    { id: "races@import.calendar.google.com", summary: "Races" },
    { id: "gone@group.calendar.google.com", summary: "Club", selected: true },
  ];
  const notes = `Agenda: the week ahead. ${"_".repeat(300)} Join the call: https://calls.example/standup`;
  const standup = { id: "w2", summary: "Standup", recurringEventId: "w", hangoutLink: "https://meet.example/abc", description: notes, start: { dateTime: "2026-11-20T09:30:00+11:00" }, end: { dateTime: "2026-11-20T10:00:00+11:00" }, attendees: [{ email: "alex@example.com", self: true, responseStatus: "declined" }] };
  const atWork = [{ id: "w1", summary: "Offsite", start: { date: "2026-11-19" }, end: { date: "2026-11-20" } }, standup];
  const { sent, use } = setup((request) => {
    if (request.startsWith("GET https://www.googleapis.com/calendar/v3/users/me/calendarList")) return { items: calendars };
    if (request.includes("gone%40group")) return Response.json({ error: { message: "Not Found" } }, { status: 404 });
    if (request.includes("/events/w2?")) return standup;
    if (!request.startsWith("GET")) return event;
    return request.includes(encodeURIComponent(WORK)) ? { items: atWork, ...(request.includes("q=busy") && { nextPageToken: "more" }) } : { items: [event] };
  });
  const [from, to] = ["2026-11-19T00:00", "2026-11-21T00:00"];
  // A time with more events than one look answers says so, so the agent doesn't take the rest of it for free.
  assert.match(await use("calendar_events", { from, to, text: "busy" }), /\n\nThe calendars have more then than this\. Look in a shorter time for the rest\.\n\n/);
  sent.length = 0;

  // The events come earliest first whichever calendar each is on, and one on a calendar that isn't the person's own names it. A calendar Google won't show is left out and said.
  const work = `Calendar: Work, id ${WORK}`;
  const repeats = "One time of an event that repeats. Changing or removing it leaves the other times as they are.";
  const standupLines = `id w2\n${work}\nStandup\n2026-11-20T09:30:00+11:00 to 2026-11-20T10:00:00+11:00\n${repeats}\nJoin at https://meet.example/abc\nWith alex@example.com (the person, declined)`;
  assert.equal(
    await use("calendar_events", { from, to, text: "bike" }),
    [
      `id w1\n${work}\nOffsite\n2026-11-19 to 2026-11-20`,
      `${standupLines}\n${notes.slice(0, 299)}…`,
      "id e1\nBike repair\n2026-11-20T15:00:00+11:00 to 2026-11-20T16:00:00+11:00\nAt The shop\nWith anna@example.com (accepted)",
      "The calendar Club is left out. Google Calendar refused that: Not Found",
    ].join("\n\n"),
  );
  const looked = sent.map(([request]) => new URL(request.slice("GET ".length)));
  assert.deepEqual(
    looked.map((look) => decodeURIComponent(look.pathname)),
    ["/calendar/v3/users/me/calendarList", "/calendar/v3/calendars/alex@example.com/events", `/calendar/v3/calendars/${WORK}/events`, "/calendar/v3/calendars/gone@group.calendar.google.com/events"],
  );
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  assert.deepEqual(
    ["timeMin", "timeMax", "timeZone", "singleEvents", "orderBy", "q"].map((name) => looked[2].searchParams.get(name)),
    [new Date(from).toISOString(), new Date(to).toISOString(), zone, "true", "startTime", "bike"],
  );
  // One event is read with all its notes, on the calendar named by the name the person gave it.
  assert.equal(await use("calendar_event", { id: "w2", calendar: "work" }), `${standupLines.replace(`${work}\n`, "")}\n${notes}`);
  assert.equal(sent.at(-1)![0], `GET https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(WORK)}/events/w2?timeZone=${encodeURIComponent(zone)}`);
  assert.equal(
    await use("calendar_add_event", { title: "Dinner", start: "2026-11-20T19:00", end: "2026-11-20T21:00", calendar: "Wedding" }),
    `The person has no one calendar called Wedding. Their calendars: alex@example.com (id alex@example.com), Work (id ${WORK}), Races (id races@import.calendar.google.com), Club (id gone@group.calendar.google.com).`,
  );
  assert.equal(await use("calendar_events", { from: "next Friday", to }), "from must be a time such as 2026-11-16T17:00.");

  assert.equal(await use("calendar_add_event", { title: "Bike repair", start: "2026-11-20T15:00", end: "2026-11-20T16:00", guests: ["anna@example.com"] }), "Added, as event e1: https://calendar.example/e1");
  assert.deepEqual(sent.at(-1), [
    "POST https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all",
    {
      summary: "Bike repair",
      start: { date: null, dateTime: new Date("2026-11-20T15:00").toISOString() },
      end: { date: null, dateTime: new Date("2026-11-20T16:00").toISOString() },
      attendees: [{ email: "anna@example.com" }],
    },
  ]);
  // A change sends only what changes, to the calendar the event is on, and a day alone is an event that takes whole days.
  await use("calendar_change_event", { id: "w2", calendar: WORK, start: "2026-11-21", end: "2026-11-22" });
  assert.deepEqual(sent.at(-1), [
    `PATCH https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(WORK)}/events/w2?sendUpdates=all`,
    { start: { date: "2026-11-21", dateTime: null }, end: { date: "2026-11-22", dateTime: null } },
  ]);
  assert.equal(await use("calendar_remove_event", { id: "e1" }), "Removed.");
  assert.equal(sent.at(-1)![0], "DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/e1?sendUpdates=all");
});

test("a connection whose sign-in allows less than it needs is forgotten, so that the agent asks the person to sign in again", async () => {
  const { sent, use, account } = setup(undefined, EVERYTHING.replace(" https://www.googleapis.com/auth/calendar.calendarlist.readonly", ""));
  assert.equal(await use("calendar_events", { from: "2026-11-20T00:00", to: "2026-11-21T00:00" }), "Google Calendar is no longer connected. Call `connect` with `calendar`, which asks the person to sign in to it.");
  assert.deepEqual([sent, account()], [[], null]);
});

test("a turn is handed Notion's own server with a token, once the person has signed in with the file that says what Sidebots is", async () => {
  const store = openStore(mkdtempSync(join(tmpdir(), "sidebots-test-")));
  const person = store.addPerson({ name: "Alex", provider: "claude", configDir: "/config/alex" });
  // Gmail is connected too, and has no server: its tools are Sidebots' own.
  store.setConnection(person.id, "gmail", { account: "alex@example.com", token: "lasting" });
  const swaps: URLSearchParams[] = [];
  let lasting = 0;
  let time = 0;
  let reached = true;
  // Notion ends the token that lasts as it answers with the next.
  const connections = createConnections(
    store,
    { google: "sidebots-test.apps.googleusercontent.com", notion: "https://sidebots.example/oauth-client.json" },
    async (url, init) => {
      assert.equal(String(url), "https://mcp.notion.com/token");
      if (!reached) throw new Error("fetch failed");
      const swap = new URLSearchParams(String(init?.body));
      swaps.push(swap);
      if (swap.get("grant_type") === "refresh_token" && swap.get("refresh_token") !== `lasting-${lasting}`) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: `access-${++lasting}`, expires_in: 3600, refresh_token: `lasting-${lasting}`, workspace_name: "Home" });
    },
    () => time,
  );
  assert.deepEqual(await connections.servers(person.id), {});

  // Notion's page is asked for tokens for its tool server, and comes back to the address the file lists.
  const signIn = connections.signIn(person.id, "notion");
  const page = new URL(signIn.url);
  assert.equal(`${page.origin}${page.pathname}`, "https://mcp.notion.com/authorize");
  assert.deepEqual(
    [signIn.redirect, ...["client_id", "redirect_uri", "scope", "resource", "code_challenge_method"].map((name) => page.searchParams.get(name))],
    ["app.sidebots:/oauth2redirect", "https://sidebots.example/oauth-client.json", "app.sidebots:/oauth2redirect", "default", "https://mcp.notion.com/mcp", "S256"],
  );
  // Notion names the workspace the person signed in to, which the connection is listed as.
  const connected = await connections.finish(person.id, "notion", `${signIn.redirect}?state=${page.searchParams.get("state")}&code=one-time`);
  assert.deepEqual([connected.account, store.connection(person.id, "notion")], ["Home", { account: "Home", token: "lasting-1" }]);
  assert.deepEqual(["code", "client_id", "resource"].map((name) => swaps[0].get(name)), ["one-time", "https://sidebots.example/oauth-client.json", "https://mcp.notion.com/mcp"]);
  assert.deepEqual(await connections.servers(person.id), { notion: { url: "https://mcp.notion.com/mcp", token: "access-1" } });

  // A token with less than half an hour left wouldn't last a turn. Turns that start at once ask for one new token between them, and the new token that lasts is kept.
  time = 1_800_000;
  const [one, other] = await Promise.all([connections.servers(person.id), connections.servers(person.id)]);
  assert.deepEqual([one.notion?.token, other.notion?.token], ["access-2", "access-2"]);
  assert.deepEqual([swaps.length, swaps[1].get("refresh_token"), store.connection(person.id, "notion")?.token], [2, "lasting-1", "lasting-2"]);

  // A Notion that can't be reached leaves its server out of the turn and the connection be. One that has ended the sign-in has the connection forgotten.
  time = 3_600_000;
  reached = false;
  assert.deepEqual([await connections.servers(person.id), connections.account(person.id, "notion")], [{}, "Home"]);
  reached = true;
  lasting = 9;
  assert.deepEqual([await connections.servers(person.id), connections.account(person.id, "notion")], [{}, null]);
});
