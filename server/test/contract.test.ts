import { test } from "node:test";
import assert from "node:assert/strict";
import { exchanges, selectionWords, type Message, type Selection } from "../src/contract.ts";

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

test("a change of what an agent answers with reads as the parts that changed, and as all of each on another provider", () => {
  const opus: Selection = { provider: "claude", model: "opus", effort: "medium", fast: false };
  const words = (from: Selection, to: Selection) => [selectionWords(from, to).join(" "), selectionWords(to, from).join(" ")];
  assert.deepEqual(selectionWords(opus), ["Opus", "Medium"]);
  assert.deepEqual(selectionWords({ ...opus, fast: true }), ["Opus", "Medium", "Fast"]);
  assert.deepEqual(words(opus, { ...opus, model: "sonnet" }), ["Opus", "Sonnet"]);
  assert.deepEqual(words(opus, { ...opus, effort: "high" }), ["Medium", "High"]);
  assert.deepEqual(words(opus, { ...opus, fast: true }), ["Standard", "Fast"]);
  // Sonnet has no fast mode, so it answers at its usual speed whatever the agent is set to.
  assert.deepEqual(words({ ...opus, fast: true }, { ...opus, model: "sonnet", fast: true }), ["Opus Fast", "Sonnet Standard"]);
  assert.deepEqual(words(opus, { provider: "codex", model: "sol", effort: "high", fast: true }), ["Opus Medium", "Sol High Fast"]);
});
