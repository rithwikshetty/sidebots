import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent } from "react";
import { FilePlus2 } from "lucide-react";
import type { AgentWithLatest, Message } from "@server/contract.ts";
import { MAX_FILES } from "@client/files.ts";
import { preview } from "@client/messages.ts";
import { problem } from "../lib/alerts.ts";
import { markRead, send, stop, useAgent, useMessages, useOnline } from "../lib/store.ts";
import { useLooking } from "../lib/view.ts";
import { ChatBar } from "./ChatBar.tsx";
import { Composer } from "./Composer.tsx";
import { withAdded } from "./files.ts";
import type { Outgoing } from "./MessageRow.tsx";
import { Timeline, type TimelineHandle } from "./Timeline.tsx";

/** What the person was putting together in a chat: what they typed, the files they picked, and the message they were replying to. */
type Session = { draft: string; files: File[]; replyTo: Message | null };

// Each chat's session, kept while the window is open, so leaving a chat and coming back finds it as it was. The open chat draws from it and hears each change to it, whoever makes one.
const sessions = new Map<string, Session>();
const NOTHING: Session = { draft: "", files: [], replyTo: null };
const listeners = new Set<() => void>();

/** A chat's session as it is kept, which is empty until the person puts something in it. */
function keptSession(agentId: string): Session {
  return sessions.get(agentId) ?? NOTHING;
}

/** Changes a chat's kept session, whether or not the chat is open, so what comes back from a send that failed after the person left the chat is there when they return. */
function updateSession(agentId: string, change: Partial<Session>): void {
  sessions.set(agentId, { ...keptSession(agentId), ...change });
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** An agent's chat, in the middle of the window: its top bar, its messages, and the field to write the next one in. */
export function Chat({ agentId }: { agentId: string }) {
  const agent = useAgent(agentId);
  if (!agent) return null;
  return <ChatWith agent={agent} />;
}

function ChatWith({ agent }: { agent: AgentWithLatest }) {
  const online = useOnline();
  const messages = useMessages(agent.id);
  const waitingOn = useAgent(agent.waiting_on ?? "");
  const session = useSyncExternalStore(subscribe, () => keptSession(agent.id));
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [dragging, setDragging] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const timeline = useRef<TimelineHandle>(null);

  const update = useCallback((change: Partial<Session>) => updateSession(agent.id, change), [agent.id]);

  const add = (files: File[]) => {
    if (files.length === 0) return;
    const { files: taken, refused } = withAdded(session.files, files);
    update({ files: taken });
    if (refused) problem("Can't add that", new Error(refused));
    field.current?.focus();
  };

  const reply = useCallback(
    (message: Message) => {
      update({ replyTo: message });
      field.current?.focus();
    },
    [update],
  );

  async function onSend() {
    const { draft, files, replyTo } = session;
    const text = draft.trim();
    if (!text && files.length === 0) return;
    update({ draft: "", files: [], replyTo: null });
    setOutgoing({ body: text, files, quote: replyTo ? preview(replyTo) : undefined, after: messages.findLast((message) => message.sender === "person")?.id });
    timeline.current?.toEnd();
    field.current?.focus();
    try {
      await send(agent.id, text, files, replyTo?.id);
    } catch (failure) {
      // What wasn't sent comes back ahead of what the person has put in the chat since: its words before theirs, its files with theirs as far as one message holds them, and its reply unless they chose another.
      const since = keptSession(agent.id);
      update({ draft: [text, since.draft].filter(Boolean).join("\n"), files: withAdded(files, since.files).files, replyTo: since.replyTo ?? replyTo });
      problem("Not sent", failure);
    } finally {
      setOutgoing(null);
    }
  }

  const onStop = () => void stop(agent.id).catch((failure) => problem("Couldn't stop", failure));

  // The field takes focus as the chat opens, and typing anywhere in the window with nothing focused goes to it.
  useEffect(() => {
    field.current?.focus();
    const typed = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      field.current?.focus();
    };
    window.addEventListener("keydown", typed);
    return () => window.removeEventListener("keydown", typed);
  }, []);

  useMarkRead(agent);

  // Esc lets go of the message being replied to wherever focus is in the chat, unless something open in it, as a menu, takes Esc first.
  const cancelReply = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || !session.replyTo || !event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    update({ replyTo: null });
  };

  // Files dragged over the chat show where they can be dropped. Entering and leaving each part of the chat comes as its own event, so the count says when the files have left it.
  const over = useRef(0);
  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  const drag = {
    onDragEnter: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      over.current += 1;
      setDragging(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      over.current = Math.max(0, over.current - 1);
      if (over.current === 0) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      over.current = 0;
      setDragging(false);
      add([...event.dataTransfer.files]);
    },
  };

  return (
    <section aria-label={agent.name} data-testid="chat" className="relative flex h-full flex-col" onKeyDown={cancelReply} {...drag}>
      <ChatBar agent={agent} scrolled={scrolled} />
      <Timeline agent={agent} outgoing={outgoing} onReply={reply} handle={timeline} onScrolled={setScrolled} />
      <div className="mx-auto w-full max-w-[46rem] shrink-0">
        <Composer
          field={field}
          name={agent.name}
          value={session.draft}
          onChange={(draft) => update({ draft })}
          files={session.files}
          onAdd={add}
          onRemove={(file) => update({ files: session.files.filter((each) => each !== file) })}
          replyTo={session.replyTo}
          onCancelReply={() => update({ replyTo: null })}
          onSend={() => void onSend()}
          onStop={agent.working || waitingOn ? onStop : undefined}
          online={online}
        />
      </div>
      {dragging ? (
        <div className="pointer-events-none absolute inset-2 z-20 grid animate-fade-in place-items-center rounded-xl border-2 border-dashed border-chat bg-canvas/90" data-testid="drop-overlay">
          <div className="flex flex-col items-center gap-2 text-center">
            <FilePlus2 aria-hidden className="size-7 text-chat" strokeWidth={1.75} />
            <p className="text-base font-semibold">Drop to add to your message</p>
            <p className="text-sm text-ink2">Up to {MAX_FILES} files, 95 MB in all</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Marks the chat read while the person is looking at it: each time something
 * new comes in, and each time they come back to it. A chat they aren't looking
 * at, as one in a window behind another or under Settings, waits until they
 * are.
 */
function useMarkRead(agent: AgentWithLatest): void {
  const looking = useLooking(agent.id);
  const latest = agent.latest?.id;
  useEffect(() => {
    if (looking) markRead(agent.id);
  }, [agent.id, latest, agent.unread, looking]);
}
