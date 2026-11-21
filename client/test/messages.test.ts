import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../../server/src/contract.ts";
import { preview } from "../messages.ts";

const message = (body: string, attachments: string[] = []): Message => ({
  id: "m-1",
  agent_id: "a-1",
  sender: "agent",
  body,
  attachments,
  status: "done",
  seen_at: null,
  reply_to: null,
  job_id: null,
  interim: false,
  ask: null,
  question: null,
  peer_id: null,
  created_at: 0,
});

test("a message reads as its text on one line, or as what was sent with it, or as done when it has neither", () => {
  assert.equal(preview(message("**Booked** the flights.\n\nSee you there.")), "Booked the flights. See you there.");
  assert.equal(preview(message("", ["attachments/1-a.png"])), "Attachment");
  assert.equal(preview(message("", ["attachments/1-a.png", "attachments/2-b.pdf"])), "2 attachments");
  assert.equal(preview(message("")), "Done");
});
