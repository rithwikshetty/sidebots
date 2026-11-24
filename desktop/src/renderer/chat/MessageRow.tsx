import { memo, useRef, useState, type ReactNode } from "react";
import { Copy, Reply } from "lucide-react";
import type { Message } from "@server/contract.ts";
import { fileKind, fileMeta, isImage, isPage } from "@client/files.ts";
import { preview } from "@client/messages.ts";
import { listTime } from "@client/time.ts";
import { problem } from "../lib/alerts.ts";
import { cn } from "../lib/cn.ts";
import { resend } from "../lib/store.ts";
import { IconButton } from "../ui/Button.tsx";
import { ContextMenu } from "../ui/Menu.tsx";
import { AskAnswer, AskCard } from "./AskCard.tsx";
import { FileCard, FileTile, PageCard, Photos } from "./Attachments.tsx";
import { Bubble } from "./Bubble.tsx";
import { FILE_ICONS, usePreviews } from "./files.ts";
import { Markdown } from "./Markdown.tsx";
import { SwitchNotice } from "./SwitchNotice.tsx";

/** How a row comes into the chat: as it is, rising into place as a new message does, or settling from its faded copy as the person's own does. */
export type Arrival = "none" | "rise" | "settle";

/**
 * A message in the chat, as the phone draws it: a notice from Sidebots as a
 * small grey line, or as a line across the chat when it tells of a change of
 * what the agent answers with, nothing at all for a message with nothing to show, as a
 * turn that ended without a reply, and anything else as its pictures, pages
 * and files above its bubble, at the end of the column for the person's and
 * at the start for the agent's. The bubble quotes the message it answers at its top, with
 * "An earlier message" when the window doesn't have it. An ask shows its card
 * in place of the words, with Allow and Don't allow while it waits. Under the
 * person's own is "Send again" when it failed, and the chat's receipt when it
 * is their newest. A Reply button shows beside the message while the pointer
 * or focus is on it, and a right-click, or the menu key or Shift+F10 while it
 * has focus, offers Reply and Copy text.
 */
export const MessageRow = memo(function MessageRow({
  message,
  quoted,
  from,
  receipt,
  arrival,
  flashing,
  onReply,
}: {
  message: Message;
  /** The message it answers, when it answers one the window has. */
  quoted: Message | undefined;
  /** The agent that sent it, when that isn't the chat's own. */
  from?: string;
  /** Whether the message carries the chat's receipt, as the person's newest does. */
  receipt: boolean;
  arrival: Arrival;
  flashing: boolean;
  onReply: (message: Message) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  // The Reply button is there only while the pointer or focus is on the message, so a long chat holds one, not one for each message.
  const [near, setNear] = useState(false);
  if (message.switched) return <SwitchNotice message={{ ...message, switched: message.switched }} className={cn(arrival !== "none" && "animate-rise-in", flashing && "animate-flash")} />;
  if (message.sender === "sidebots") {
    return (
      <p
        data-message-id={message.id}
        data-testid="notice"
        data-selectable
        className={cn("mx-auto mt-2.5 max-w-[80%] rounded-md px-6 text-center text-sm text-ink2", arrival !== "none" && "animate-rise-in", flashing && "animate-flash")}
      >
        {message.body}
      </p>
    );
  }
  if (!message.body && !message.reply_to && !message.question && message.attachments.length === 0) return null;
  const mine = message.sender === "person";
  // A page is the agent's to send. An HTML file from the person is a file, as it is to the agent.
  const drawn = (path: string) => !mine && isPage(path);
  const photos = message.attachments.filter((path) => isImage(path));
  const pages = message.attachments.filter(drawn);
  const files = message.attachments.filter((path) => !isImage(path) && !drawn(path));

  const copy = () => {
    const selected = window.getSelection();
    const within = selected && !selected.isCollapsed && row.current?.contains(selected.anchorNode) ? selected.toString() : "";
    void navigator.clipboard.writeText(within || message.body).catch((failure) => problem("Couldn't copy it", failure));
  };
  const reply = () => onReply(message);

  return (
    <ContextMenu
      entries={[
        { label: "Reply", icon: Reply, onSelect: reply },
        { label: "Copy text", icon: Copy, onSelect: copy },
      ]}
      className="block"
    >
      <div
        ref={row}
        onPointerEnter={() => setNear(true)}
        onPointerLeave={() => setNear(false)}
        onFocus={() => setNear(true)}
        onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && setNear(false)}
        data-message-id={message.id}
        data-message-row
        tabIndex={-1}
        data-testid={mine ? "message-mine" : "message-theirs"}
        data-status={message.status}
        className={cn(
          "-mx-2 mt-1.5 flex flex-col gap-1 rounded-xl px-2 py-0.5 focus-visible:outline-offset-0",
          mine ? "items-end" : "items-start",
          arrival === "rise" && "animate-rise-in",
          arrival === "settle" && "animate-settle",
          flashing && "animate-flash",
        )}
      >
        <Said
          mine={mine}
          body={message.body}
          quote={message.reply_to ? (quoted ? preview(quoted) : "An earlier message") : undefined}
          photos={photos.length ? <Photos agentId={message.agent_id} paths={photos} end={mine} /> : null}
          pages={pages.map((path) => (
            <PageCard key={path} agentId={message.agent_id} path={path} />
          ))}
          files={files.map((path) => (
            <FileCard key={path} agentId={message.agent_id} path={path} />
          ))}
          ask={message.question ? <AskCard question={message.question} from={from} /> : undefined}
          foot={message.ask ? <AskAnswer message={message} ask={message.ask} /> : undefined}
          aside={
            near ? <IconButton icon={Reply} label="Reply" size="sm" onClick={reply} tooltipSide="top" className="animate-fade-in" data-testid="reply-button" /> : null
          }
        />
        {mine && message.status === "failed" ? (
          <button
            type="button"
            onClick={() => void resend(message).catch((failure) => problem("Not sent", failure))}
            className="mr-1 animate-fade-in rounded-sm px-1 text-xs font-semibold text-tint-ink hover:underline"
            data-testid="send-again"
          >
            Send again
          </button>
        ) : receipt ? (
          <Receipt message={message} />
        ) : null}
      </div>
    </ContextMenu>
  );
});

/**
 * Under the person's newest message: "Delivered" while it waits for the
 * agent, and "Read" with the time once the agent has taken it in. The words
 * fade in as they change.
 */
function Receipt({ message }: { message: Message }) {
  const read = message.status !== "queued";
  const words = read ? `Read ${listTime(message.seen_at ?? message.created_at)}` : "Delivered";
  return (
    <span key={words} className="mr-1 animate-fade-in text-2xs text-ink2" data-testid="receipt">
      {words}
    </span>
  );
}

/**
 * A message the person sent that the server hasn't answered for yet, with
 * what it quotes when it is a reply. `after` is the person's newest message
 * when they sent it, so the copy goes once a newer one is in the chat.
 */
export type Outgoing = { body: string; files: File[]; quote?: string; after: string | undefined };

/** The person's message as it goes, faded at the chat's end until the server has it. */
export function OutgoingRow({ outgoing }: { outgoing: Outgoing }) {
  const photos = outgoing.files.filter((file) => isImage(file.name));
  const files = outgoing.files.filter((file) => !isImage(file.name));
  const previews = usePreviews(photos);
  const urls = photos.map((file) => previews.get(file)).filter((url) => url !== undefined);
  return (
    <div className="mt-1.5 flex flex-col items-end gap-1 opacity-70" data-testid="message-sending">
      <Said
        mine
        body={outgoing.body}
        quote={outgoing.quote}
        photos={
          urls.length ? (
            <div className="flex flex-wrap justify-end gap-1">
              {urls.map((url) => (
                <img key={url} src={url} alt="" className={cn("rounded-xl bg-field object-cover", urls.length === 1 ? "max-h-[228px] max-w-[228px]" : "size-[104px]")} />
              ))}
            </div>
          ) : null
        }
        files={files.map((file, index) => (
          <FileTile key={index} icon={FILE_ICONS[fileKind(file.name)]} name={file.name} meta={fileMeta(file.name, file.size)} />
        ))}
      />
    </div>
  );
}

/**
 * A message as the chat draws it: its pictures and files above its bubble,
 * its pages between them, and the message it answers quoted at the bubble's
 * top. The agent's words are markdown; the person's are as they typed them.
 * An ask shows its card in place of the words. `foot` sits under either,
 * inside the bubble, and `aside` beside the last of what was sent.
 */
function Said({
  mine,
  body,
  quote,
  photos,
  pages = [],
  files,
  ask,
  foot,
  aside,
}: {
  mine: boolean;
  body: string;
  quote?: string;
  photos: ReactNode;
  pages?: ReactNode[];
  files: ReactNode[];
  ask?: ReactNode;
  foot?: ReactNode;
  aside?: ReactNode;
}) {
  const parts: { key: string; node: ReactNode; width: string }[] = [];
  if (photos) parts.push({ key: "photos", node: photos, width: "max-w-full" });
  pages.forEach((page, index) => parts.push({ key: `page-${index}`, node: page, width: "w-full" }));
  if (files.length) parts.push({ key: "files", node: <div className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}>{files}</div>, width: "max-w-full" });
  if (body || quote || ask) {
    parts.push({
      key: "bubble",
      width: "max-w-[85%]",
      node: (
        <Bubble side={mine ? "end" : "start"} className="max-w-full" data-testid="bubble">
          {quote ? (
            <div aria-label={`In reply to: ${quote}`} className={cn("mt-0.5 mb-1.5 border-l-2 pl-2 text-sm opacity-80", mine ? "border-on-tint" : "border-ink2 text-ink2")} data-testid="quote">
              <p className="line-clamp-3 break-words">{quote}</p>
            </div>
          ) : null}
          {ask ?? (body && mine ? <p data-selectable className="whitespace-pre-wrap">{body}</p> : body ? <Markdown text={body} /> : null)}
          {foot}
        </Bubble>
      ),
    });
  }
  return parts.map((part, index) => (
    <div key={part.key} className={cn("relative min-w-0", part.width)}>
      {part.node}
      {aside && index === parts.length - 1 ? <span className={cn("absolute top-1/2 -translate-y-1/2", mine ? "right-full mr-1" : "left-full ml-1")}>{aside}</span> : null}
    </div>
  ));
}
