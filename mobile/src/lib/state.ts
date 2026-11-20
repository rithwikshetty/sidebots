// What the app knows: the person's agents, their messages and the avatars. The
// server is the source of truth; this copy is saved on the phone so chats open
// instantly and can be read offline.

import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { fetch as streamingFetch } from "expo/fetch";
import { File } from "expo-file-system";
import { Image } from "expo-image";
import Storage from "expo-sqlite/kv-store";
import * as WebBrowser from "expo-web-browser";
import type { About, Agent, AgentWithLatest, Avatar, Connected, Connection, Effort, Found, Message, Model, Provider, SignIn, StreamEvent, Usage } from "@server/contract";
import { ApiError, avatarSheet, behind, isPaired, onPairing, remote, request, unpair, type Behind } from "./api";
import { demoFetch, isDemo } from "./demo";
import type { Picked } from "./files";

type State = {
  agents: AgentWithLatest[];
  messages: Record<string, Message[]>;
  avatars: Avatar[];
  /** What each agent's page shows, for the agents whose page has been opened. */
  about: Record<string, About>;
  /** Where the person's plan or API credit goes, as the computer last said. Null until the phone has asked. */
  usage: Usage | null;
  /** The apps the person's agents can use as them, as the computer last listed them. Null until the phone has asked. */
  connections: Connected[] | null;
  /**
   * Changes to agents that the server hasn't taken yet. The app shows them
   * at once and keeps them on the phone, over whatever the server says, until
   * the server has them.
   */
  pending: Record<string, AgentChanges>;
  online: boolean;
  /** Which side to update when the computer speaks another version of the contract, or null while they match. */
  behind: Behind | null;
};

/** What the person can change about an agent. */
export type AgentChanges = { name?: string; avatarId?: string; model?: Model; effort?: Effort; muted?: boolean; hidden?: boolean; color?: string | null };

// The number changes when the shape of what is saved does.
const CACHE_KEY = "cache-6";
const SAVE_DELAY_MS = 300;
const NO_MESSAGES: Message[] = [];

function saved(): Partial<State> {
  try {
    return JSON.parse(Storage.getItemSync(CACHE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

const EMPTY = { agents: [], messages: {}, avatars: [], about: {}, usage: null, connections: null, pending: {} };

let state: State = { ...EMPTY, ...saved(), online: true, behind: null };
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { online: _online, behind: _behind, ...rest } = state;
    void Storage.setItem(CACHE_KEY, JSON.stringify(rest));
  }, SAVE_DELAY_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAgents(): AgentWithLatest[] {
  return useSyncExternalStore(subscribe, () => state.agents);
}

export function useAgent(id: string): AgentWithLatest | undefined {
  return useSyncExternalStore(subscribe, () => state.agents.find((agent) => agent.id === id));
}

export function useMessages(agentId: string): Message[] {
  return useSyncExternalStore(subscribe, () => state.messages[agentId] ?? NO_MESSAGES);
}

export function useAvatars(): Avatar[] {
  return useSyncExternalStore(subscribe, () => state.avatars);
}

/** The colour of an agent's chat: the one picked for it, or its avatar's. Null until the avatars have loaded. */
export function useChatColor(agent: Pick<Agent, "avatar_id" | "color"> | undefined): string | null {
  const avatars = useAvatars();
  if (!agent) return null;
  return agent.color ?? avatars.find((avatar) => avatar.id === agent.avatar_id)?.color ?? null;
}

export function useAbout(agentId: string): About | undefined {
  return useSyncExternalStore(subscribe, () => state.about[agentId]);
}

export function useUsage(): Usage | null {
  return useSyncExternalStore(subscribe, () => state.usage);
}

export function useConnections(): Connected[] | null {
  return useSyncExternalStore(subscribe, () => state.connections);
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => state.online);
}

export function useBehind(): Behind | null {
  return useSyncExternalStore(subscribe, () => state.behind);
}

const told = new Set<(agents: AgentWithLatest[]) => void>();

/**
 * Calls `listener` with the agents each time the computer has just said how
 * they are: with every event of its stream, and when the app catches up with
 * it. What the phone saved of them doesn't count. Returns a function that
 * stops it.
 */
export function onAgents(listener: (agents: AgentWithLatest[]) => void): () => void {
  told.add(listener);
  return () => told.delete(listener);
}

/** An agent as the server sent it, with the person's changes the server doesn't have yet laid over it. */
function withPending(agent: AgentWithLatest): AgentWithLatest {
  const changes = state.pending[agent.id];
  if (!changes) return agent;
  const { avatarId, ...rest } = changes;
  return { ...agent, ...rest, avatar_id: avatarId ?? agent.avatar_id };
}

function upsert(list: Message[], message: Message): Message[] {
  const at = list.findIndex((item) => item.id === message.id);
  return at < 0 ? [...list, message] : list.map((item, index) => (index === at ? message : item));
}

/** Takes in what the event stream says: a message and its agent, a new agent, or an agent that was deleted. */
function apply(event: StreamEvent): void {
  if ("deleted" in event) forget(event.deleted);
  else {
    const { message, agent } = event;
    const known = state.messages[agent.id];
    set({
      agents: [withPending(agent), ...state.agents.filter((item) => item.id !== agent.id)],
      messages: known && message ? { ...state.messages, [agent.id]: upsert(known, message) } : state.messages,
    });
  }
  told.forEach((listener) => listener(state.agents));
}

/** Lets go of everything the phone kept of an agent that is gone. */
function forget(agentId: string): void {
  const { [agentId]: _messages, ...messages } = state.messages;
  const { [agentId]: _about, ...about } = state.about;
  const { [agentId]: _pending, ...pending } = state.pending;
  set({ agents: state.agents.filter((agent) => agent.id !== agentId), messages, about, pending });
}

/**
 * Fetches the newest page of a chat. It joins onto the older messages already
 * saved when they run up to it. When the chat has moved on by more than a
 * page, the page stands alone and the chat pages back from there. An ask
 * never goes back to waiting, so one the phone knows has closed stays closed
 * when the page was fetched before it did.
 */
export async function loadMessages(agentId: string): Promise<void> {
  const fetched = await request<Message[]>(`/agents/${agentId}/messages`);
  if (fetched.length === 0) return;
  const known = state.messages[agentId] ?? NO_MESSAGES;
  const closed = (message: Message) => known.find((had) => had.id === message.id && had.ask && had.ask !== "waiting");
  const page = fetched.map((message) => (message.ask === "waiting" ? (closed(message) ?? message) : message));
  const joins = known.findIndex((message) => message.id === page[0].id);
  set({ messages: { ...state.messages, [agentId]: joins < 0 ? page : [...known.slice(0, joins), ...page] } });
}

/** Fetches the page before the oldest message the app has of a chat. False once the chat's beginning is reached. */
export async function loadOlder(agentId: string): Promise<boolean> {
  const oldest = state.messages[agentId]?.[0];
  if (!oldest) return false;
  const page = await request<Message[]>(`/agents/${agentId}/messages?before=${oldest.id}`);
  const known = state.messages[agentId] ?? NO_MESSAGES;
  if (page.length && known[0]?.id === oldest.id) set({ messages: { ...state.messages, [agentId]: [...page, ...known] } });
  return page.length > 0;
}

async function refresh(): Promise<void> {
  const [agents, avatars] = await Promise.all([request<AgentWithLatest[]>("/agents"), request<Avatar[]>("/avatars")]);
  // What the phone kept of an agent that is gone, as one deleted on another phone, goes with it.
  const kept = new Set(agents.map((agent) => agent.id));
  const ofKept = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([agentId]) => kept.has(agentId)));
  set({ pending: ofKept(state.pending), messages: ofKept(state.messages), about: ofKept(state.about) });
  set({ agents: agents.map(withPending), avatars });
  // The apps the agents can use come too, for the logo an ask for one wears. A computer that has none leaves the list as it was.
  void loadConnections().catch(() => undefined);
  told.forEach((listener) => listener(state.agents));
  keepSheets(avatars);
  // Changes made while the server was out of reach go now.
  for (const agentId of Object.keys(state.pending)) void sendChanges(agentId).catch(() => undefined);
  await Promise.all(Object.keys(state.messages).map(loadMessages));
}

/**
 * Saves every avatar's spritesheet on the phone, so an avatar the phone
 * hasn't drawn yet, as in the avatar picker, shows without a wait for the
 * computer. A sheet the phone already has isn't fetched again.
 */
function keepSheets(avatars: Avatar[]): void {
  const sheets = avatars.map((avatar) => avatarSheet(avatar.id));
  if (sheets.length === 0) return;
  void Image.prefetch(sheets.map((sheet) => sheet.uri), { cachePolicy: "disk", headers: sheets[0].headers }).catch(() => undefined);
}

/**
 * Puts a message the server just answered with into its chat. The answer is
 * the message as it was made, so a copy the event stream already brought,
 * which may be newer, as when the agent has read it, stays.
 */
function keep(message: Message): void {
  const known = state.messages[message.agent_id] ?? NO_MESSAGES;
  if (known.some((item) => item.id === message.id)) return;
  set({ messages: { ...state.messages, [message.agent_id]: [...known, message] } });
}

/** Sends a message, with any files, and the id of the message it answers when it is a reply. */
export async function send(agentId: string, body: string, files: Picked[] = [], replyTo?: string): Promise<void> {
  const form = new FormData();
  form.append("body", body);
  if (replyTo) form.append("replyTo", replyTo);
  // Expo's fetch takes a file as its name, its type and a way to read its bytes, which it does as the message goes.
  for (const file of files) form.append("files", { name: file.name, type: file.type, bytes: () => new File(file.uri).bytes() } as unknown as Blob);
  keep(await request<Message>(`/agents/${agentId}/messages`, { method: "POST", body: form }));
}

/** Answers an agent's ask: whether it may do what it asked about. It fails when the agent has stopped waiting. */
export async function answerAsk(ask: Message, allow: boolean): Promise<void> {
  const answered = await request<Message>(`/agents/${ask.agent_id}/asks/${ask.id}`, { method: "POST", body: { allow } });
  // An ask raised while working for another agent is in that agent's chat too.
  const messages = { ...state.messages };
  for (const agentId of [ask.agent_id, ask.peer_id]) if (agentId && messages[agentId]) messages[agentId] = upsert(messages[agentId], answered);
  set({ messages });
}

/** Replaces the agent's session. The chat stays, and the agent saves what is worth keeping first. */
export async function freshStart(agentId: string): Promise<void> {
  keep(await request<Message>(`/agents/${agentId}/fresh-start`, { method: "POST" }));
}

/** Sends again a message the agent never answered, as it was sent, with its files and the message it answers. */
export async function resend(message: Message): Promise<void> {
  await request(`/agents/${message.agent_id}/messages/${message.id}/resend`, { method: "POST" });
}

/**
 * Stops the turn the agent is running. The chat says "Stopped" once it has
 * ended, and the agent keeps what it had in mind. Unlike a change to an
 * agent, a stop doesn't wait on the phone for a server that is out of reach.
 */
export async function stop(agentId: string): Promise<void> {
  await request(`/agents/${agentId}/stop`, { method: "POST" });
}

/** Adds an agent. It runs on `provider`, or with none named, on the first the person set up. */
export async function createAgent(name: string, avatarId: string, provider?: Provider): Promise<Agent> {
  const agent = await request<Agent>("/agents", { method: "POST", body: { name, avatarId, provider } });
  // The event stream may have brought the agent already.
  const others = state.agents.filter((each) => each.id !== agent.id);
  set({ agents: [{ ...agent, latest: null, working: false, unread: 0, waiting_on: null }, ...others], messages: { ...state.messages, [agent.id]: [] } });
  return agent;
}

/**
 * Changes an agent on the phone at once, then sends the change. While the
 * server is out of reach the change waits on the phone and goes when the
 * connection returns. It fails only when the server refuses it, and then the
 * agent goes back to what the server has.
 */
export function changeAgent(agentId: string, changes: AgentChanges): Promise<void> {
  if (!state.agents.some((agent) => agent.id === agentId)) return Promise.resolve();
  set({ pending: { ...state.pending, [agentId]: { ...state.pending[agentId], ...changes } } });
  set({ agents: state.agents.map((agent) => (agent.id === agentId ? withPending(agent) : agent)) });
  return sendChanges(agentId);
}

const sending = new Map<string, Promise<void>>();

/**
 * Sends an agent's pending changes, one request at a time, so quick changes
 * reach the server in the order they were made. What changes while one is on
 * its way goes in the next.
 */
function sendChanges(agentId: string): Promise<void> {
  const running = sending.get(agentId);
  if (running) return running;
  const done = (async () => {
    for (let changes = state.pending[agentId]; changes; changes = state.pending[agentId]) {
      try {
        const agent = await request<AgentWithLatest>(`/agents/${agentId}`, { method: "PATCH", body: changes });
        const sent = changes;
        const left = Object.entries(state.pending[agentId] ?? {}).filter(([key, value]) => sent[key as keyof AgentChanges] !== value);
        keepPending(agentId, left.length ? Object.fromEntries(left) : undefined);
        set({ agents: state.agents.map((each) => (each.id === agentId ? withPending(agent) : each)) });
      } catch (failure) {
        // Out of reach: the change waits for the connection to return.
        if (failure instanceof ApiError && failure.status === 0) return;
        keepPending(agentId, undefined);
        const agents = await request<AgentWithLatest[]>("/agents").catch(() => null);
        if (agents) set({ agents: agents.map(withPending) });
        throw failure;
      }
    }
  })().finally(() => sending.delete(agentId));
  sending.set(agentId, done);
  return done;
}

function keepPending(agentId: string, changes: AgentChanges | undefined): void {
  const { [agentId]: _sent, ...others } = state.pending;
  set({ pending: changes ? { ...others, [agentId]: changes } : others });
}

/** Removes an agent for good, with its chat, its memory, its jobs and its files. */
export async function deleteAgent(agentId: string): Promise<void> {
  await request(`/agents/${agentId}`, { method: "DELETE" });
  forget(agentId);
}

/** Fetches what an agent's page shows: its instructions, what it remembers and its jobs. */
export async function loadAbout(agentId: string): Promise<void> {
  const about = await request<About>(`/agents/${agentId}/about`);
  set({ about: { ...state.about, [agentId]: about } });
}

/** Fetches where the person's plan or API credit goes: what their agents used lately, and what is left of their plan. */
export async function loadUsage(): Promise<void> {
  set({ usage: await request<Usage>("/usage") });
}

/** Fetches the apps the person's agents can use as them, and which are connected. */
export async function loadConnections(): Promise<void> {
  set({ connections: await request<Connected[]>("/connections") });
}

/** Keeps a connection as the computer now says it stands, in the list the phone has. */
function keepConnection(now: Connected): void {
  if (state.connections) set({ connections: state.connections.map((each) => (each.connection === now.connection ? now : each)) });
}

/**
 * Connects one of the person's apps for all their agents. The app's own
 * sign-in opens in the sheet iOS has for one, and the computer makes the
 * connection from the address the sign-in ends on. A person who closes the
 * sheet has connected nothing.
 */
export async function connect(connection: Connection): Promise<void> {
  const { url, redirect } = await request<SignIn>(`/connections/${connection}/sign-in`, { method: "POST" });
  const ended = await WebBrowser.openAuthSessionAsync(url, redirect);
  if (ended.type === "success") keepConnection(await request<Connected>(`/connections/${connection}`, { method: "PUT", body: { url: ended.url } }));
}

/** Removes a connection, so none of the person's agents can use it. */
export async function removeConnection(connected: Connected): Promise<void> {
  await request(`/connections/${connected.connection}`, { method: "DELETE" });
  keepConnection({ ...connected, account: null });
}

export async function removeJob(agentId: string, jobId: string): Promise<void> {
  await request(`/agents/${agentId}/jobs/${jobId}`, { method: "DELETE" });
  const about = state.about[agentId];
  if (about) set({ about: { ...state.about, [agentId]: { ...about, jobs: about.jobs.filter((job) => job.id !== jobId) } } });
}

/** The messages that contain `text`, in any of the person's chats, newest first. */
export function findMessages(text: string): Promise<Found[]> {
  return request<Found[]>(`/search?text=${encodeURIComponent(text)}`);
}

/** Tells the server the person has read everything in this chat so far. */
export function markRead(agentId: string): void {
  if (!state.agents.find((agent) => agent.id === agentId)?.unread) return;
  const replace = (read: AgentWithLatest) => set({ agents: state.agents.map((agent) => (agent.id === agentId ? withPending(read) : agent)) });
  // The count clears at once. If the server never hears, the next refresh brings it back.
  replace({ ...state.agents.find((agent) => agent.id === agentId)!, unread: 0 });
  request<AgentWithLatest>(`/agents/${agentId}/read`, { method: "POST" }).then(replace, () => undefined);
}

let stopSync: (() => void) | null = null;

/** Keeps the app's copy current: listens to the server's event stream and reconnects when it drops. */
export function startSync(): void {
  if (stopSync || !isPaired()) return;
  const abort = new AbortController();
  const appState = AppState.addEventListener("change", (next) => {
    // iOS drops the stream while the app is in the background.
    if (next === "active") {
      stopSync?.();
      startSync();
    }
  });
  stopSync = () => {
    abort.abort();
    appState.remove();
    stopSync = null;
  };
  void listen(abort.signal);
}

async function listen(signal: AbortSignal): Promise<void> {
  let wait = 1000;
  while (!signal.aborted) {
    try {
      const events = remote("/events");
      const response = await (isDemo(events.uri) ? demoFetch : streamingFetch)(events.uri, { headers: { ...events.headers, Accept: "text/event-stream" }, signal });
      // A computer on another version of the contract is asked again until one side is updated.
      const side = behind(response);
      if (side !== state.behind) set({ behind: side });
      if (side) {
        void response.body?.cancel();
        throw new Error("the computer speaks another version");
      }
      // The computer doesn't know this phone, so there is nothing to listen to until it pairs again.
      if (response.status === 401) return unpair();
      if (!response.ok || !response.body) throw new Error(`events answered ${response.status}`);
      await refresh();
      set({ online: true });
      wait = 1000;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        buffer += decoder.decode(chunk.value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const data = buffer.slice(0, end).split("\n").find((line) => line.startsWith("data: {"));
          buffer = buffer.slice(end + 2);
          if (data) apply(JSON.parse(data.slice(6)) as StreamEvent);
        }
      }
    } catch {
      // Falls through to the retry below.
    }
    if (signal.aborted) return;
    set({ online: false });
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 2, 15_000);
  }
}

// Pairing with a computer starts the sync. Losing the pairing stops it, and clears what the phone kept of that computer.
onPairing(() => {
  if (isPaired()) return startSync();
  stopSync?.();
  set({ ...EMPTY, online: true, behind: null });
});
