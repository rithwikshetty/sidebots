import { oneLine, type Found, type Message } from "../server/src/contract.ts";

// How much of a found message shows before the words that matched.
const SNIPPET_LEAD = 24;

/** A message as one line, in the chat list or quoted by a reply: an ask's plain words, its text without markdown's marks, what was sent when it has none, or "Done" for a reply with neither, as when an agent finishes without a word. */
export function preview(message: Message): string {
  if (message.body) return oneLine(message);
  if (message.attachments.length === 0) return "Done";
  return message.attachments.length === 1 ? "Attachment" : `${message.attachments.length} attachments`;
}

/** A found message as one line of the list, starting a little before the words that matched, so they show. */
export function foundLine(found: Found, search: string): string {
  const at = found.body.toLowerCase().indexOf(search.toLowerCase());
  const start = at - SNIPPET_LEAD;
  const space = found.body.indexOf(" ", Math.max(start, 0));
  const body = start > 0 ? `…${found.body.slice(space < at ? space + 1 : start)}` : found.body;
  return found.sender === "person" ? `You: ${body}` : body;
}
