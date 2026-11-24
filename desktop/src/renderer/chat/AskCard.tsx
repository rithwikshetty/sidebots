import { useState } from "react";
import { Cable, ChevronRight, FilePenLine, Globe, Plug, Terminal } from "lucide-react";
import { fenced, type Ask, type Message, type Question } from "@server/contract.ts";
import { problem } from "../lib/alerts.ts";
import { cn } from "../lib/cn.ts";
import { answerAsk, connect, useAgent, useConnections } from "../lib/store.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { BrandLogo } from "../ui/BrandLogo.tsx";
import { Button } from "../ui/Button.tsx";
import { Markdown } from "./Markdown.tsx";

const ICONS = { command: Terminal, page: Globe, file: FilePenLine, tool: Plug, connection: Cable };
// What an ask of each kind keeps behind its button, as the words after "Show" and "Hide". An ask for a connection keeps nothing there.
const DETAIL = { command: "the command", page: "the address", file: "the file", tool: "everything it was given", connection: "" };
// How an ask ended, as its bubble says it.
const ASKED: Record<Exclude<Ask, "waiting">, string> = { allowed: "Allowed", refused: "Not allowed", unanswered: "Not answered" };
// How an ask for a connection ended.
const CONNECTED: typeof ASKED = { allowed: "Connected", refused: "Not connected", unanswered: "Not connected" };

/**
 * What an agent asks to do, inside its bubble: the sort of thing it is, this
 * one in plain words, the facts that matter and the provider's reason for
 * asking. The thing itself, such as the command, opens with a button, so a
 * person reads words first and can still see all that Allow lets happen.
 * `from` is the agent that asks, for an ask shown in another agent's chat,
 * and the card then says whose it is. An ask for a connection wears the
 * connection's logo, once the window has the computer's list of them.
 */
export function AskCard({ question, from }: { question: Question; from?: string }) {
  const asker = useAgent(from ?? "");
  const [open, setOpen] = useState(false);
  const Icon = ICONS[question.kind];
  const logo = useConnections()?.find((each) => each.connection === question.connection)?.logo;
  return (
    <div data-selectable data-testid="ask-card">
      {asker ? (
        <div className="-ml-0.5 mb-1.5 flex items-center gap-1.5">
          <Avatar avatarId={asker.avatar_id} state="resting" size={16} />
          <span className="text-sm font-semibold text-ink2">{asker.name} asks</span>
        </div>
      ) : null}
      <div className="flex items-center gap-1.5 text-ink2">
        {logo ? <BrandLogo logo={logo} size={14} /> : <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={2.25} />}
        <span className="text-sm font-semibold">{question.title}</span>
      </div>
      <p className="mt-px mb-1.5 text-message font-semibold">{question.what}</p>
      {question.facts.map(([label, value]) => (
        <p key={label} className="text-sm">
          <span className="text-ink2">{label}</span>
          <span className="ml-2">{value}</span>
        </p>
      ))}
      {question.why ? <p className="mt-1.5 text-sm text-ink2">{question.why}</p> : null}
      {question.detail ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}
          className="-ml-1 mt-2 mb-2 flex items-center gap-0.5 rounded-sm px-1 py-0.5 text-sm font-semibold text-tint-ink transition-colors hover:bg-hover active:bg-press"
          data-testid="ask-detail"
        >
          <ChevronRight aria-hidden className={cn("size-3.5 transition-transform duration-200 ease-out", open && "rotate-90")} strokeWidth={2.25} />
          {open ? "Hide" : "Show"} {DETAIL[question.kind]}
        </button>
      ) : null}
      {open ? (
        <div className="animate-fade-in">
          <Markdown text={fenced(question.detail)} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * At the foot of an ask's bubble: Don't allow and Allow while the agent waits
 * for the person's answer, and how the ask ended once it has. The agent goes
 * on, or leaves the thing undone, as soon as one is pressed. An ask for a
 * connection has Not now and Connect, which takes the person through the
 * app's sign-in, and the agent goes on once they have signed in.
 */
export function AskAnswer({ message, ask }: { message: Message; ask: Ask }) {
  const [sending, setSending] = useState(false);
  const connection = message.question?.connection;
  if (ask !== "waiting") {
    return (
      <p key={ask} className="mb-0.5 animate-fade-in text-sm font-semibold text-ink2" data-testid="ask-outcome">
        {(connection ? CONNECTED : ASKED)[ask]}
      </p>
    );
  }
  const answer = (allow: boolean) => {
    setSending(true);
    (connection && allow ? connect(connection) : answerAsk(message, allow))
      .catch((failure) => problem(connection && allow ? "Couldn't connect" : "Couldn't answer", failure))
      .finally(() => setSending(false));
  };
  return (
    <div className="mt-0.5 mb-1.5 flex gap-2" data-testid="ask-answers">
      <Button size="lg" onClick={() => answer(false)} disabled={sending} className="min-w-28 flex-1 bg-canvas shadow-none hover:bg-canvas/80">
        {connection ? "Not now" : "Don't allow"}
      </Button>
      <Button size="lg" variant="primary" onClick={() => answer(true)} disabled={sending} className="min-w-28 flex-1 bg-chat">
        {connection ? "Connect" : "Allow"}
      </Button>
    </div>
  );
}
