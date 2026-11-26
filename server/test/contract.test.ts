import { test } from "node:test";
import assert from "node:assert/strict";
import { asksPerson, avatarStateOf, exchanges, isSuggestion, notifies, selectionWords, type AgentWithLatest, type Message, type Selection } from "../src/contract.ts";

/** A message in Mochi's chat, named by what it says. It is Mochi's reply to the person unless `more` says otherwise. */
const row = (body: string, more: Partial<Message> = {}): Message => ({
  id: body,
  agent_id: "mochi",
  sender: "agent",
  body,
  attachments: [],
  status: "done",
  seen_at: null,
  reply_to: null,
  job_id: null,
  interim: false,
  ask: null,
  question: null,
  peer_id: null,
  switched: null,
  order: 0,
  created_at: 0,
  ...more,
});
const person = (body: string) => row(body, { sender: "person" });
const asks = (body: string, agent = "cog") => row(body, { peer_id: agent });
const answers = (asked: string, body: string) => row(body, { agent_id: "cog", peer_id: "mochi", reply_to: asked });
const said = (messages: Message[]) => exchanges(messages).map((exchange) => exchange.map((message) => message.body));

test("what two agents ask and answer one after another is one exchange, through an update, an ask for the person's OK and a notice", () => {
  assert.deepEqual(
    said([
      person("is my bike sorted?"),
      asks("What did the shop quote?"),
      row("I've asked Cog.", { interim: true }),
      row("Run a command: Look up the quote", { agent_id: "cog", peer_id: "mochi", ask: "allowed" }),
      answers("What did the shop quote?", "They quoted £85."),
      row("Fresh start", { sender: "sidebots" }),
      asks("Can they do Friday?"),
      answers("Can they do Friday?", "Friday works."),
    ]),
    [["What did the shop quote?", "They quoted £85.", "Can they do Friday?", "Friday works."]],
  );
});

test("an exchange ends when the agent gives the person a reply, its own or a job's, and when the person sends a message", () => {
  assert.deepEqual(
    said([
      asks("What did the shop quote?"),
      row("It's sorted: £85."),
      asks("Can they do Friday?"),
      person("and the lights?"),
      asks("Do they fit lights?"),
      row("The fare is $880.", { job_id: "fare" }),
      asks("Is the bike ready?"),
    ]),
    [["What did the shop quote?"], ["Can they do Friday?"], ["Do they fit lights?"], ["Is the bike ready?"]],
  );
});

test("an answer stays with what it answers however late it comes, and each other agent has an exchange of its own", () => {
  assert.deepEqual(
    said([asks("What did the shop quote?"), asks("Is Saturday dry?", "skye"), person("never mind the quote"), asks("Can they do Friday?"), answers("What did the shop quote?", "They quoted £85.")]),
    [["What did the shop quote?", "They quoted £85."], ["Is Saturday dry?"], ["Can they do Friday?"]],
  );
});

test("a suggestion tells nobody and holds no turn, and what an agent's own runs send tells the person once", () => {
  const offered = row("Suggestion: Reply to the plumber", { ask: "waiting", interim: true, question: { kind: "work", title: "Suggestion", what: "Reply to the plumber", facts: [], detail: "Draft a yes." } });
  const command = row("Run a command: List", { ask: "waiting", question: { kind: "command", title: "Run a command", what: "List", facts: [], detail: "ls" } });
  assert.deepEqual([isSuggestion(offered), isSuggestion(command), isSuggestion(row("A reply."))], [true, false, false]);
  assert.deepEqual([notifies(offered), notifies(command), notifies(row("A reply."))], [false, true, true]);
  // A reply one of the agent's own runs sent tells the person as it comes, and not again when the chat's session is told of it.
  const result = row("The draft is ready.", { job_id: offered.id, reply_to: offered.id });
  assert.deepEqual([notifies(result), notifies({ ...result, seen_at: 1 })], [true, false]);
  // Only an ask a turn of the chat's waits on holds the chat: not a suggestion, and not an ask the agent's own run raised.
  assert.deepEqual([asksPerson("mochi", [offered]), asksPerson("mochi", [{ ...command, job_id: offered.id }]), asksPerson("mochi", [command]), asksPerson("cog", [command])], [false, false, true, false]);
  // Work the person started has the avatar working, though no turn of the chat's is.
  const agent = { working: false, work: [{ ...offered, ask: "allowed", status: "running" }], unread: 0, latest: null } as unknown as AgentWithLatest;
  assert.deepEqual([avatarStateOf(agent), avatarStateOf({ ...agent, work: [] })], ["working", "resting"]);
});

test("a change of what an agent answers with reads as the parts that changed, and as all of each on another provider", () => {
  const opus: Selection = { provider: "claude", model: "opus", effort: "medium", fast: false };
  const words = (from: Selection, to: Selection) => [selectionWords(from, to).join(" "), selectionWords(to, from).join(" ")];
  assert.deepEqual(selectionWords(opus), ["Claude Opus 5.5", "Medium"]);
  assert.deepEqual(selectionWords({ ...opus, fast: true }), ["Claude Opus 5.5", "Medium", "Fast"]);
  assert.deepEqual(words(opus, { ...opus, model: "sonnet" }), ["Claude Opus 5.5", "Claude Sonnet 5.5"]);
  assert.deepEqual(words(opus, { ...opus, effort: "high" }), ["Medium", "High"]);
  assert.deepEqual(words(opus, { ...opus, fast: true }), ["Standard", "Fast"]);
  // Sonnet has no fast mode, so it answers at its usual speed whatever the agent is set to.
  assert.deepEqual(words({ ...opus, fast: true }, { ...opus, model: "sonnet", fast: true }), ["Claude Opus 5.5 Fast", "Claude Sonnet 5.5 Standard"]);
  assert.deepEqual(words(opus, { provider: "codex", model: "sol", effort: "high", fast: true }), ["Claude Opus 5.5 Medium", "GPT-6.2 Sol High Fast"]);
});
