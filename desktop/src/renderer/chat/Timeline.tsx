import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { LegendList, type LegendListRef, type LegendListRenderItemProps, type NativeScrollEvent, type NativeSyntheticEvent } from "@legendapp/list/react";
import { ArrowDown } from "lucide-react";
import { betweenAgents, exchanges, type AgentWithLatest, type Message } from "@server/contract.ts";
import { standingOf, type Standing } from "@client/exchanges.ts";
import { dayLabel, sameDay } from "@client/time.ts";
import { cn } from "../lib/cn.ts";
import { loadMessages, loadOlder, useMessages, useOnline } from "../lib/store.ts";
import { useOpenChat } from "../lib/view.ts";
import { useToday } from "../lib/window.ts";
import { Spinner } from "../ui/Spinner.tsx";
import { ExchangeRow } from "./Exchange.tsx";
import { MessageRow, OutgoingRow, drawnAs, type Arrival, type Outgoing } from "./MessageRow.tsx";
import { WorkingLine } from "./WorkingLine.tsx";

// Within this share of the room from the end, the person is reading the newest message, and the chat follows what comes.
const AT_END = 0.05;
// Within this many rooms of the top, the chat fetches the page before the oldest message it has.
const NEAR_TOP = 1;
// How tall a row is taken to be until the list has measured one of its kind.
const ROW_HEIGHT = 90;
// The window's clock and the server's may disagree by a little.
const CLOCK_SLACK_MS = 2000;
// How long a message the chat was opened at flashes.
const FLASH_MS = 1600;
// How many frames a scroll of the chat's own is held to its place before the list is left to it.
const SETTLE_FRAMES = 60;

// The messages that have come in with motion, so a row drawn again, as when it is scrolled back to or its chat is opened again, shows as it is.
const arrived = new Set<string>();

/** What the chat's foot can ask of its messages: to scroll to the newest. */
export type TimelineHandle = { toEnd: () => void };

/** The day above the first message of a day. It is a row of its own, so it comes and goes as pages load without the message under it changing height. */
type Day = { id: string; day: number };
type Row = Message | Day;
const isDay = (row: Row): row is Day => "day" in row;

/** What a row draws from besides its own message. */
type Around = {
  agentId: string;
  /** Where each exchange stands, by the message it was last asked at. */
  standings: Map<string, Standing>;
  byId: Map<string, Message>;
  /** The person's newest message, which carries the chat's receipt. */
  newestMine: string | undefined;
  flashing: string | null;
  today: number;
  /** Messages made from here on came in while the chat was open, so they arrive with motion. */
  openedAt: number;
  onReply: (message: Message) => void;
  onPage: (message: Message) => void;
};

const idOf = (row: Row) => row.id;

/** The kind a row is. The list takes a row it hasn't measured to be as tall as the others of its kind, so a message is of a kind with those of its sender and length that carry files or don't. A long message's height says little about another's, so each is a kind of its own. */
function rowKind(row: Row): string {
  if (isDay(row)) return "day";
  if (betweenAgents(row)) return "exchange";
  const drawn = drawnAs(row);
  if (drawn !== "message") return drawn;
  const length = Math.max(0, Math.floor(Math.log2(row.body.length / 1000)));
  return length < 2 ? `${row.sender}:${length}:${row.attachments.length > 0 ? "files" : "words"}` : row.id;
}

/** A row as it is drawn: a day, a message, or the exchange a message was last asked in. */
function drawRow({ item: message, extraData }: LegendListRenderItemProps<Row>) {
  const { agentId, standings, byId, newestMine, flashing, today, openedAt, onReply, onPage } = extraData as Around;
  if (isDay(message)) {
    return (
      <p className="mt-4 px-4 text-center text-sm font-medium text-ink2" data-testid="day">
        {dayLabel(message.day, today)}
      </p>
    );
  }
  const standing = standings.get(message.id);
  const arrival: Arrival = message.created_at < openedAt || arrived.has(message.id) ? "none" : message.sender === "person" ? "settle" : "rise";
  return (
    <div className="px-4">
      {standing ? (
        <ExchangeRow agentId={agentId} asked={message} state={standing} flashing={flashing === message.id} />
      ) : (
        <MessageRow
          message={message}
          quoted={message.reply_to ? byId.get(message.reply_to) : undefined}
          // An ask another agent raised while working for this one says whose it is.
          from={message.agent_id === agentId ? undefined : message.agent_id}
          receipt={message.id === newestMine}
          arrival={arrival}
          flashing={flashing === message.id}
          onReply={onReply}
          onPage={onPage}
        />
      )}
    </div>
  );
}

/**
 * Holds the list at the place a scroll of the chat's own was for, as T3 Code
 * does. The list aims a scroll by the heights it guesses for the rows it
 * hasn't drawn, so it can stop short of the place, and go on waiting to reach
 * one that isn't there. Once the scroll `asked` of it has stopped, by the
 * list's word or the page's, `place` reads where the place is from the page,
 * and the list is put there until it has stayed for two frames, or `over`
 * says the scroll is no longer the chat's.
 */
async function settle(list: LegendListRef, asked: Promise<void>, place: (scroller: HTMLElement) => number | undefined, over: () => boolean): Promise<void> {
  await Promise.race([asked, new Promise((resolve) => list.getScrollableNode()?.addEventListener("scrollend", resolve, { once: true }))]);
  return new Promise((resolve) => {
    let still = 0;
    let frames = 0;
    const hold = () => {
      const scroller = list.getScrollableNode();
      const offset = scroller && !over() ? place(scroller) : undefined;
      if (!scroller || offset === undefined || ++frames > SETTLE_FRAMES) return resolve();
      if (Math.abs(scroller.scrollTop - offset) > 1) {
        still = 0;
        return void list.scrollToOffset({ offset, animated: false }).then(() => requestAnimationFrame(hold));
      }
      if (++still >= 2) return resolve();
      requestAnimationFrame(hold);
    };
    requestAnimationFrame(hold);
  });
}

const endOf = (scroller: HTMLElement) => scroller.scrollHeight - scroller.clientHeight;

// The list cuts each row off at its own edge, which would take the bottom of a message's focus ring and the start of its rise into place. Its rows keep their layout to themselves, and draw past their edge.
const ROWS_DRAW_PAST_THEIR_EDGE = "[&_[style*='contain']]:[contain:layout_style]!";
const SCROLLER = { overflowX: "hidden" } as const;
const COLUMN = { display: "flex", flexDirection: "column" } as const;
// The room the chat's top bar covers.
const UNDER_BAR = <div className="h-15" />;

/**
 * An agent's messages in a column down the middle of the chat, oldest at the
 * top, with the day between days, what it and another agent said to each
 * other as one line for each exchange, the person's message on its way, and
 * the working line while the agent works. It draws the rows near the screen,
 * however many messages it holds, and keeps a row drawn once a page in it has
 * shown, so the page stays as the person left it. It opens at the newest
 * message and stays there as messages come and pictures and pages load, while
 * the person is at the end. Scrolled up, they stay where they are reading,
 * and a button that jumps to the newest shows once something comes. Near the
 * top, it fetches the page before, keeping the place on screen. Opened at a
 * message, it fetches back until it has it, then scrolls to it and flashes
 * it, or the message drawn nearest to it when it draws nothing itself.
 */
export const Timeline = memo(function Timeline({
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
  const today = useToday();
  const list = useRef<LegendListRef>(null);
  const [behind, setBehind] = useState(false);
  const [loading, setLoading] = useState(messages.length === 0 && agent.latest !== null);
  const [flashing, setFlashing] = useState<string | null>(null);
  const [openedAt] = useState(() => Date.now() - CLOCK_SLACK_MS);
  const older = useRef<"more" | "loading" | "none">("more");
  // The rows that stay drawn wherever the chat is scrolled to: those that have shown a page, and the newest, as in T3 Code, so the list has measured the end before the chat glides to it.
  const [kept, setKept] = useState<string[]>([]);
  const keep = useCallback((message: Message) => setKept((ids) => (ids.includes(message.id) ? ids : [...ids, message.id])), []);
  const pinned = useMemo(() => ({ keys: kept, bottom: 1 }), [kept]);

  useEffect(() => {
    loadMessages(agent.id)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [agent.id]);

  // What the agent and another said to each other shows as one line for each exchange, where the newest thing in it was asked.
  const standings = useMemo(() => new Map(exchanges(messages).map((exchange) => standingOf(exchange, messages)).map(({ asked, state }) => [asked.id, state])), [messages]);
  const shown = useMemo(() => messages.filter((message) => !betweenAgents(message) || standings.has(message.id)), [messages, standings]);
  const rows = useMemo(
    () =>
      shown.flatMap((message, index): Row[] => {
        const before = shown[index - 1];
        return !before || !sameDay(before.created_at, message.created_at) ? [{ id: `day:${message.id}`, day: message.created_at }, message] : [message];
      }),
    [shown],
  );
  // When rows land above what is on screen, as a page fetched from the top or one the panel fetched, the list holds the first message on screen where it is. It has to be told while it still has the rows from before, which is as they are drawn here, ahead of it. It then moves with each height it measures above the message, in the frame it measures it.
  const had = useRef(rows);
  if (had.current[0]?.id !== rows[0]?.id) {
    const at = list.current;
    const first = at && had.current.slice(at.getState().start ?? 0).find((row) => !isDay(row));
    if (first) at.anchorVisibleContent({ key: first.id });
  }
  had.current = rows;
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  const newestMine = messages.findLast((message) => message.sender === "person")?.id;
  // Whether the agent waits on the person's answer to an ask of its own, which is then the last thing in the chat.
  const asksPerson = messages.some((message) => message.ask === "waiting" && message.agent_id === agent.id);
  const working = agent.working && online && !asksPerson;
  // The faded copy goes once the server's copy is in the chat, which may come over the event stream first.
  const sending = outgoing && outgoing.after === newestMine ? outgoing : null;
  const around = useMemo<Around>(
    () => ({ agentId: agent.id, standings, byId, newestMine, flashing, today, openedAt, onReply, onPage: keep }),
    [agent.id, standings, byId, newestMine, flashing, today, openedAt, onReply, keep],
  );

  // Counts the scrolls of the chat's own and the person's, so one the person takes over, or a later one of the chat's own, ends the one before.
  const scrolls = useRef(0);
  const toEnd = useCallback(async (smooth = false) => {
    const at = list.current;
    if (!at) return;
    setBehind(false);
    const mine = ++scrolls.current;
    const over = () => mine !== scrolls.current;
    const { contentLength, distanceFromEnd, scrollLength } = at.getState();
    // A long way back, the chat jumps to a screen short of the end, and glides the rest once the page has taken the jump.
    if (smooth && distanceFromEnd > scrollLength * 2) {
      await at.scrollToOffset({ offset: contentLength - scrollLength * 2, animated: false });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (over()) return;
    }
    await settle(at, at.scrollToEnd({ animated: smooth }), endOf, over);
  }, []);
  useEffect(() => {
    handle.current = { toEnd: () => void toEnd() };
  }, [handle, toEnd]);

  const fetchOlder = useCallback(() => {
    if (older.current !== "more") return;
    older.current = "loading";
    return loadOlder(agent.id).then(
      (more) => void (older.current = more ? "more" : "none"),
      () => void (older.current = "more"),
    );
  }, [agent.id]);

  // Something new at the end while the person reads further up shows the button that jumps to it, until they are back at the end.
  const newest = shown.at(-1)?.id;
  const seenNewest = useRef(newest);
  useEffect(() => {
    if (newest === seenNewest.current) return;
    seenNewest.current = newest;
    if (list.current?.getState().isWithinMaintainScrollAtEndThreshold === false) setBehind(true);
  }, [newest]);
  useEffect(() => list.current?.getState().listen("isWithinMaintainScrollAtEndThreshold", (atEnd) => atEnd && setBehind(false)), []);

  // Opened at a message, the chat fetches back until it has it, or until its beginning. A message that draws no row, as a turn that ended without a reply, is opened at the nearest row to it, the one before it first.
  const held = useRef({ messages, shown });
  held.current = { messages, shown };
  useEffect(() => {
    const id = opened?.agentId === agent.id ? opened.messageId : undefined;
    if (!id || loading) return;
    let going = true;
    (async () => {
      while (going && !held.current.messages.some((message) => message.id === id)) {
        const more = await loadOlder(agent.id).catch(() => false);
        if (!more) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const { messages, shown } = held.current;
      const at = list.current;
      const index = going ? messages.findIndex((message) => message.id === id) : -1;
      if (!at || index < 0) return;
      const drawn = (message: Message | undefined) => (message && drawnAs(message) !== "nothing" && shown.includes(message) ? message : undefined);
      let nearest: Message | undefined;
      for (let step = 0; !nearest && step < messages.length; step++) nearest = drawn(messages[index - step]) ?? drawn(messages[index + step]);
      if (!nearest) return;
      const { id: key } = nearest;
      const mine = ++scrolls.current;
      // The middle of the room, as the page measures the row.
      await settle(
        at,
        at.scrollToKey({ key, viewPosition: 0.5, animated: false }),
        (scroller) => {
          const row = scroller.querySelector(`[data-message-id="${CSS.escape(key)}"]`)?.getBoundingClientRect();
          return row && Math.max(0, Math.min(endOf(scroller), scroller.scrollTop + row.top - scroller.getBoundingClientRect().top - (scroller.clientHeight - row.height) / 2));
        },
        () => !going || mine !== scrolls.current,
      );
      if (!going) return;
      setFlashing(nearest.id);
      setTimeout(() => going && setFlashing(null), FLASH_MS);
    })();
    return () => {
      going = false;
    };
  }, [opened, agent.id, loading]);

  // The arrow keys move focus from message to message, the first time to the newest one on screen, so the keyboard reaches each message's Reply and menu.
  const stepFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key !== "ArrowUp" && event.key !== "ArrowDown") || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const at = list.current;
    const scroller = event.currentTarget;
    const target = event.target as HTMLElement;
    const focused = target.dataset.messageRow === undefined ? -1 : rows.findIndex((row) => row.id === target.dataset.messageId);
    if (!at || (focused < 0 && target !== scroller)) return;
    const takesFocus = (row: Row) => !isDay(row) && !standings.has(row.id) && drawnAs(row) === "message";
    const step = event.key === "ArrowDown" ? 1 : -1;
    let next = focused < 0 ? (at.getState().end ?? -1) : focused + step;
    while (rows[next] && !takesFocus(rows[next])) next += focused < 0 ? -1 : step;
    const message = rows[next];
    if (!message) return;
    event.preventDefault();
    void at.scrollIndexIntoView({ index: next, animated: false }).then(() => scroller.querySelector<HTMLElement>(`[data-message-row][data-message-id="${CSS.escape(message.id)}"]`)?.focus({ preventScroll: true }));
  };

  useEffect(() => {
    for (const message of shown) if (message.created_at >= openedAt) arrived.add(message.id);
  }, [shown, openedAt]);

  const empty = !agent.latest && messages.length === 0 && !sending;

  return (
    <div className="relative min-h-0 flex-1">
      <LegendList<Row>
        ref={list}
        data={rows}
        extraData={around}
        keyExtractor={idOf}
        getItemType={rowKind}
        renderItem={drawRow}
        recycleItems={false}
        estimatedItemSize={ROW_HEIGHT}
        initialScrollAtEnd
        alignItemsAtEnd
        maintainScrollAtEnd
        maintainScrollAtEndThreshold={AT_END}
        alwaysRender={pinned}
        onStartReached={fetchOlder}
        onStartReachedThreshold={NEAR_TOP}
        onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => onScrolled(event.nativeEvent.contentOffset.y > 0)}
        onUserScroll={() => void scrolls.current++}
        onKeyDown={stepFocus}
        tabIndex={0}
        className={cn("h-full focus-visible:-outline-offset-2", ROWS_DRAW_PAST_THEIR_EDGE)}
        style={SCROLLER}
        contentContainerClassName="mx-auto max-w-chat"
        contentContainerStyle={COLUMN}
        data-testid="timeline"
        aria-label="Messages"
        role="log"
        ListHeaderComponent={UNDER_BAR}
        ListEmptyComponent={<div className="grid flex-1 place-items-center text-ink3">{loading ? <Spinner label="Loading messages" /> : null}</div>}
        ListFooterComponent={
          <div className="px-4 pb-3">
            {/* A new agent's chat says what to do first. Its instructions have it ask what it's for. */}
            {empty ? (
              <p className="mb-2 animate-fade-in px-6 text-center text-message text-ink2" data-testid="new-agent-hint">
                {agent.name} is new. Tell it what it's for.
              </p>
            ) : null}
            {sending ? <OutgoingRow outgoing={sending} /> : null}
            {working ? <WorkingLine /> : null}
          </div>
        }
      />
      <button
        type="button"
        onClick={() => void toEnd(true)}
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
});
