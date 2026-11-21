import { useEffect } from "react";
import { ChevronLeft } from "lucide-react";
import { Markdown } from "../chat/Markdown.tsx";
import { loadAbout, useAbout, useAgent } from "../lib/store.ts";
import { openPanel } from "../lib/view.ts";
import { IconButton } from "../ui/Button.tsx";
import { Spinner } from "../ui/Spinner.tsx";

type NoteView = { agentId: string; note: { kind: "instructions" } | { kind: "memory"; name: string } };

/** The panel's top bar over a note: a button back to the agent's page, and the agent's name, where it goes back to. */
export function NoteTitle({ agentId }: { agentId: string }) {
  const agent = useAgent(agentId);
  return (
    <span className="flex min-w-0 items-center gap-1">
      <IconButton icon={ChevronLeft} label={agent ? `Back to ${agent.name}` : "Back"} className="-ml-1.5 focus-visible:-outline-offset-2" onClick={() => openPanel({ kind: "agent", agentId })} data-testid="note-back" />
      <span className="truncate">{agent?.name}</span>
    </span>
  );
}

/**
 * Something an agent wrote for itself, to read in full: the instructions it
 * follows, or one of the things it remembers. The agent writes both in
 * markdown, which shows as rich text, as its replies do.
 */
export function Note({ view }: { view: NoteView }) {
  const about = useAbout(view.agentId);
  const { note } = view;
  // The agent's page has fetched the note by the time it opens. One opened without the page fetches it here.
  useEffect(() => {
    if (!about) loadAbout(view.agentId).catch(() => undefined);
  }, [about, view.agentId]);
  const memory = note.kind === "memory" ? about?.memories.find((each) => each.name === note.name) : undefined;
  const title = note.kind === "memory" ? memory?.description || note.name : "Instructions";
  const body = note.kind === "memory" ? memory?.body : about?.instructions.trim();
  return (
    <article className="mx-auto flex w-full max-w-[640px] flex-col gap-3 px-5 pt-2 pb-8" data-testid="note">
      <h3 className="text-xl font-bold text-pretty" data-selectable>
        {title}
      </h3>
      {about ? body ? <Markdown text={body} /> : <p className="text-sm text-ink2">Nothing yet.</p> : <Spinner className="text-ink3" />}
    </article>
  );
}
