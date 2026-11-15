// What the app knows: the person's agents, their messages and the pets. The
// server is the source of truth; this copy is saved on the phone so chats open
// instantly and can be read offline.

import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { fetch as streamingFetch } from "expo/fetch";
import Storage from "expo-sqlite/kv-store";
import type { Agent, AgentWithLatest, Message, MessageEvent, Pet, PetState } from "@server/contract";
import { request, serverUrl } from "./api";
import { petStateOf } from "./summary";

type State = {
  agents: AgentWithLatest[];
  messages: Record<string, Message[]>;
  pets: Pet[];
  /** Per agent, the time of the newest message the person has seen. */
  seen: Record<string, number>;
  online: boolean;
};

const CACHE_KEY = "cache";
const SAVE_DELAY_MS = 300;
const NO_MESSAGES: Message[] = [];

function saved(): Partial<State> {
  try {
    return JSON.parse(Storage.getItemSync(CACHE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

let state: State = { agents: [], messages: {}, pets: [], seen: {}, ...saved(), online: true };
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

/** Per agent, the time of the newest message the person has seen. */
export function useSeen(): Record<string, number> {
  return useSyncExternalStore(subscribe, () => state.seen);
}

/** Which animation an agent's pet plays. */
export function usePetState(agent: AgentWithLatest): PetState {
  return petStateOf(agent, useSyncExternalStore(subscribe, () => state.seen[agent.id] ?? 0));
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

export async function send(agentId: string, body: string): Promise<void> {
  const message = await request<Message>(`/agents/${agentId}/messages`, { method: "POST", body: { body } });
  const known = state.messages[agentId] ?? NO_MESSAGES;
  set({ messages: { ...state.messages, [agentId]: upsert(known, message) } });
}

export async function createAgent(name: string, petId: string): Promise<Agent> {
  const agent = await request<Agent>("/agents", { method: "POST", body: { name, petId } });
  set({ agents: [{ ...agent, latest: null, working: false }, ...state.agents], messages: { ...state.messages, [agent.id]: [] } });
  return agent;
}

/** Records that the person has seen everything in this chat so far. */
export function markSeen(agentId: string): void {
  const latest = state.agents.find((agent) => agent.id === agentId)?.latest;
  if (latest && latest.created_at > (state.seen[agentId] ?? 0)) set({ seen: { ...state.seen, [agentId]: latest.created_at } });
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
