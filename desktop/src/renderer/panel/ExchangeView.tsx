import { useEffect, useMemo, useRef } from "react";
import { exchanges, type AgentWithLatest, type Message } from "@server/contract.ts";
import { standingOf, type Standing } from "@client/exchanges.ts";
import { isImage, isPage } from "@client/files.ts";
import { AskAnswer, AskCard } from "../chat/AskCard.tsx";
import { FileCard, PageCard, Photos } from "../chat/Attachments.tsx";
import { Bubble } from "../chat/Bubble.tsx";
import { Markdown } from "../chat/Markdown.tsx";
import { FlowDots } from "../chat/WorkingLine.tsx";
import { cn } from "../lib/cn.ts";
import { loadOlder, useAgent, useChatColor, useMessages } from "../lib/store.ts";
import { useReducedMotion } from "../lib/window.ts";
import { Avatar } from "../ui/Avatar.tsx";

type ExchangeView = { agentId: string; messageId: string };

/**
 * The exchange a message is in, in the chat it was opened from, with what
 * the two agents said, the asks for the person's OK that came in the middle,
 * and where it stands. The agent that asked first is `first`. Null once the
 * message is no longer in the chat, or either agent is gone.
 */
function useExchange({ agentId, messageId }: ExchangeView) {
  const messages = useMessages(agentId);
  const exchange = useMemo(() => exchanges(messages).find((each) => each.some((said) => said.id === messageId)), [messages, messageId]);
  const missing = messages.length > 0 && !messages.some((message) => message.id === messageId);
  // A message from further back than the chat has fetched, when the panel opens, comes with the run of the chat from it. When the chat lets it go later, as at Jump to latest, the panel lets the exchange go too.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (messages.length === 0 || opened.current === messageId) return;
    opened.current = messageId;
    if (missing) loadOlder(agentId, messageId).catch(() => undefined);
  }, [missing, agentId, messageId, messages.length]);
  const first = useAgent(exchange?.[0].agent_id ?? "");
  const other = useAgent(exchange?.[0].peer_id ?? "");
  const shown = useMemo(() => (exchange ? withAsks(exchange, messages) : []), [exchange, messages]);
  if (!exchange || !first || !other) return null;
  const { asked, state } = standingOf(exchange, messages);
  // The title reads as the chat's line does: from the agent that asked last to the one it asked.
  const [from, to] = asked.agent_id === first.id ? [first, other] : [other, first];
  return { shown, first, other, from, to, state };
}

/**
 * What an exchange shows, oldest first: what the two agents said, and each
 * ask for the person's OK that either raised while working for the other in
 * the time it ran.
 */
function withAsks(exchange: Message[], messages: Message[]): Message[] {
  const pair = new Set([exchange[0].agent_id, exchange[0].peer_id]);
  const start = exchange[0].created_at;
  const { state } = standingOf(exchange, messages);
  const end = state === "Answered" ? exchange[exchange.length - 1].created_at : Infinity;
  const asks = messages.filter((message) => message.ask !== null && pair.has(message.agent_id) && pair.has(message.peer_id) && message.created_at >= start && message.created_at <= end);
  return [...exchange, ...asks].sort((a, b) => a.created_at - b.created_at);
}

/** The exchange's title in the panel's top bar: the two agents' avatars with the line between them, and their names. */
export function ExchangeTitle({ view }: { view: ExchangeView }) {
  const exchange = useExchange(view);
  if (!exchange) return null;
  const { from, to, state } = exchange;
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Avatar avatarId={from.avatar_id} state="resting" size={32} />
      <FlowDots count={4} size={3} running={state === "Waiting"} className={cn("w-5", state === "Waiting" ? "text-ink2" : "text-ink3")} />
      <Avatar avatarId={to.avatar_id} state="resting" size={32} />
      <span className="ml-1 truncate">
        {from.name} and {to.name}
      </span>
    </span>
  );
}

/**
 * An exchange between two of the person's agents, to read in full: a chat of
 * the two agents' own, with no message field, since nothing in it is the
 * person's to say. The agent that asked first has the right and its chat's
 * colour, as the person has in their own. While the newest thing asked has no
 * answer, a line at the foot says where it stands. It follows what the two
 * say as they say it.
 */
export function ExchangeView({ view }: { view: ExchangeView }) {
  const exchange = useExchange(view);
  const color = useChatColor(exchange?.first);
  const foot = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const said = exchange?.shown.length ?? 0;
  const opened = useRef(false);

  // It opens at its newest message, and scrolls to each one that comes.
  useEffect(() => {
    if (!said) return;
    foot.current?.scrollIntoView({ block: "end", behavior: opened.current && !reduced ? "smooth" : "auto" });
    opened.current = true;
  }, [said, exchange?.state, reduced]);

  if (!exchange) return null;
  const { shown, first, other, to, state } = exchange;
  return (
    <div className="flex min-h-full flex-col justify-end gap-1.5 px-3 pt-2 pb-4" data-testid="exchange">
      {shown.map((message) => (
        <Said key={message.id} message={message} by={message.agent_id === first.id ? first : other} mine={message.agent_id === first.id} color={color} />
      ))}
      <div ref={foot} className="min-h-6">
        <Where state={state} to={to} />
      </div>
    </div>
  );
}

/**
 * One message of the exchange beside the avatar of the agent that said it:
 * its pictures, pages and files above its bubble, and its words in the
 * bubble. An ask for the person's OK is on the neutral bubble at the start,
 * whichever agent raised it, with its card in place of the words and Allow
 * and Don't allow while it waits.
 */
function Said({ message, by, mine, color }: { message: Message; by: AgentWithLatest; mine: boolean; color: string | null }) {
  const end = mine && !message.question;
  const photos = message.attachments.filter((path) => isImage(path));
  const pages = message.attachments.filter((path) => isPage(path));
  const files = message.attachments.filter((path) => !isImage(path) && !isPage(path));
  return (
    <div className={cn("flex items-end gap-2", end && "flex-row-reverse")} data-testid="exchange-message" data-side={end ? "end" : "start"}>
      <Avatar avatarId={by.avatar_id} state="resting" size={32} label={by.name} className="mb-0.5" />
      <div className={cn("flex min-w-0 flex-1 flex-col gap-1", end ? "items-end" : "items-start")}>
        {photos.length ? <Photos agentId={message.agent_id} paths={photos} end={end} /> : null}
        {pages.map((path) => (
          <PageCard key={path} agentId={message.agent_id} path={path} />
        ))}
        {files.map((path) => (
          <FileCard key={path} agentId={message.agent_id} path={path} />
        ))}
        {message.question ? (
          <Bubble side="start" className="max-w-full">
            <AskCard question={message.question} from={message.agent_id} />
            {message.ask ? <AskAnswer message={message} ask={message.ask} /> : null}
          </Bubble>
        ) : message.body ? (
          <Bubble side={end ? "end" : "start"} color={end && color ? color : undefined} className="max-w-[85%]">
            <Markdown text={message.body} onColor={end} />
          </Bubble>
        ) : null}
      </div>
    </div>
  );
}

/** Where the exchange stands, at its foot, while its newest question has no answer. */
function Where({ state, to }: { state: Standing; to: AgentWithLatest }) {
  if (state === "Answered") return null;
  return (
    <div role="status" data-testid="exchange-state" className="mt-2.5 flex animate-fade-in items-center gap-2 pl-1 text-ink2">
      <FlowDots count={3} size={4} running={state === "Waiting"} className="gap-1" />
      <span className="text-message italic">{state === "Waiting" ? `Waiting on ${to.name}` : state}</span>
    </div>
  );
}
