import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.ts";
import { createConnections } from "../src/connections.ts";

/** A person with Gmail and Google Calendar connected, and a Google that answers each request as `answer` does and keeps what it was sent. */
function setup(answer: (request: string) => unknown = () => ({})) {
  const store = openStore(mkdtempSync(join(tmpdir(), "sidebots-test-")));
  const person = store.addPerson({ name: "Alex", provider: "claude", configDir: "/config/alex" });
  store.setConnection(person.id, "gmail", { account: "alex@example.com", token: "lasting" });
  store.setConnection(person.id, "calendar", { account: "alex@example.com", token: "lasting" });
  const sent: [request: string, body: unknown][] = [];
  const connections = createConnections(store, { google: "sidebots-test.apps.googleusercontent.com" }, async (url, init) => {
    if (String(url) === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "access", expires_in: 3600 });
    const request = `${init?.method ?? "GET"} ${String(url)}`;
    sent.push([request, init?.body ? JSON.parse(String(init.body)) : undefined]);
    return init?.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(answer(request));
  });
  return { sent, use: (tool: string, input: unknown) => connections.use(person.id, tool, input) };
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
    if (lasting === "new") return Response.json({ access_token: "access-new", expires_in: 3600 });
    // The person connects another account while Google is asked about the one before.
    store.setConnection(person.id, "gmail", { account: "new@example.com", token: "new" });
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  });
  assert.equal(await connections.use(person.id, "gmail_search", { query: "is:unread" }), "No mail matches.");
  assert.deepEqual([used, connections.account(person.id, "gmail")], [["Bearer access-new"], "new@example.com"]);
});

test("a mail with no plain text is read as the words of its page", async () => {
  const page = "<html><head><style>p { color: red }</style></head><body><p>Your order &amp; receipt</p><div>Total: &lt;£20&gt;<br>Thanks</div></body></html>";
  const { use } = setup(() => ({
    id: "m2",
    threadId: "t2",
    payload: {
      mimeType: "multipart/mixed",
      headers: [{ name: "From", value: "Shop <shop@example.com>" }],
      parts: [
        // A plain part with nothing in it is no reason to pass over the page.
        { mimeType: "text/plain", body: { data: Buffer.from(" \r\n").toString("base64url") } },
        { mimeType: "text/html", body: { data: Buffer.from(page).toString("base64url") } },
        { mimeType: "application/pdf", filename: "receipt.pdf", body: {} },
      ],
    },
  }));
  assert.equal(await use("gmail_read", { id: "m2" }), "From: Shop <shop@example.com>\nFiles: receipt.pdf\n\nYour order & receipt\nTotal: <£20>\nThanks");
});

test("the calendar's events are looked at, added, changed and removed, with times read by this machine's clock", async () => {
  const event = { id: "e1", summary: "Bike repair", htmlLink: "https://calendar.example/e1", start: { dateTime: "2026-11-20T15:00:00+11:00" }, end: { dateTime: "2026-11-20T16:00:00+11:00" }, location: "The shop", attendees: [{ email: "anna@example.com", responseStatus: "accepted" }] };
  const { sent, use } = setup((request) => (request.startsWith("GET") ? { items: [event], ...(request.includes("q=busy") && { nextPageToken: "more" }) } : event));
  const [from, to] = ["2026-11-20T00:00", "2026-11-21T00:00"];
  // A time with more events than one look answers says so, so the agent doesn't take the rest of it for free.
  assert.match(await use("calendar_events", { from, to, text: "busy" }), /\n\nThe calendar has more then than this\. Look in a shorter time for the rest\.$/);
  sent.length = 0;

  assert.equal(await use("calendar_events", { from, to, text: "bike" }), "id e1\nBike repair\n2026-11-20T15:00:00+11:00 to 2026-11-20T16:00:00+11:00\nAt The shop\nWith anna@example.com (accepted)");
  const looked = new URL(sent[0][0].slice("GET ".length));
  assert.deepEqual(
    ["timeMin", "timeMax", "singleEvents", "orderBy", "q"].map((name) => looked.searchParams.get(name)),
    [new Date(from).toISOString(), new Date(to).toISOString(), "true", "startTime", "bike"],
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
  // A change sends only what changes, and a day alone is an event that takes whole days.
  await use("calendar_change_event", { id: "e1", start: "2026-11-21", end: "2026-11-22" });
  assert.deepEqual(sent.at(-1), [
    "PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/e1?sendUpdates=all",
    { start: { date: "2026-11-21", dateTime: null }, end: { date: "2026-11-22", dateTime: null } },
  ]);
  assert.equal(await use("calendar_remove_event", { id: "e1" }), "Removed.");
  assert.equal(sent.at(-1)![0], "DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/e1?sendUpdates=all");
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
