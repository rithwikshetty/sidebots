import { test } from "node:test";
import assert from "node:assert/strict";
import { exchanges, type Message } from "../src/contract.ts";

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

test("an exchange ends when the agent gives the person its reply, and when the person sends a message", () => {
  assert.deepEqual(said([asks("What did the shop quote?"), row("It's sorted: £85."), asks("Can they do Friday?"), person("and the lights?"), asks("Do they fit lights?")]), [
    ["What did the shop quote?"],
    ["Can they do Friday?"],
    ["Do they fit lights?"],
  ]);
});

test("an answer stays with what it answers however late it comes, and each other agent has an exchange of its own", () => {
  assert.deepEqual(
    said([asks("What did the shop quote?"), asks("Is Saturday dry?", "skye"), person("never mind the quote"), asks("Can they do Friday?"), answers("What did the shop quote?", "They quoted £85.")]),
    [["What did the shop quote?", "They quoted £85."], ["Is Saturday dry?"], ["Can they do Friday?"]],
  );
});
