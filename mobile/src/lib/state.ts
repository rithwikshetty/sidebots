// What the app knows: the person's agents, their messages and the pets. The
// server is the source of truth; this copy is saved on the phone so chats open
// instantly and can be read offline.

import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { fetch as streamingFetch } from "expo/fetch";
import { File } from "expo-file-system";
import Storage from "expo-sqlite/kv-store";
import type { Agent, AgentWithLatest, Found, Message, MessageEvent, Pet, PetState } from "@server/contract";
import { request, serverUrl } from "./api";
import type { Picked } from "./files";

type State = {
  agents: AgentWithLatest[];
  messages: Record<string, Message[]>;
  pets: Pet[];
  online: boolean;
};

// The number changes when the shape of what is saved does.
const CACHE_KEY = "cache-3";
const SAVE_DELAY_MS = 300;
const NO_MESSAGES: Message[] = [];

function saved(): Partial<State> {
  try {
    return JSON.parse(Storage.getItemSync(CACHE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

let state: State = { agents: [], messages: {}, pets: [], ...saved(), online: true };
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function set(patch: Partial<State>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { online: _online, ...rest } = state;
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

export function usePets(): Pet[] {
  return useSyncExternalStore(subscribe, () => state.pets);
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, () => state.online);
}

/** Which animation an agent's pet plays. */
export function petStateOf(agent: AgentWithLatest): PetState {
  if (agent.working) return "working";
  if (agent.latest?.sender === "simon" && agent.latest.status === "failed") return "failed";
  if (agent.unread > 0) return "replied";
  return "resting";
}

function upsert(list: Message[], message: Message): Message[] {
  const at = list.findIndex((item) => item.id === message.id);
  return at < 0 ? [...list, message] : list.map((item, index) => (index === at ? message : item));
}

function apply({ message, agent }: MessageEvent): void {
  const known = state.messages[agent.id];
  set({
    agents: [agent, ...state.agents.filter((item) => item.id !== agent.id)],
    messages: known ? { ...state.messages, [agent.id]: upsert(known, message) } : state.messages,
  });
}

/** Fetches the newest page of a chat and joins it onto any older messages already saved. */
export async function loadMessages(agentId: string): Promise<void> {
  const page = await request<Message[]>(`/agents/${agentId}/messages`);
  const known = state.messages[agentId] ?? NO_MESSAGES;
  const older = page.length ? known.filter((message) => message.created_at < page[0].created_at) : known;
  set({ messages: { ...state.messages, [agentId]: [...older, ...page] } });
}

async function refresh(): Promise<void> {
  const [agents, pets] = await Promise.all([request<AgentWithLatest[]>("/agents"), request<Pet[]>("/pets")]);
  set({ agents, pets });
  await Promise.all(Object.keys(state.messages).map(loadMessages));
}

/** Puts a message the server just answered with into its chat. */
function keep(message: Message): void {
  const known = state.messages[message.agent_id] ?? NO_MESSAGES;
  set({ messages: { ...state.messages, [message.agent_id]: upsert(known, message) } });
}

export async function send(agentId: string, body: string, files: Picked[] = []): Promise<void> {
  const form = new FormData();
  form.append("body", body);
  // Expo's fetch takes a file as its name, its type and a way to read its bytes, which it does as the message goes.
  for (const file of files) form.append("files", { name: file.name, type: file.type, bytes: () => new File(file.uri).bytes() } as unknown as Blob);
  keep(await request<Message>(`/agents/${agentId}/messages`, { method: "POST", body: form }));
}

/** Replaces the agent's session. The chat stays, and the agent saves what is worth keeping first. */
export async function freshStart(agentId: string): Promise<void> {
  keep(await request<Message>(`/agents/${agentId}/fresh-start`, { method: "POST" }));
}

export async function createAgent(name: string, petId: string): Promise<Agent> {
  const agent = await request<Agent>("/agents", { method: "POST", body: { name, petId } });
  set({ agents: [{ ...agent, latest: null, working: false, unread: 0 }, ...state.agents], messages: { ...state.messages, [agent.id]: [] } });
  return agent;
}

/** The messages that contain `text`, in any of the person's chats, newest first. */
export function findMessages(text: string): Promise<Found[]> {
  return request<Found[]>(`/search?text=${encodeURIComponent(text)}`);
}

/** Tells the server the person has read everything in this chat so far. */
export function markRead(agentId: string): void {
  if (!state.agents.find((agent) => agent.id === agentId)?.unread) return;
  const replace = (read: AgentWithLatest) => set({ agents: state.agents.map((agent) => (agent.id === agentId ? read : agent)) });
  // The count clears at once. If the server never hears, the next refresh brings it back.
  replace({ ...state.agents.find((agent) => agent.id === agentId)!, unread: 0 });
  request<AgentWithLatest>(`/agents/${agentId}/read`, { method: "POST" }).then(replace, () => undefined);
}

let stopSync: (() => void) | null = null;

/** Keeps the app's copy current: listens to the server's event stream and reconnects when it drops. */
export function startSync(): void {
  if (stopSync || !serverUrl()) return;
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
      const response = await streamingFetch(`${serverUrl()}/events`, { headers: { Accept: "text/event-stream" }, signal });
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
          if (data) apply(JSON.parse(data.slice(6)) as MessageEvent);
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
