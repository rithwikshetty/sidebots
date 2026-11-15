import type { Message } from "@server/contract";

/** A message as one line, in the chat list or quoted by a reply: its text, or what was sent when it has none. */
export function preview(message: Message): string {
  if (message.body) return message.body;
  return message.attachments.length === 1 ? "Attachment" : `${message.attachments.length} attachments`;
}
