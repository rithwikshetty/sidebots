import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { LegendList, type LegendListRef, type LegendListRenderItemProps } from "@legendapp/list/react";
import { ArrowDown } from "lucide-react";
import { betweenAgents, exchanges, type AgentWithLatest, type Message } from "@server/contract.ts";
import { standingOf, type Standing } from "@client/exchanges.ts";
import { dayLabel, sameDay } from "@client/time.ts";
import { cn } from "../lib/cn.ts";
import { backToNewest, loadMessages, loadOlder, newestPage, useHole, useMessages, useOnline } from "../lib/store.ts";
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
// How many frames a glide to the end is given to land on it.
const LANDING_FRAMES = 60;

// The messages that have come in with motion, so a row drawn again, as when it is scrolled back to or its chat is opened again, shows as it is.
const arrived = new Set<string>();

/** What the chat's foot can ask of its messages: to scroll to the newest. */
export type TimelineHandle = { toEnd: () => void };

/** The day above the first message of a day. It is a row of its own, so it comes and goes as pages load without the message under it changing height. */
type Day = { id: string; day: number };
/** The person's message on its way. It is the chat's last row until the server's copy takes its place, so the list follows it as it does any message. */
type Going = { id: string; outgoing: Outgoing };
/** The hole after a stretch of the chat from further back, which fetches the next run of the chat once it is drawn. `after` is the last message before it. */
type Hole = { id: string; after: string };
type Row = Message | Day | Going | Hole;
const isDay = (row: Row): row is Day => "day" in row;
const isGoing = (row: Row): row is Going => "outgoing" in row;
const isHole = (row: Row): row is Hole => "after" in row;

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
  onPageShown: (message: Message) => void;
  /** Whether a hole that is drawn fetches the run after it. While the chat lands on a message it was opened at, the list can draw the hole for a moment on its way. */
  fills: boolean;
};

const idOf = (row: Row) => row.id;

/** The kind a row is. The list takes a row it hasn't measured to be as tall as the others of its kind: a message is of a kind with those of its sender, under 2,000 characters or under 4,000, with files or without. A longer message's height says little about another's, so each is a kind of its own. */
function rowKind(row: Row): string {
  if (isDay(row)) return "day";
  if (isGoing(row)) return "going";
  if (isHole(row)) return "hole";
  if (betweenAgents(row)) return "exchange";
  const drawn = drawnAs(row);
  if (drawn !== "message") return drawn;
  const { length } = row.body;
  return length < 4000 ? `${row.sender}:${length < 2000 ? "short" : "long"}:${row.attachments.length > 0 ? "files" : "words"}` : row.id;
}

/** A row as it is drawn: a day, a message, the exchange a message was last asked in, the person's message on its way, or the hole after a stretch from further back. */
function drawRow({ item: row, extraData }: LegendListRenderItemProps<Row>) {
  const { agentId, standings, byId, newestMine, flashing, today, openedAt, onReply, onPageShown, fills } = extraData as Around;
  if (isHole(row)) return <HoleRow agentId={agentId} after={row.after} fills={fills} />;
  if (isDay(row)) {
    return (
      <p className="mt-4 px-4 text-center text-sm font-medium text-ink2" data-testid="day" data-day={row.id}>
        {dayLabel(row.day, today)}
      </p>
    );
  }
  if (isGoing(row)) {
    return (
      <div className="px-4">
        <OutgoingRow outgoing={row.outgoing} />
      </div>
    );
  }
  const message = row;
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
          onPageShown={onPageShown}
        />
      )}
    </div>
  );
}

/** The hole after a stretch from further back, drawn as the person scrolls down to it, which fetches the run of the chat after the stretch, and again when the computer is back in reach. The list can draw it a moment after the chat has let the stretch go, and then it fetches nothing. */
function HoleRow({ agentId, after, fills }: { agentId: string; after: string; fills: boolean }) {
  const online = useOnline();
  const open = useHole(agentId) === after;
  useEffect(() => void (online && fills && open && loadOlder(agentId, after).catch(() => undefined)), [agentId, after, online, fills, open]);
  return (
    <div className="grid h-16 place-items-center text-ink3" data-testid="hole">
      <Spinner label="Loading messages" />
    </div>
  );
}

/**
 * Lands a glide to the chat's end on the end. The list aims the glide by the
 * heights it guesses for rows it hasn't drawn, so when messages came in
 * unseen it stops short, and goes on waiting to reach a place that isn't
 * there. Once the glide has stopped, by the list's word or the page's, the
 * list is put at the end as the page measures it, as T3 Code does, until it
 * has stayed there for two frames or `over` says the scroll is no longer the
 * chat's.
 */
async function landAtEnd(list: LegendListRef, glide: Promise<void>, over: () => boolean): Promise<void> {
  const stopped = new AbortController();
  await Promise.race([glide, new Promise((resolve) => list.getScrollableNode()?.addEventListener("scrollend", resolve, { once: true, signal: stopped.signal }))]);
  stopped.abort();
  for (let frames = 0, still = 0; frames < LANDING_FRAMES && still < 2 && !over(); frames++) {
    const scroller = list.getScrollableNode();
    if (!scroller) return;
    const end = scroller.scrollHeight - scroller.clientHeight;
    if (Math.abs(scroller.scrollTop - end) > 1) {
      still = 0;
      await list.scrollToOffset({ offset: end, animated: false });
    } else still++;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

// The list cuts each row off at its own edge, with `contain: paint` in the style of the element that holds it, which would take the bottom of a message's focus ring and the start of its rise into place. Those elements, under the scroller, its content and its rows' box, keep their layout to themselves and draw past their edge.
const ROWS_DRAW_PAST_THEIR_EDGE = "[&>div>div>div[style*='contain']]:[contain:layout_style]!";
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
 * message it doesn't hold, it fetches the run of the chat from it, then
 * scrolls to it and flashes it, or the message drawn nearest to it when it
 * draws nothing itself. A run that doesn't reach the newest messages is a
 * stretch with a hole after it: the chat draws the stretch, fetches the next
 * run as the person scrolls down to the hole, and goes back to the newest
 * messages from Jump to latest.
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
  const chat = useMessages(agent.id);
  const hole = useHole(agent.id);
  // With a hole in the chat, the timeline draws the stretch before it, which pages down across the hole, and the chat's newest messages wait beyond it.
  const messages = useMemo(() => (hole === undefined ? chat : chat.slice(0, chat.findIndex((message) => message.id === hole) + 1)), [chat, hole]);
  const opened = useOpenChat();
  const today = useToday();
  const list = useRef<LegendListRef>(null);
  const [behind, setBehind] = useState(false);
  const [loading, setLoading] = useState(messages.length === 0 && agent.latest !== null);
  const [flashing, setFlashing] = useState<string | null>(null);
  // Whether the chat is on its way to a message it was opened at.
  const [landing, setLanding] = useState(false);
  const [openedAt] = useState(() => Date.now() - CLOCK_SLACK_MS);
  // A chat that opens with messages, or with some to fetch, opens at its end. One with none has no end to open at, and a list still waiting to open at one draws the first row it is given a frame late, after the copy of the message on its way has gone.
  const [opensAtEnd] = useState(() => messages.length > 0 || agent.latest !== null);
  // The oldest message the window holds that has nothing before it, once a page fetched before it came back empty.
  const first = useRef<string | null>(null);
  // The rows that have shown a page.
  const [kept, setKept] = useState<string[]>([]);
  const keep = useCallback((message: Message) => setKept((ids) => (ids.includes(message.id) ? ids : [...ids, message.id])), []);
  // They stay drawn wherever the chat is scrolled to, so each page stays as the person left it. So does the newest row, as in T3 Code, so the list has measured the end before the chat glides to it, except a hole's, which is drawn only once the person scrolls down to it.
  const pinned = useMemo(() => ({ keys: kept, bottom: hole === undefined ? 1 : 0 }), [kept, hole]);

  useEffect(() => {
    loadMessages(agent.id)
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [agent.id]);

  // What the agent and another said to each other shows as one line for each exchange, where the newest thing in it was asked.
  const standings = useMemo(() => new Map(exchanges(messages).map((exchange) => standingOf(exchange, messages)).map(({ asked, state }) => [asked.id, state])), [messages]);
  const shown = useMemo(() => messages.filter((message) => !betweenAgents(message) || standings.has(message.id)), [messages, standings]);
  // The person's newest message, which carries the chat's receipt.
  const newestMine = chat.findLast((message) => message.sender === "person")?.id;
  // The faded copy goes once the server's copy is in the chat, which may come over the event stream first.
  const sending = outgoing && outgoing.after === newestMine ? outgoing : null;
  const rows = useMemo(() => {
    const rows = shown.flatMap((message, index): Row[] => {
      const before = shown[index - 1];
      return !before || !sameDay(before.created_at, message.created_at) ? [{ id: `day:${message.id}`, day: message.created_at }, message] : [message];
    });
    if (hole !== undefined) return [...rows, { id: "hole", after: hole }];
    return sending ? [...rows, { id: "going", outgoing: sending }] : rows;
  }, [shown, sending, hole]);
  // The list takes the rows once it has been told what to hold. When rows land above what is on screen, as a page fetched from the top or one the panel fetched, it holds the first message on screen where it is, and moves with each height it measures above it, in the frame it measures it. Left to keep the place by itself, it moves the scroll a frame after the rows, and draws that frame out of place. At the chat's end it follows the end.
  const [listed, setListed] = useState(rows);
  useLayoutEffect(() => {
    const at = list.current;
    if (at && listed[0]?.id !== rows[0]?.id && at.getState().isWithinMaintainScrollAtEndThreshold === false) {
      const stays = new Set(rows.map(idOf));
      const first = listed.slice(at.getState().start ?? 0).find((row) => !isDay(row) && stays.has(row.id));
      if (first) at.anchorVisibleContent({ key: first.id });
    }
    setListed(rows);
  }, [rows, listed]);
  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages]);
  // Whether the agent waits on the person's answer to an ask of its own, which is then the last thing in the chat.
  const asksPerson = chat.some((message) => message.ask === "waiting" && message.agent_id === agent.id);
  const working = agent.working && online && !asksPerson && hole === undefined;
  const around = useMemo<Around>(
    () => ({ agentId: agent.id, standings, byId, newestMine, flashing, today, openedAt, onReply, onPageShown: keep, fills: !landing }),
    [agent.id, standings, byId, newestMine, flashing, today, openedAt, onReply, keep, landing],
  );

  // Counts the chat's own scrolls and the person's, so a glide to the end that the person takes over, or that a later scroll follows, is left where it is.
  const scrolls = useRef(0);
  const toEnd = useCallback(async (smooth = false) => {
    const at = list.current;
    if (!at) return;
    setBehind(false);
    const mine = ++scrolls.current;
    // A stretch from further back goes, and the chat is at the end of its newest messages at once.
    const stretch = held.current.hole !== undefined;
    if (stretch) backToNewest(agent.id);
    if (!smooth || stretch) return void at.scrollToEnd({ animated: false });
    const over = () => mine !== scrolls.current;
    const { contentLength, distanceFromEnd, scrollLength } = at.getState();
    // A long way back, the chat jumps to a screen short of the end, and glides the rest once the page has taken the jump.
    if (distanceFromEnd > scrollLength * 2) {
      await at.scrollToOffset({ offset: contentLength - scrollLength * 2, animated: false });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (over()) return;
    }
    await landAtEnd(at, at.scrollToEnd({ animated: true }), over);
  }, [agent.id]);
  useEffect(() => {
    handle.current = { toEnd: () => void toEnd() };
  }, [handle, toEnd]);

  // The page before the oldest message the window holds. With none yet, as while the first page is on its way, there is nothing to fetch before.
  const fetchOlder = useCallback(() => {
    const oldest = held.current.messages[0]?.id;
    if (oldest && oldest !== first.current) return loadOlder(agent.id).then((more) => void (more || (first.current = oldest)), () => undefined);
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

  // Opened at a message it doesn't draw, the chat fetches the run of the chat from it, or, when it is among the newest messages past a hole, goes back to them. Opened at the oldest message it draws, it fetches the page before too, so the message has rows above it. A message that draws no row, as a turn that ended without a reply, is opened at the nearest row to it, the one before it first. Opened again before a run has come, the chat lets that run go, so it can't land over the chat as it is opened now.
  const held = useRef({ chat, messages, shown, hole });
  held.current = { chat, messages, shown, hole };
  useEffect(() => {
    const id = opened?.agentId === agent.id ? opened.messageId : undefined;
    if (!id) return;
    let going = true;
    let fetching = false;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const isIt = (message: Message) => message.id === id;
    setLanding(true);
    void (async () => {
      // The chat lands once its newest page has come, as when it opens or catches up on reconnecting: a newest page that doesn't join what the chat held takes the place of all of it, a run fetched before it too. What it holds is read a frame on, once a run the last landing let go of has gone from it.
      await newestPage(agent.id);
      await frame();
      if (!going) return;
      if (!held.current.messages.some(isIt)) {
        if (held.current.chat.some(isIt)) backToNewest(agent.id);
        else {
          fetching = true;
          await loadOlder(agent.id, id).catch(() => false);
          fetching = false;
        }
        await frame();
      }
      if (going && held.current.messages[0]?.id === id) {
        await fetchOlder();
        await frame();
      }
      const { messages, shown } = held.current;
      const at = list.current;
      const index = going ? messages.findIndex((message) => message.id === id) : -1;
      if (!at || index < 0) return;
      const drawn = (message: Message | undefined) => (message && drawnAs(message) !== "nothing" && shown.includes(message) ? message : undefined);
      let nearest: Message | undefined;
      for (let step = 0; !nearest && step < messages.length; step++) nearest = drawn(messages[index - step]) ?? drawn(messages[index + step]);
      if (!nearest) return;
      scrolls.current++;
      await at.scrollToKey({ key: nearest.id, viewPosition: 0.5, animated: false });
      if (!going) return;
      setFlashing(nearest.id);
      setTimeout(() => going && setFlashing(null), FLASH_MS);
    })().finally(() => going && setLanding(false));
    return () => {
      going = false;
      if (fetching) backToNewest(agent.id);
      setLanding(false);
    };
  }, [opened, agent.id, fetchOlder]);

  // The arrow keys move focus from message to message, the first time to the newest one on screen, so the keyboard reaches each message's Reply and menu.
  const stepFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key !== "ArrowUp" && event.key !== "ArrowDown") || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const at = list.current;
    const scroller = event.currentTarget;
    const target = event.target as HTMLElement;
    const focused = target.dataset.messageRow === undefined ? -1 : listed.findIndex((row) => row.id === target.dataset.messageId);
    if (!at || (focused < 0 && target !== scroller)) return;
    const takesFocus = (row: Row) => !isDay(row) && !isGoing(row) && !isHole(row) && !standings.has(row.id) && drawnAs(row) === "message";
    const step = event.key === "ArrowDown" ? 1 : -1;
    let next = focused < 0 ? (at.getState().end ?? -1) : focused + step;
    while (listed[next] && !takesFocus(listed[next])) next += focused < 0 ? -1 : step;
    const message = listed[next];
    if (!message) return;
    event.preventDefault();
    // A row that is drawn takes focus at once, and one further off once the list has scrolled to it and drawn it.
    const focus = () => scroller.querySelector<HTMLElement>(`[data-message-row][data-message-id="${CSS.escape(message.id)}"]`)?.focus({ preventScroll: true });
    focus();
    void at.scrollItemIntoView({ item: message, animated: false }).then(focus);
  };

  // A message that has come in is drawn with its motion once. The list draws its row after this has run, so it counts as arrived from the frame after.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      for (const message of shown) if (message.created_at >= openedAt) arrived.add(message.id);
    });
    return () => cancelAnimationFrame(frame);
  }, [shown, openedAt]);
  const empty = !agent.latest && messages.length === 0 && !sending;
  // The way to the newest message shows once something comes while the person reads further up, and all the while the chat draws a stretch from further back.
  const offered = behind || hole !== undefined;

  return (
    <div className="relative min-h-0 flex-1">
      <LegendList<Row>
        ref={list}
        data={listed}
        extraData={around}
        keyExtractor={idOf}
        getItemType={rowKind}
        renderItem={drawRow}
        recycleItems={false}
        estimatedItemSize={ROW_HEIGHT}
        initialScrollAtEnd={opensAtEnd}
        alignItemsAtEnd
        // Past a stretch from further back, the end is its hole, which the chat doesn't follow.
        maintainScrollAtEnd={hole === undefined}
        maintainScrollAtEndThreshold={AT_END}
        alwaysRender={pinned}
        onStartReached={fetchOlder}
        onStartReachedThreshold={NEAR_TOP}
        onScroll={(event) => onScrolled(event.nativeEvent.contentOffset.y > 0)}
        onUserScroll={() => void scrolls.current++}
        onKeyDown={stepFocus}
        tabIndex={0}
        showsHorizontalScrollIndicator={false}
        className={cn("h-full focus-visible:-outline-offset-2", ROWS_DRAW_PAST_THEIR_EDGE)}
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
            {working ? <WorkingLine /> : null}
          </div>
        }
      />
      <button
        type="button"
        onClick={() => void toEnd(true)}
        tabIndex={offered ? 0 : -1}
        aria-hidden={!offered}
        className={cn(
          "absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full bg-raised pr-3.5 pl-3 text-sm font-medium text-ink shadow-menu transition-[opacity,translate,scale] duration-200 ease-out hover:bg-[color-mix(in_srgb,var(--raised),var(--ink)_4%)] active:scale-95",
          offered ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0",
        )}
        data-testid="jump-to-latest"
      >
        <ArrowDown aria-hidden className="size-4" strokeWidth={2.25} />
        Jump to latest
      </button>
    </div>
  );
});
