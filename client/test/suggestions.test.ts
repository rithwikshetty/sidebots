import { test } from "node:test";
import assert from "node:assert/strict";
import type { Ask, Message, Status } from "../../server/src/contract.ts";
import { stacksIn, workBeside } from "../suggestions.ts";

let order = 0;
const said = (id: string, rest: Partial<Message> = {}): Message => ({
  id,
  agent_id: "ruby",
  sender: "agent",
  body: id,
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
  order: ++order,
  created_at: 0,
  ...rest,
});
const offered = (id: string, ask: Ask, status: Status = "done"): Message =>
  said(id, { ask, status, interim: true, question: { kind: "work", title: "Suggestion", what: id, facts: [], detail: "Do it." } });

test("the suggestions an agent offered together are a stack that shows the first one still waiting, and those the person started stay as cards", () => {
  const drawn = (messages: Message[]) => {
    const { top, hidden } = stacksIn(messages);
    return messages.filter((message) => !hidden.has(message.id)).map((message) => [message.id, top.get(message.id) ?? null]);
  };
  const brief = said("brief");
  // Three offered together: the first shows, with two under it.
  assert.deepEqual(drawn([brief, offered("plumber", "waiting"), offered("insurance", "waiting"), offered("dentist", "waiting")]), [
    ["brief", null],
    ["plumber", { at: 1, of: 3, under: 2 }],
  ]);
  // Started, the first stays as its card, and the next one shows in its place.
  assert.deepEqual(drawn([brief, offered("plumber", "allowed", "running"), offered("insurance", "waiting"), offered("dentist", "waiting")]), [
    ["brief", null],
    ["plumber", null],
    ["insurance", { at: 2, of: 3, under: 1 }],
  ]);
  // One the person said not now to is gone, as is one the agent's next suggestions took the place of.
  assert.deepEqual(drawn([brief, offered("plumber", "allowed"), offered("insurance", "refused"), offered("dentist", "unanswered"), said("later"), offered("plants", "waiting")]), [
    ["brief", null],
    ["plumber", null],
    ["later", null],
    ["plants", { at: 1, of: 1, under: 0 }],
  ]);
  // An ask of another kind is no suggestion, and ends a stack.
  const command = said("command", { ask: "waiting", question: { kind: "command", title: "Run a command", what: "List", facts: [], detail: "ls" } });
  assert.deepEqual(drawn([offered("plumber", "waiting"), command, offered("dentist", "waiting")]), [
    ["plumber", { at: 1, of: 1, under: 0 }],
    ["command", null],
    ["dentist", { at: 1, of: 1, under: 0 }],
  ]);
});

test("what an agent does beside its chat reads as the work its run is on, where it stands and how many wait behind it", () => {
  const running = offered("plumber", "allowed", "running");
  const next = offered("insurance", "allowed", "queued");
  assert.equal(workBeside({ work: [] }, []), undefined);
  assert.deepEqual(workBeside({ work: [running, next] }, []), { work: running, title: "plumber", state: "Working", running: true, more: 1 });
  assert.deepEqual(workBeside({ work: [next] }, []), { work: next, title: "insurance", state: "Waiting its turn", running: false, more: 0 });
  // An ask its run raised waits on the person, which the strip says in place of working.
  const asks = said("send", { ask: "waiting", reply_to: running.id, question: { kind: "tool", title: "Use Gmail", what: "Send mail", facts: [], detail: "{}" } });
  assert.deepEqual(workBeside({ work: [running] }, [asks]), { work: running, title: "plumber", state: "Waiting for you", running: false, more: 0 });
  assert.equal(workBeside({ work: [running] }, [{ ...asks, ask: "allowed" }])?.state, "Working");
});
