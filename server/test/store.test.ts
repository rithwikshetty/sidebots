import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import { PAGE, RUN } from "../src/contract.ts";
import { openStore } from "../src/store.ts";

/** A new Sidebots with a person and two of their agents. */
function withAgents() {
  const home = mkdtempSync(join(tmpdir(), "sidebots-store-test-"));
  const store = openStore(home);
  const person = store.addPerson({ name: "Alex", provider: "claude", configDir: "/config/alex" });
  return { home, store, person, maya: store.createAgent(person, "Maya", "mochi", "claude"), theo: store.createAgent(person, "Theo", "mochi", "claude") };
}

test("what runs with every message, and with every look at the list of agents or a chat, finds its messages by an index, so none of it reads every message there is", (t) => {
  // Every statement the store compiles, from the first it compiles as it opens.
  const compiled = t.mock.method(DatabaseSync.prototype, "prepare");
  const { home, store, person, maya, theo } = withAgents();
  const first = store.addMessage(maya.id, "person", "Hello.", "queued");
  store.addMessage(maya.id, "agent", "What do you think?", "queued", { peerId: theo.id });
  store.markSeen([first.id]);
  store.agentsFor(person.id);
  store.markRead(maya.id);
  store.messages(maya.id);
  store.messages(maya.id, { before: first.id });
  store.messages(maya.id, { after: first.id });
  store.messages(maya.id, { before: first.id, through: first.id });
  store.message(theo.id, first.id);
  store.messagesBefore(maya.id, first.id, 10);
  store.sentByRunsBefore(maya.id, first.id, 10);
  store.toldOfRuns(maya.id, first.id);
  store.nextQueued(theo.id);
  store.nextWork(maya.id);
  store.closeSuggestions(maya.id);
  store.waitingFromPerson(maya.id);
  store.asked(maya.id);
  store.askedOf(theo.id);
  store.setStatus(first.id, "done");
  const statements = [...new Set(compiled.mock.calls.map((call) => call.arguments[0] as string))].filter((sql) => /\bmessages\b/.test(sql));
  store.close();

  const db = new DatabaseSync(join(home, "sidebots.sqlite"));
  const plan = (sql: string) => (db.prepare(`explain query plan ${sql}`).all() as { detail: string }[]).map((step) => step.detail).join(", ");
  // The five the list of agents asks of each agent, a chat's four pages, and what the runner asks before and after a turn.
  assert.ok(statements.length >= 21, `${statements.length} statements`);
  for (const sql of statements) assert.doesNotMatch(plan(sql), /SCAN messages/, sql);
  // Each index serves what it is there for: an agent's latest message, what is unread, whether it works, what it waits on, and a page of its chat. Without its index, each of these reads the agent's whole chat, which is no scan of every message.
  const served = (asks: string) => {
    const sql = statements.find((each) => each.includes(asks));
    assert.ok(sql, asks);
    return plan(sql);
  };
  assert.match(served("order by rowid desc limit 1"), /INDEX messages_agent \(/);
  assert.match(served("count(*) as unread"), /INDEX messages_agent_created \(/);
  assert.match(served("select 1 from messages"), /INDEX messages_unfinished \(/);
  assert.match(served("indexed by messages_unfinished"), /INDEX messages_unfinished \(/);
  assert.match(served("indexed by messages_untold"), /INDEX messages_untold \(/);
  assert.match(served("union select"), /INDEX messages_agent \(.*INDEX messages_peer \(/);
  // A page is read in order, so none of the four sorts the chat to find it.
  const pages = statements.filter((sql) => sql.includes("union select"));
  assert.equal(pages.length, 4);
  for (const sql of pages) assert.doesNotMatch(plan(sql), /TEMP B-TREE/, sql);
});

test("each message carries the order it came in, whatever the clock said, as it is added, as it is told of and as it is read back", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 5_000 });
  const { store, maya, theo } = withAgents();
  const told: number[] = [];
  store.onChange((change) => void ("message" in change && told.push(change.message.order)));
  const first = store.addMessage(maya.id, "person", "Hello.", "queued");
  // The clock stands still for the second, and has gone back by the third.
  const second = store.addMessage(theo.id, "agent", "What do you think?", "queued", { peerId: maya.id });
  t.mock.timers.setTime(1_000);
  const third = store.addMessage(maya.id, "agent", "Hi.", "done");
  const orders = [first, second, third].map((message) => message.order);
  assert.ok(orders[0] < orders[1] && orders[1] < orders[2], String(orders));
  assert.deepEqual(told, orders);
  assert.deepEqual(store.messages(maya.id).map((message) => message.order), orders);
  // A message keeps its order as it changes.
  store.markSeen([first.id]);
  assert.deepEqual([store.message(maya.id, first.id)?.order, told.at(-1)], [orders[0], orders[0]]);

  // Theo is deleted, and with him the last messages there are: what he asked Maya, and one of his own. The next message still comes after them all, twice over.
  const last = store.addMessage(theo.id, "person", "Thanks.", "done").order;
  store.deleteAgent(theo);
  assert.ok(store.addMessage(maya.id, "person", "Anyone there?", "queued").order > last);
  const ruby = store.createAgent(store.personByName("Alex")!, "Ruby", "mochi", "claude");
  const hers = store.addMessage(ruby.id, "person", "Hello.", "done").order;
  store.deleteAgent(ruby);
  assert.ok(store.addMessage(maya.id, "person", "Hello?", "queued").order > hers);
});

test("a page of a chat holds its own messages and what another agent sent it, in the order they came", () => {
  const { store, maya, theo } = withAgents();
  // Every third message in Maya's chat is one Theo sent her, and Theo's chat has more that never reach hers.
  const sent = Array.from({ length: 120 }, (_, index) => {
    store.addMessage(theo.id, "person", `to Theo ${index}`, "done");
    return index % 3 === 0 ? store.addMessage(theo.id, "agent", `from Theo ${index}`, "done", { peerId: maya.id }) : store.addMessage(maya.id, "agent", `note ${index}`, "done");
  });
  const bodies = (messages: { body: string }[]) => messages.map((message) => message.body);
  const said = bodies(sent);

  const latest = store.messages(maya.id);
  assert.deepEqual(bodies(latest), said.slice(70));
  const older = store.messages(maya.id, { before: latest[0].id });
  assert.deepEqual(bodies(older), said.slice(20, 70));
  assert.deepEqual(bodies(store.messages(maya.id, { before: older[0].id })), said.slice(0, 20));
  assert.deepEqual(bodies(store.messages(maya.id, { after: sent[9].id })), said.slice(10));
  assert.deepEqual(store.messages(maya.id, { after: sent[119].id }), []);
  assert.deepEqual(store.messages(maya.id, { before: "no such message" }), []);
});

test("the run of a chat from a message holds everything from it through the one it runs to, up to its limit", () => {
  const { store, maya, theo } = withAgents();
  // Every third message in Maya's chat is one Theo sent her, and Theo's chat has more that never reach hers.
  const toTheo: string[] = [];
  const sent = Array.from({ length: RUN * 3 }, (_, index) => {
    toTheo.push(store.addMessage(theo.id, "person", `to Theo ${index}`, "done").id);
    return index % 3 === 0 ? store.addMessage(theo.id, "agent", `from Theo ${index}`, "done", { peerId: maya.id }) : store.addMessage(maya.id, "agent", `note ${index}`, "done");
  });
  const said = sent.map((message) => message.body);
  const bodies = (messages: { body: string }[]) => messages.map((message) => message.body);
  const newest = sent.at(-PAGE)!;

  assert.deepEqual(bodies(store.messages(maya.id, { before: newest.id, through: sent[400].id })), said.slice(400, sent.length - PAGE + 1));
  assert.deepEqual(bodies(store.messages(maya.id, { before: newest.id, through: sent[3].id })), said.slice(3, 3 + RUN));
  assert.deepEqual(bodies(store.messages(maya.id, { before: sent[3].id, through: sent[3].id })), [said[3]]);
  // A message after the one it runs to, or one in another chat, has no run.
  assert.deepEqual(store.messages(maya.id, { before: sent[3].id, through: newest.id }), []);
  assert.deepEqual(store.messages(maya.id, { before: newest.id, through: toTheo[3] }), []);
});

test("an agent's count of the changes to its chat moves by one with each message added or changed in it, in both chats when the message is between two agents, and with nothing else", () => {
  const { store, person, maya, theo } = withAgents();
  const counts = () => [maya, theo].map((agent) => store.agent(agent.id)!.chat_changes);
  /** How far a change moved Maya's count and Theo's. */
  const moved = (change: () => unknown) => {
    const before = counts();
    change();
    return counts().map((count, index) => count - before[index]);
  };
  const question = { kind: "command" as const, title: "Run a command", what: "Clear the old folder", facts: [], detail: "rm -r old" };
  assert.deepEqual(counts(), [0, 0]);

  let sent!: ReturnType<typeof store.addMessage>;
  assert.deepEqual(moved(() => (sent = store.addMessage(maya.id, "person", "Hello.", "queued"))), [1, 0]);
  // Maya reads it, which makes it `running` and gives it its `seen_at`. Read already, it doesn't change.
  assert.deepEqual(moved(() => store.markSeen([sent.id])), [1, 0]);
  assert.deepEqual(moved(() => store.markSeen([sent.id])), [0, 0]);
  // Her turn fails, and the person sends the message again.
  assert.deepEqual(moved(() => store.setStatus(sent.id, "failed")), [1, 0]);
  assert.deepEqual(moved(() => store.setStatus(sent.id, "queued")), [1, 0]);
  // An ask, and its closing. Closed already, it doesn't change.
  let ask!: ReturnType<typeof store.addMessage>;
  assert.deepEqual(moved(() => (ask = store.addMessage(maya.id, "agent", "", "done", { ask: "waiting", question }))), [1, 0]);
  assert.deepEqual(moved(() => store.answerAsk(ask.id, "allowed")), [1, 0]);
  assert.deepEqual(moved(() => store.answerAsk(ask.id, "refused")), [0, 0]);
  // What Maya asks Theo is in both their chats, as is its reading, and as is an ask Theo raises while working for her.
  let asked!: ReturnType<typeof store.addMessage>;
  assert.deepEqual(moved(() => (asked = store.addMessage(maya.id, "agent", "What do you think?", "queued", { peerId: theo.id }))), [1, 1]);
  assert.deepEqual(moved(() => store.markSeen([asked.id])), [1, 1]);
  assert.deepEqual(moved(() => store.addMessage(theo.id, "agent", "", "done", { ask: "waiting", question, peerId: maya.id })), [1, 1]);
  assert.deepEqual(store.agentsFor(person.id).map((agent) => [agent.name, agent.chat_changes]).sort(), [["Maya", 9], ["Theo", 3]]);

  // Reading a chat, a page of it and a change to its agent are no change to its messages.
  assert.deepEqual(moved(() => [store.markRead(maya.id), store.messages(maya.id), store.updateAgent(maya, { name: "Mia", muted: true })]), [0, 0]);
  // A server that starts again puts back what Theo was reading and closes the ask he left waiting, each a change to a message in both chats.
  assert.deepEqual(moved(() => store.requeueInterrupted()), [2, 2]);
});

test("deleting an agent moves the count of each chat that held what it said", () => {
  const { store, maya, theo } = withAgents();
  const ruby = store.createAgent(store.personByName("Alex")!, "Ruby", "mochi", "claude");
  store.addMessage(maya.id, "agent", "What do you think?", "queued", { peerId: theo.id });
  store.addMessage(theo.id, "agent", "Looks fine.", "done", { peerId: maya.id });
  store.addMessage(ruby.id, "person", "Hello.", "done");
  const before = [maya, ruby].map((agent) => store.agent(agent.id)!.chat_changes);

  store.deleteAgent(theo);
  const after = [maya, ruby].map((agent) => store.agent(agent.id)!.chat_changes);
  assert.ok(after[0] > before[0]);
  assert.equal(after[1], before[1]);
  assert.deepEqual(store.messages(maya.id), []);
});

test("what an agent's own runs sent that its chat's session hasn't been told of is the latest few of them, oldest first, until it is told", () => {
  const { store, maya } = withAgents();
  const bodies = (messages: { body: string }[]) => messages.map((message) => message.body);
  const before = store.addMessage(maya.id, "agent", "post before the reply", "done", { jobId: "job" }).body;
  // A reply that came after, from a turn that was under way, is no sign its session saw the post.
  store.addMessage(maya.id, "agent", "The reply.", "done");
  const posts = [before, ...Array.from({ length: 30 }, (_, index) => store.addMessage(maya.id, "agent", `post ${index}`, "done", { jobId: "job" }).body)];
  const next = store.addMessage(maya.id, "person", "Any news?", "queued");
  const after = store.addMessage(maya.id, "agent", "post after the message", "done", { jobId: "job" });

  assert.deepEqual(bodies(store.sentByRunsBefore(maya.id, next.id, 5)), posts.slice(26));
  assert.deepEqual(bodies(store.sentByRunsBefore(maya.id, next.id, 40)), posts);
  // Once the session has read the message, it has been told of all that came before it, and of nothing after.
  store.toldOfRuns(maya.id, next.id);
  assert.deepEqual(store.sentByRunsBefore(maya.id, next.id, 40), []);
  assert.equal(typeof store.messages(maya.id)[0].seen_at, "number");
  assert.deepEqual(bodies(store.sentByRunsBefore(maya.id, store.addMessage(maya.id, "person", "And now?", "queued").id, 5)), [after.body]);
});

test("a suggestion waits quietly until the person answers, and one they start is the agent's work until its run ends", () => {
  const { store, person, maya } = withAgents();
  const offer = (what: string) => store.addMessage(maya.id, "agent", `Suggestion: ${what}`, "done", { ask: "waiting", interim: true, question: { kind: "work", title: "Suggestion", what, facts: [], detail: "Do it." } });
  store.addMessage(maya.id, "agent", "Two things today.", "done");
  const [first, second, third] = ["Reply to the plumber", "Renew the insurance", "Book the dentist"].map(offer);
  const shown = () => store.agentsFor(person.id).find((agent) => agent.id === maya.id)!;
  // Only the reply is unread, and nothing waits on the agent.
  assert.deepEqual([shown().unread, shown().working, shown().work], [1, false, []]);
  assert.equal(store.nextWork(maya.id), undefined);

  // Started, it waits for its run, beside the chat: the agent has work, and no turn in its chat.
  store.answerAsk(second.id, "allowed");
  store.answerAsk(first.id, "allowed");
  store.answerAsk(third.id, "refused");
  assert.deepEqual(store.messages(maya.id).slice(1).map((message) => [message.ask, message.status]), [["allowed", "queued"], ["allowed", "queued"], ["refused", "done"]]);
  assert.equal(store.nextQueued(maya.id), undefined);
  assert.equal(store.nextWork(maya.id)?.id, first.id);
  store.setStatus(second.id, "running");
  // The one its run is on comes first.
  assert.deepEqual([shown().working, shown().work.map((work) => work.id)], [false, [second.id, first.id]]);

  // A server that stopped part way puts the run back in line, and leaves a suggestion nobody answered waiting.
  const fourth = offer("Water the plants");
  const turnAsk = store.addMessage(maya.id, "agent", "Run a command", "done", { ask: "waiting", question: { kind: "command", title: "Run a command", what: "List", facts: [], detail: "ls" } });
  assert.deepEqual(store.requeueInterrupted(), [maya.id]);
  assert.deepEqual([store.message(maya.id, second.id)?.status, store.message(maya.id, fourth.id)?.ask, store.message(maya.id, turnAsk.id)?.ask], ["queued", "waiting", "unanswered"]);

  // Its page lists what was started, newest first, and its next suggestions take the place of the ones left waiting.
  store.setStatus(second.id, "done");
  assert.deepEqual(store.about(maya).work.map((work) => [work.id, work.status]), [[second.id, "done"], [first.id, "queued"]]);
  store.closeSuggestions(maya.id);
  assert.equal(store.message(maya.id, fourth.id)?.ask, "unanswered");
});

test("a turn counts on the day it ran by the computer's clock, and a day without one counts nothing", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 10, 10, 23, 59) });
  const { store, person, maya, theo } = withAgents();
  const days = () => store.usage(person.id).days.map((day) => [day.day, day.cost, day.tokens]);
  store.addUsage(maya.id, "reply", { sessionId: "evening", cost: 1, tokens: 1000 }, false);
  // Two minutes on, it is the next day.
  t.mock.timers.tick(2 * 60_000);
  store.addUsage(maya.id, "reply", { sessionId: "night", cost: 2, tokens: 2000 }, false);
  store.addUsage(theo.id, "job", { sessionId: "run", cost: 0.5, tokens: 500 }, false);

  t.mock.timers.setTime(new Date(2026, 10, 16, 12, 0).getTime());
  assert.deepEqual(days(), [
    ["2026-11-10", 1, 1000],
    ["2026-11-11", 2.5, 2500],
    ["2026-11-12", 0, 0],
    ["2026-11-13", 0, 0],
    ["2026-11-14", 0, 0],
    ["2026-11-15", 0, 0],
    ["2026-11-16", 0, 0],
  ]);
  // A day later, the oldest of the seven has gone.
  t.mock.timers.setTime(new Date(2026, 10, 17, 12, 0).getTime());
  assert.deepEqual(days().slice(0, 2), [
    ["2026-11-11", 2.5, 2500],
    ["2026-11-12", 0, 0],
  ]);
  assert.equal(days().length, 7);
});

test("a database made before the table changes gets them and keeps what it holds", () => {
  const home = mkdtempSync(join(tmpdir(), "sidebots-store-test-"));
  // The tables the changes touch, as the first published version made them, with an agent, a message, a phone that allows notifications, and an API key as that version saved one.
  const old = new DatabaseSync(join(home, "sidebots.sqlite"));
  old.exec(`
    create table people (id text primary key, name text not null unique, claude_config_dir text not null);
    create table devices (
      id text primary key, person_id text not null references people(id), name text not null, key_hash text not null unique,
      notification_key text not null, push_token text, environment text check (environment in ('sandbox', 'production')), paired_at integer not null
    );
    create table agents (
      id text primary key, person_id text not null references people(id), name text not null, avatar_id text not null,
      model text not null default 'opus', effort text not null default 'medium', muted integer not null default 0,
      hidden integer not null default 0, session_id text, read_at integer not null default 0, created_at integer not null
    );
    create table messages (
      id text primary key, agent_id text not null references agents(id), sender text not null check (sender in ('person', 'agent', 'sidebots')),
      body text not null, attachments text not null default '[]', status text not null check (status in ('queued', 'running', 'done', 'failed')),
      seen_at integer, reply_to text, job_id text, interim integer not null default 0, created_at integer not null
    );
    insert into people values ('me', 'Rithwik', '/tmp/claude');
    insert into agents (id, person_id, name, avatar_id, created_at) values ('maya', 'me', 'Maya', 'mochi', 1);
    insert into messages (id, agent_id, sender, body, status, created_at) values ('hello', 'maya', 'agent', 'Hello.', 'done', 2);
    insert into devices values ('phone', 'me', 'phone', 'hash', 'key', '${"a".repeat(64)}', 'production', 1);
  `);
  old.close();
  writeFileSync(join(home, "api-keys.json"), JSON.stringify({ me: "sk-ant-key" }));

  const store = openStore(home);
  assert.deepEqual(store.agentsFor("me").map((agent) => [agent.name, agent.provider, agent.color]), [["Maya", "claude", null]]);
  assert.deepEqual(store.messages("maya").map((message) => [message.body, message.ask]), [["Hello.", null]]);
  // Its chats count their changes from here on.
  store.setStatus("hello", "failed");
  assert.equal(store.agent("maya")?.chat_changes, 1);
  assert.deepEqual(store.people().map((person) => ({ ...person })), [{ id: "me", name: "Rithwik" }]);
  assert.deepEqual(store.accounts("me").map((account) => ({ ...account })), [{ person_id: "me", provider: "claude", config_dir: "/tmp/claude" }]);
  assert.equal(store.apiKey("me", "claude"), "sk-ant-key");
  assert.deepEqual(store.pushTargetsFor("me"), [{ token: "a".repeat(64), environment: "production", notificationKey: "key" }]);
  assert.deepEqual(store.devices().map((device) => [device.id, device.kind]), [["phone", "phone"]]);
  store.setPushToken("phone", { token: "b".repeat(64), environment: "sandbox", app: "app.sidebots.dev" });
  assert.deepEqual(store.pushTargetsFor("me"), [{ token: "b".repeat(64), environment: "sandbox", app: "app.sidebots.dev", notificationKey: "key" }]);

  // Opened again, it has every change already.
  const again = openStore(home);
  assert.deepEqual(again.pushTargetsFor("me"), store.pushTargetsFor("me"));
  assert.deepEqual(again.accounts("me"), store.accounts("me"));
});

test("the count of paired phones the relay hears leaves the desktop app out", () => {
  const store = openStore(mkdtempSync(join(tmpdir(), "sidebots-store-test-")));
  const person = store.addPerson({ name: "Alex", provider: "claude", configDir: "/config/alex" });
  store.pair(store.addPairing(person.id).code, "Alex's Mac", "desktop");
  assert.equal(store.counts().phones, 0);
  store.pair(store.addPairing(person.id).code, "iPhone", "phone");
  store.pair(store.addPairing(person.id).code, "iPad", "phone");
  assert.equal(store.counts().phones, 2);
  assert.equal(store.devices().length, 3);
});

test("a database a newer Sidebots has changed keeps its count of changes when an older one opens it", () => {
  const home = mkdtempSync(join(tmpdir(), "sidebots-store-test-"));
  openStore(home).close();
  const database = () => new DatabaseSync(join(home, "sidebots.sqlite"));
  const count = () => {
    const db = database();
    const { user_version } = db.prepare("pragma user_version").get() as { user_version: number };
    db.close();
    return user_version;
  };
  // A newer Sidebots made one change more than this one knows.
  const newer = count() + 1;
  const db = database();
  db.exec(`pragma user_version = ${newer}`);
  db.close();
  openStore(home).close();
  assert.equal(count(), newer);
});

test("several that open a new database at once all open it", async () => {
  // The Mac app starts the server and runs its `status` command at the same moment, on a database neither has made yet. One of them fails only some of the times, so this makes several databases.
  for (let round = 0; round < 6; round++) {
    const home = mkdtempSync(join(tmpdir(), "sidebots-store-test-"));
    const opens = `import { openStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)}; openStore(${JSON.stringify(home)}).close();`;
    const ends = Array.from({ length: 8 }, async () => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", opens], { stdio: ["ignore", "ignore", "pipe"] });
      let failure = "";
      child.stderr.on("data", (chunk) => (failure += chunk));
      const [code] = await once(child, "exit");
      return code === 0 ? "" : failure;
    });
    assert.deepEqual(await Promise.all(ends), Array(8).fill(""));
  }
});

// Takes a database back to before each agent counted the changes to its chat, to before an agent had a fast mode, and to before `devices.kind`, the change before that.
const BEFORE_COUNT = "drop trigger messages_added; drop trigger messages_changed; drop trigger messages_removed; alter table agents drop column chat_changes;";
const BEFORE_FAST = `${BEFORE_COUNT} alter table agents drop column fast; alter table agents drop column ran_on; alter table messages drop column switched;`;
const BEFORE_KIND = `alter table devices drop column kind; ${BEFORE_FAST}`;

test("two that open an older database at once make its changes once", async () => {
  const home = mkdtempSync(join(tmpdir(), "sidebots-store-test-"));
  openStore(home).close();
  // The database as it was before its last change, in the hands of one that has begun to make the change.
  const first = new DatabaseSync(join(home, "sidebots.sqlite"));
  first.exec(`${BEFORE_KIND} pragma user_version = 11; begin immediate`);
  // Another process opens the database meanwhile, as the Mac app's `status` command does beside the server.
  const opens = `import { openStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)}; console.log("opening"); openStore(${JSON.stringify(home)}).close();`;
  const second = spawn(process.execPath, ["--input-type=module", "--eval", opens], { stdio: ["ignore", "pipe", "pipe"] });
  let failure = "";
  second.stderr.on("data", (chunk) => (failure += chunk));
  const ended = once(second, "exit");
  await once(second.stdout, "data");
  // It has had the time to see how the database stands before the first is done.
  await wait(500);
  first.exec("alter table devices add column kind text not null default 'phone' check (kind in ('phone', 'desktop')); pragma user_version = 12; commit");
  first.close();
  assert.deepEqual(await ended, [0, null], failure);
});

test("a database that counted turns without their tokens keeps the turns, and counts tokens from the next turn of a session", () => {
  const home = mkdtempSync(join(tmpdir(), "sidebots-store-test-"));
  const fresh = openStore(home);
  const person = fresh.addPerson({ name: "Rithwik", provider: "claude", configDir: "/tmp/claude" });
  const agent = fresh.createAgent(person, "Maya", "mochi", "claude");
  fresh.close();
  // The database as it was before the usage table counted tokens, with a turn of a session that cost $2.
  const old = new DatabaseSync(join(home, "sidebots.sqlite"));
  old.exec(`
    alter table usage drop column tokens;
    alter table usage drop column session_tokens;
    ${BEFORE_KIND}
    insert into usage values ('${agent.id}', 'reply', 2, 'chat', 2, ${Date.now()});
    pragma user_version = 8;
  `);
  old.close();

  const store = openStore(home);
  // Nobody can tell how many of the session's 900,000 tokens the next turn used, so it counts from the one after.
  store.addUsage(agent.id, "reply", { sessionId: "chat", cost: 3, tokens: 900_000 }, true);
  store.addUsage(agent.id, "reply", { sessionId: "chat", cost: 3.5, tokens: 950_000 }, true);
  assert.deepEqual(store.usage(person.id).used.map((used) => ({ ...used })), [{ agent_id: agent.id, kind: "reply", turns: 3, cost: 3.5, tokens: 50_000 }]);
});

test("a Codex session from before the connections' tools, or before those tools changed, gets a fresh start, since a Codex chat keeps the tools it started with", () => {
  const home = mkdtempSync(join(tmpdir(), "sidebots-store-test-"));
  const fresh = openStore(home);
  const person = fresh.addPerson({ name: "Rithwik", provider: "claude", configDir: "/tmp/claude" });
  fresh.addAccount(person.id, "codex", "/tmp/codex");
  const [maya, theo, ruby] = [fresh.createAgent(person, "Maya", "mochi", "codex"), fresh.createAgent(person, "Theo", "mochi", "codex"), fresh.createAgent(person, "Ruby", "mochi", "claude")];
  // Maya and Ruby are in the middle of a session. Theo has yet to start one.
  fresh.setSession(maya.id, "thread-1");
  fresh.setSession(ruby.id, "session-1");
  fresh.close();
  // The database as it was before the fresh starts: without them, and without the change made after them.
  const old = new DatabaseSync(join(home, "sidebots.sqlite"));
  old.exec(`${BEFORE_KIND} pragma user_version = 10`);
  old.close();

  const store = openStore(home);
  assert.deepEqual([maya, theo, ruby].map((agent) => store.nextQueued(agent.id)?.body), ["Fresh start", undefined, undefined]);
  // An agent in the middle of a session ran its last turn on what it answers with now, so a move to another provider hands that session over.
  assert.deepEqual([maya, theo, ruby].map((agent) => store.agent(agent.id)?.ran_on?.provider ?? null), ["codex", null, "claude"]);
  assert.deepEqual(store.requeueInterrupted(), [maya.id]);
  // One fresh start is enough for the tools and for their change, and a database that has had the changes doesn't get them again.
  store.close();
  const again = openStore(home);
  assert.equal(again.messages(maya.id).length, 1);
  again.close();

  // The database as it was once the session had its fresh start and went on, before the tools changed.
  const later = new DatabaseSync(join(home, "sidebots.sqlite"));
  later.exec(`update messages set status = 'done'; ${BEFORE_FAST} pragma user_version = 12`);
  later.close();
  assert.equal(openStore(home).messages(maya.id).length, 2);
});
