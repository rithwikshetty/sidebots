import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { ArrowDown } from "lucide-react";
import { betweenAgents, exchanges, type AgentWithLatest, type Message } from "@server/contract.ts";
import { standingOf } from "@client/exchanges.ts";
import { dayLabel, sameDay } from "@client/time.ts";
import { cn } from "../lib/cn.ts";
import { loadMessages, loadOlder, useMessages, useOnline } from "../lib/store.ts";
import { useOpenChat } from "../lib/view.ts";
import { Spinner } from "../ui/Spinner.tsx";
import { ExchangeRow } from "./Exchange.tsx";
import { MessageRow, OutgoingRow, type Arrival, type Outgoing } from "./MessageRow.tsx";
import { WorkingLine } from "./WorkingLine.tsx";

// Within this many pixels of the end, the person is reading the newest message, and the chat follows what comes.
const AT_END = 32;
// Within this many pixels of the top, the chat fetches the page before the oldest message it has.
const NEAR_TOP = 800;
// The window's clock and the server's may disagree by a little.
const CLOCK_SLACK_MS = 2000;
// A scroll this soon after the person's wheel, key or pointer is theirs.
const BY_PERSON_MS = 600;
// How long a message the chat was opened at flashes.
const FLASH_MS = 1600;

// The messages that have come in with motion, so a row drawn again, as when its chat is opened again, shows as it is.
const arrived = new Set<string>();

/** What the chat's foot can ask of its messages: to scroll to the newest. */
export type TimelineHandle = { toEnd: () => void };

/**
 * An agent's messages in a column down the middle of the chat, oldest at the
 * top, with the day between days, what it and another agent said to each
 * other as one line for each exchange, the person's message on its way, and
 * the working line while the agent works. It opens at the newest message and
 * stays there as messages come and pictures and pages load, while the person
 * is at the end. Scrolled up, they stay where they are reading, and a button
 * that jumps to the newest shows once something comes. Near the top, it
 * fetches the page before, keeping the place on screen. Opened at a message,
 * it fetches back until it has it, then scrolls to it and flashes it, or the
 * message drawn nearest to it when it draws nothing itself.
 */
export function Timeline({
  agent,
  outgoing,
  onReply,
  handle,
  onScrolled,
}: {
  agent: AgentWithLatest;
  outgoing: Outgoing | null;
  onReply: (message: Message) => void;
  handle: RefObject<TimelineHandle | null>;
  /** Hears whether the messages have scrolled under the top bar. */
  onScrolled: (scrolled: boolean) => void;
}) {
  const online = useOnline();
  const messages = useMessages(agent.id);
  const opened = useOpenChat();
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const [behind, setBehind] = useState(false);
  const [loading, setLoading] = useState(messages.length === 0 && agent.latest !== null);
  const [flashing, setFlashing] = useState<string | null>(null);
  // Messages made from here on came in while the chat was open, so they arrive with motion.
  const [openedAt] = useState(() => Date.now() - CLOCK_SLACK_MS);
  const older = useRef<"more" | "loading" | "none">("more");

  useEffect(() => {
    loadMessages(agent.id)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [agent.id]);

  // What the agent and another said to each other shows as one line for each exchange, where the newest thing in it was asked.
  const standings = useMemo(() => new Map(exchanges(messages).map((exchange) => standingOf(exchange, messages)).map(({ asked, state }) => [asked.id, state])), [messages]);
  const shown = useMemo(() => messages.filter((message) => !betweenAgents(message) || standings.has(message.id)), [messages, standings]);
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  // The person's newest message, which carries the chat's receipt.
  const newestMine = messages.findLast((message) => message.sender === "person")?.id;
  // Whether the agent waits on the person's answer to an ask of its own, which is then the last thing in the chat.
  const asksPerson = messages.some((message) => message.ask === "waiting" && message.agent_id === agent.id);
  const working = agent.working && online && !asksPerson;
  // The faded copy goes once the server's copy is in the chat, which may come over the event stream first.
  const sending = outgoing && outgoing.after === newestMine ? outgoing : null;

  const toEnd = useCallback((smooth = false) => {
    const element = scroller.current;
    if (!element) return;
    atEnd.current = true;
    setBehind(false);
    // A long way back, the chat jumps to a screen short of the end, and glides the rest.
    if (smooth && element.scrollHeight - element.scrollTop > element.clientHeight * 3) element.scrollTop = element.scrollHeight - element.clientHeight * 2;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  }, []);
  useEffect(() => {
    handle.current = { toEnd: () => toEnd() };
  }, [handle, toEnd]);

  useLayoutEffect(() => {
    const element = scroller.current!;
    element.scrollTop = element.scrollHeight;
    // As the messages or the room for them change size, the chat stays at its end while the person is there.
    const observer = new ResizeObserver(() => {
      if (atEnd.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(content.current!);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // A page fetched above the top, while the person is right at the top, would push what they read down, so the first message drawn before it stays where it was on screen, however much else changed size with it. The browser keeps the place itself anywhere else.
  const anchor = useRef<{ row: Element; at: number } | null>(null);
  const oldest = shown[0]?.id;
  useLayoutEffect(() => {
    const element = scroller.current!;
    const offset = (row: Element) => row.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
    const before = anchor.current;
    if (before?.row.isConnected && element.scrollTop === 0 && !atEnd.current) element.scrollTop = offset(before.row) - before.at;
    const row = content.current!.querySelector("[data-message-id]");
    anchor.current = row ? { row, at: offset(row) } : null;
  }, [oldest]);

  const fetchOlder = useCallback(() => {
    if (older.current !== "more") return;
    older.current = "loading";
    loadOlder(agent.id).then(
      (more) => (older.current = more ? "more" : "none"),
      () => (older.current = "more"),
    );
  }, [agent.id]);

  // A chat shorter than its room has no top to scroll near, so it fetches until it fills the room or reaches its beginning.
  useEffect(() => {
    const element = scroller.current!;
    if (!loading && shown.length > 0 && element.scrollHeight <= element.clientHeight) fetchOlder();
  }, [loading, shown.length, fetchOlder]);

  // Something new at the end while the person reads further up shows the button that jumps to it.
  const newest = shown.at(-1)?.id;
  const seenNewest = useRef(newest);
  useEffect(() => {
    if (newest === seenNewest.current) return;
    seenNewest.current = newest;
    if (!atEnd.current) setBehind(true);
  }, [newest]);

  // Opened at a message, the chat fetches back until it has it, or until its beginning. A message that draws no row, as a turn that ended without a reply, is opened at the nearest row to it, the one before it first.
  const held = useRef(messages);
  held.current = messages;
  useEffect(() => {
    const id = opened?.agentId === agent.id ? opened.messageId : undefined;
    if (!id || loading) return;
    let going = true;
    const rowOf = (message: Message | undefined) => (message ? document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(message.id)}"]`) : null);
    (async () => {
      while (going && !held.current.some((message) => message.id === id)) {
        const more = await loadOlder(agent.id).catch(() => false);
        if (!more) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const at = going ? held.current.findIndex((message) => message.id === id) : -1;
      if (at < 0) return;
      let nearest: HTMLElement | null = null;
      for (let step = 0; !nearest && step < held.current.length; step++) nearest = rowOf(held.current[at - step]) ?? rowOf(held.current[at + step]);
      if (!nearest) return;
      atEnd.current = false;
      nearest.scrollIntoView({ block: "center" });
      setFlashing(nearest.dataset.messageId!);
      setTimeout(() => going && setFlashing(null), FLASH_MS);
    })();
    return () => {
      going = false;
    };
  }, [opened, agent.id, loading]);

  // When the person last scrolled the messages themselves, with the wheel, a key or the scroll bar. Only they move the chat away from its end; the browser also scrolls it, as it keeps the place while something above changes size.
  const moved = useRef(0);
  const holding = useRef(false);
  const byPerson = () => (moved.current = Date.now());
  const hold = () => {
    holding.current = true;
    window.addEventListener("pointerup", () => (holding.current = false), { once: true });
  };
  const scrolled = () => {
    const element = scroller.current!;
    if (holding.current || Date.now() - moved.current < BY_PERSON_MS) atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < AT_END;
    if (atEnd.current) setBehind(false);
    if (element.scrollTop < NEAR_TOP) fetchOlder();
    onScrolled(element.scrollTop > 0);
  };

  // The arrow keys move focus from message to message, the first time to the newest one on screen, so the keyboard reaches each message's Reply and menu.
  const stepFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key !== "ArrowUp" && event.key !== "ArrowDown") || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const element = scroller.current!;
    const rows = [...element.querySelectorAll<HTMLElement>("[data-message-row]")];
    const at = rows.indexOf(event.target as HTMLElement);
    if (at < 0 && event.target !== element) return;
    const bottom = element.getBoundingClientRect().bottom;
    const next = at < 0 ? rows.findLast((row) => row.getBoundingClientRect().top < bottom) : rows[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest" });
  };

  const arrival = (message: Message): Arrival => {
    if (message.created_at < openedAt || arrived.has(message.id)) return "none";
    return message.sender === "person" ? "settle" : "rise";
  };
  useEffect(() => {
    for (const message of shown) if (message.created_at >= openedAt) arrived.add(message.id);
  }, [shown, openedAt]);

  const empty = !agent.latest && messages.length === 0 && !sending;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={scrolled}
        onWheel={byPerson}
        onPointerDown={hold}
        onKeyDown={(event) => {
          byPerson();
          stepFocus(event);
        }}
        onTouchMove={byPerson}
        tabIndex={0}
        className="h-full overflow-x-hidden overflow-y-auto focus-visible:-outline-offset-2"
        data-testid="timeline"
        aria-label="Messages"
        role="log"
      >
        <div ref={content} className="mx-auto flex min-h-full max-w-chat flex-col justify-end px-4 pt-15 pb-3">
          {loading && messages.length === 0 ? (
            <div className="grid flex-1 place-items-center text-ink3">
              <Spinner label="Loading messages" />
            </div>
          ) : null}
          {shown.map((message, index) => {
            const before = shown[index - 1];
            const standing = standings.get(message.id);
            return (
              <div key={message.id}>
                {!before || !sameDay(before.created_at, message.created_at) ? (
                  <p className="mt-4 mb-1.5 text-center text-sm font-medium text-ink2" data-testid="day">
                    {dayLabel(message.created_at)}
                  </p>
                ) : null}
                {standing ? (
                  <ExchangeRow agentId={agent.id} asked={message} state={standing} flashing={flashing === message.id} />
                ) : (
                  <MessageRow
                    message={message}
                    quoted={message.reply_to ? byId.get(message.reply_to) : undefined}
                    // An ask another agent raised while working for this one says whose it is.
                    from={message.agent_id === agent.id ? undefined : message.agent_id}
                    receipt={message.id === newestMine}
                    arrival={arrival(message)}
                    flashing={flashing === message.id}
                    onReply={onReply}
                  />
                )}
              </div>
            );
          })}
          {/* A new agent's chat says what to do first. Its instructions have it ask what it's for. */}
          {empty ? (
            <p className="mb-2 animate-fade-in px-6 text-center text-message text-ink2" data-testid="new-agent-hint">
              {agent.name} is new. Tell it what it's for.
            </p>
          ) : null}
          {sending ? <OutgoingRow outgoing={sending} /> : null}
          {working ? <WorkingLine /> : null}
        </div>
      </div>
      <button
        type="button"
        onClick={() => toEnd(true)}
        tabIndex={behind ? 0 : -1}
        aria-hidden={!behind}
        className={cn(
          "absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full bg-raised pr-3.5 pl-3 text-sm font-medium text-ink shadow-menu transition-[opacity,translate,scale] duration-200 ease-out hover:bg-[color-mix(in_srgb,var(--raised),var(--ink)_4%)] active:scale-95",
          behind ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
        )}
        data-testid="jump-to-latest"
      >
        <ArrowDown aria-hidden className="size-4" strokeWidth={2.25} />
        Jump to latest
      </button>
    </div>
  );
}
