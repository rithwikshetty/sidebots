import type { PanelView } from "../lib/view.ts";
import { AgentPage, AgentTitle } from "./AgentPage.tsx";
import { ExchangeTitle, ExchangeView } from "./ExchangeView.tsx";
import { Images, ImagesActions, ImagesTitle } from "./Images.tsx";
import { Note, NoteTitle } from "./Note.tsx";
import { Page, PageActions } from "./Page.tsx";

/** The title the panel's top bar shows for what it shows. */
export function PanelTitle({ view }: { view: PanelView }) {
  if (view.kind === "page") return view.title;
  if (view.kind === "note") return <NoteTitle agentId={view.agentId} />;
  if (view.kind === "exchange") return <ExchangeTitle view={view} />;
  if (view.kind === "images") return <ImagesTitle view={view} />;
  return <AgentTitle agentId={view.agentId} />;
}

/** The buttons the panel's top bar shows before Close, for what can be done with what it shows. */
export function PanelActions({ view }: { view: PanelView }) {
  if (view.kind === "page") return <PageActions view={view} />;
  if (view.kind === "images") return <ImagesActions view={view} />;
  return null;
}

/** What the panel at the right shows, under its top bar. */
export function Panel({ view }: { view: PanelView }) {
  if (view.kind === "agent") return <AgentPage agentId={view.agentId} tab={view.tab} />;
  if (view.kind === "note") return <Note key={view.note.kind === "memory" ? view.note.name : view.note.kind} view={view} />;
  if (view.kind === "exchange") return <ExchangeView key={view.messageId} view={view} />;
  if (view.kind === "images") return <Images view={view} />;
  return <Page key={view.path} view={view} />;
}
