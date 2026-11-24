// What an app knows: the person's agents, their messages and the avatars. The
// server is the source of truth; this copy is saved on the device so chats open
// instantly and can be read offline. Each app makes one store, and gives it
// the few things a phone and a desktop do differently.

import { KEEPALIVE_MS, PAGE } from "../server/src/contract.ts";
import type { About, Agent, AgentWithLatest, Avatar, Connected, Connection, Effort, Found, Message, Model, Provider, SignIn, StreamEvent, Usage } from "../server/src/contract.ts";
import { ApiError, behind, type Behind } from "./api.ts";

type State = {
  agents: AgentWithLatest[];
  messages: Record<string, Message[]>;
  avatars: Avatar[];
  /** What each agent's page shows, for the agents whose page has been opened. */
  about: Record<string, About>;
  /** Where the person's plan or API credit goes, as the computer last said. Null until the app has asked. */
  usage: Usage | null;
  /** The apps the person's agents can use as them, as the computer last listed them. Null until the app has asked. */
  connections: Connected[] | null;
  /**
   * Changes to agents that the server hasn't taken yet. The app shows them
   * at once and keeps them on the device, over whatever the server says,
   * until the server has them.
   */
  pending: Record<string, AgentChanges>;
  online: boolean;
  /** Which side to update when the computer speaks another version of the contract, or null while they match. */
  behind: Behind | null;
};

/** What the person can change about an agent. */
export type AgentChanges = { name?: string; avatarId?: string; provider?: Provider; model?: Model; effort?: Effort; fast?: boolean; muted?: boolean; hidden?: boolean; color?: string | null };

/** What a store needs of the app that makes it. `Picked` is a file as that app's pickers give it. */
export type Platform<Picked> = {
  /** Calls the server. A `body` is sent as JSON, or as it is when it is a form. It fails with an `ApiError`, whose status is 0 when the server is out of reach. */
  request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  /** Opens the server's event stream, which `signal` closes. */
  events(signal: AbortSignal): Promise<Pick<Response, "status" | "ok" | "headers" | "body">>;
  /** Where the store's copy is saved, as text under a key. */
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  /**
   * Calls `listener` each time the app comes back to the front, with whether
   * the system may have dropped the stream while it was away, as iOS does in
   * the background. Returns a function that stops it.
   */
  onFront(listener: (dropped: boolean) => void): () => void;
  /** Adds a picked file to the form a message is sent as, under `files`. */
  attach(form: FormData, file: Picked): void;
  /** Opens a connection's sign-in at `url`, and resolves to the address it ended on, which starts with `redirect`, or to null when the person closed it. */
  signIn(url: string, redirect: string): Promise<string | null>;
  /** Called when the server answers the event stream that it doesn't know this device. The sync has stopped by then. */
  onRefused(): void;
  /** Saves every avatar's spritesheet on the device, in an app that draws avatars before it has fetched them. */
  keepSheets?(avatars: Avatar[]): void;
  /** React's hook of this name, which the store's own hooks are made of. */
  useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, snapshot: () => T): T;
};

// The number changes when the shape of what is saved does.
const CACHE_KEY = "cache-6";
const SAVE_DELAY_MS = 300;
// The computer says something on the stream within every keepalive, and a slow connection may bring it late. A stream quiet for longer than this has dropped.
const QUIET_MS = KEEPALIVE_MS + 10_000;
const NO_MESSAGES: Message[] = [];
const EMPTY = { agents: [], messages: {}, avatars: [], about: {}, usage: null, connections: null, pending: {} };

/** The chats, with only the newest page of each that isn't `open`. The messages before it page back from the computer. */
function newestOf(messages: State["messages"], open: (agentId: string) => boolean): State["messages"] {
  const long = Object.keys(messages).filter((agentId) => messages[agentId].length > PAGE && !open(agentId));
  return long.length ? { ...messages, ...Object.fromEntries(long.map((agentId) => [agentId, messages[agentId].slice(-PAGE)])) } : messages;
}

/** Makes an app's store, which starts from the copy the app saved. */
export function createStore<Picked>(platform: Platform<Picked>) {
  const { request, storage, useSyncExternalStore } = platform;

  function saved(): Partial<State> {
    try {
      return JSON.parse(storage.getItem(CACHE_KEY) ?? "{}");
    } catch {
      return {};
    }
  }

  const kept = { ...EMPTY, ...saved() };
  let state: State = { ...kept, messages: newestOf(kept.messages, () => false), online: true, behind: null };
  const listeners = new Set<() => void>();
  // The chats on screen, each with how many parts of the app show it.
  const shown = new Map<string, number>();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Changes what the store holds, tells whoever shows it, and saves it. A
   * chat keeps everything fetched and said of it while it is on screen. Of
   * every other chat, and of each chat in what is saved, the store keeps the
   * newest page.
   */
  function set(patch: Partial<State>): void {
    state = { ...state, ...patch, ...(patch.messages && { messages: newestOf(patch.messages, (agentId) => shown.has(agentId)) }) };
    listeners.forEach((listener) => listener());
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const { online: _online, behind: _behind, ...rest } = state;
      storage.setItem(CACHE_KEY, JSON.stringify({ ...rest, messages: newestOf(rest.messages, () => false) }));
    }, SAVE_DELAY_MS);
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function useAgents(): AgentWithLatest[] {
    return useSyncExternalStore(subscribe, () => state.agents);
  }

  function useAgent(id: string): AgentWithLatest | undefined {
    return useSyncExternalStore(subscribe, () => state.agents.find((agent) => agent.id === id));
  }

  const watches = new Map<string, typeof subscribe>();

  /**
   * `subscribe` for a part of the app that shows a chat, which is how the
   * store knows the chat is on screen. When the last part showing it leaves,
   * the chat goes back to its newest page.
   */
  function watch(agentId: string): typeof subscribe {
    const known = watches.get(agentId);
    if (known) return known;
    const watching = (listener: () => void) => {
      const stop = subscribe(listener);
      shown.set(agentId, (shown.get(agentId) ?? 0) + 1);
      return () => {
        stop();
        const left = shown.get(agentId)! - 1;
        if (left > 0) return void shown.set(agentId, left);
        shown.delete(agentId);
        if ((state.messages[agentId]?.length ?? 0) > PAGE) set({ messages: state.messages });
      };
    };
    watches.set(agentId, watching);
    return watching;
  }

  function useMessages(agentId: string): Message[] {
    return useSyncExternalStore(watch(agentId), () => state.messages[agentId] ?? NO_MESSAGES);
  }

  function useAvatars(): Avatar[] {
    return useSyncExternalStore(subscribe, () => state.avatars);
  }

  /** The colour of an agent's chat: the one picked for it, or its avatar's. Null until the avatars have loaded. */
  function useChatColor(agent: Pick<Agent, "avatar_id" | "color"> | undefined): string | null {
    const avatars = useAvatars();
    if (!agent) return null;
    return agent.color ?? avatars.find((avatar) => avatar.id === agent.avatar_id)?.color ?? null;
  }

  function useAbout(agentId: string): About | undefined {
    return useSyncExternalStore(subscribe, () => state.about[agentId]);
  }

  function useUsage(): Usage | null {
    return useSyncExternalStore(subscribe, () => state.usage);
  }

  function useConnections(): Connected[] | null {
    return useSyncExternalStore(subscribe, () => state.connections);
  }

  function useOnline(): boolean {
    return useSyncExternalStore(subscribe, () => state.online);
  }

  function useBehind(): Behind | null {
    return useSyncExternalStore(subscribe, () => state.behind);
  }

  const told = new Set<(agents: AgentWithLatest[]) => void>();

  /**
   * Calls `listener` with the agents each time the computer has just said how
   * they are: with every event of its stream, and when the app catches up with
   * it. What the app saved of them doesn't count. Returns a function that
   * stops it.
   */
  function onAgents(listener: (agents: AgentWithLatest[]) => void): () => void {
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

  /**
   * A chat with `message` in the place of the copy it holds, or at its end
   * when the message is new. One from before everything the chat holds, as an
   * old message that changed, is on a page the chat doesn't hold, and comes
   * with that page.
   */
  function upsert(list: Message[], message: Message): Message[] {
    const at = list.findIndex((item) => item.id === message.id);
    if (at >= 0) return list.map((item, index) => (index === at ? message : item));
    return list.length && message.created_at < list[0].created_at ? list : [...list, message];
  }

  /**
   * Takes in what the event stream says: a message and its agent, an agent
   * that was added or changed, or an agent that was deleted. A message brings
   * its agent to the top of the list, as a new agent goes there, and lands in
   * its chat when the app holds that chat. An agent the app has that comes
   * with no message, as one renamed or muted on another device, keeps its
   * place.
   */
  function apply(event: StreamEvent): void {
    if ("deleted" in event) forget(event.deleted);
    else {
      const { message, agent } = event;
      const known = state.messages[agent.id];
      const chat = known && message ? upsert(known, message) : known;
      // A message the chat had no place for is on a page it doesn't hold, and the chat is fetched again when it is next opened.
      if (message && chat === known) live?.caughtUp.delete(agent.id);
      const stays = !message && state.agents.some((item) => item.id === agent.id);
      set({
        agents: stays ? state.agents.map((item) => (item.id === agent.id ? withPending(agent) : item)) : [withPending(agent), ...state.agents.filter((item) => item.id !== agent.id)],
        messages: chat && chat !== known ? { ...state.messages, [agent.id]: chat } : state.messages,
      });
    }
    told.forEach((listener) => listener(state.agents));
  }

  /**
   * Lets go of everything the app kept of an agent that is gone. What the
   * other agents' chats held of it goes on the computer too, which the stream
   * doesn't spell out, so each chat is fetched again when it is next opened.
   */
  function forget(agentId: string): void {
    if (live) live.caughtUp = new Set();
    const { [agentId]: _messages, ...messages } = state.messages;
    const { [agentId]: _about, ...about } = state.about;
    const { [agentId]: _pending, ...pending } = state.pending;
    set({ agents: state.agents.filter((agent) => agent.id !== agentId), messages, about, pending });
  }

  /**
   * Fetches the newest page of a chat, which the app holds from here on, an
   * empty one too, so what the event stream says of it lands in it. A chat
   * fetched while the stream is open, with nothing reaching it while its page
   * was on its way, is as the computer has it for as long as the stream stays
   * open, and isn't fetched again. The page joins onto the older messages
   * already saved when they run up to it. When the chat has moved on by more
   * than a page, the page stands alone and the chat pages back from there. A
   * message that reached the chat while the page was fetched, which the page
   * was made too soon to hold, goes after it, and an older page fetched
   * meanwhile stays before it or goes with the rest. An ask never goes back
   * to waiting, so one the app knows has closed stays closed when the page
   * was fetched before it did.
   */
  async function loadMessages(agentId: string): Promise<void> {
    const caughtUp = live?.caughtUp;
    if (caughtUp?.has(agentId)) return;
    const before = state.messages[agentId] ?? [];
    if (!state.messages[agentId]) set({ messages: { ...state.messages, [agentId]: before } });
    const fetched = await request<Message[]>(`/agents/${agentId}/messages`);
    // Another fetch caught the chat up while this page was on its way, and the stream has kept it so, so the page holds nothing newer.
    if (live?.caughtUp.has(agentId)) return;
    const known = state.messages[agentId] ?? NO_MESSAGES;
    // A page that something reached the chat ahead of may be older than what the chat holds, so the chat is fetched again when it is next opened.
    if (known === before) caughtUp?.add(agentId);
    if (fetched.length === 0) return;
    const closed = (message: Message) => known.find((had) => had.id === message.id && had.ask && had.ask !== "waiting");
    const page = fetched.map((message) => (message.ask === "waiting" ? (closed(message) ?? message) : message));
    const joins = Math.max(known.findIndex((message) => message.id === page[0].id), 0);
    // The event stream adds at the chat's end, and paging back adds at its start, so what came since the page was made is what follows the last message the chat or the page already had.
    const had = new Set([...before, ...page].map((message) => message.id));
    const since = known.slice(known.findLastIndex((message) => had.has(message.id)) + 1);
    set({ messages: { ...state.messages, [agentId]: [...known.slice(0, joins), ...page, ...since] } });
  }

  const paging = new Map<string, Promise<boolean>>();

  /**
   * Fetches the page before the oldest message the app has of a chat. False
   * once the chat's beginning is reached. Whoever asks for the same page
   * while it is on its way waits for that one, and whoever asks once it has
   * come, as a screen does on seeing it, fetches the one before it.
   */
  function loadOlder(agentId: string): Promise<boolean> {
    const oldest = state.messages[agentId]?.[0];
    if (!oldest) return Promise.resolve(false);
    const path = `/agents/${agentId}/messages?before=${oldest.id}`;
    const running = paging.get(path);
    if (running) return running;
    const done = request<Message[]>(path)
      .finally(() => paging.delete(path))
      .then((page) => {
        const known = state.messages[agentId] ?? NO_MESSAGES;
        if (page.length && known[0]?.id === oldest.id) set({ messages: { ...state.messages, [agentId]: [...page, ...known] } });
        return page.length > 0;
      });
    paging.set(path, done);
    return done;
  }

  async function refresh(): Promise<void> {
    const [agents, avatars] = await Promise.all([request<AgentWithLatest[]>("/agents"), request<Avatar[]>("/avatars")]);
    // What the app kept of an agent that is gone, as one deleted on another device, goes with it.
    const kept = new Set(agents.map((agent) => agent.id));
    const ofKept = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([agentId]) => kept.has(agentId)));
    set({ pending: ofKept(state.pending), messages: ofKept(state.messages), about: ofKept(state.about) });
    set({ agents: agents.map(withPending), avatars });
    // The apps the agents can use come too, for the logo an ask for one wears. A computer that has none leaves the list as it was.
    void loadConnections().catch(() => undefined);
    told.forEach((listener) => listener(state.agents));
    platform.keepSheets?.(avatars);
    // Changes made while the server was out of reach go now.
    for (const agentId of Object.keys(state.pending)) void sendChanges(agentId).catch(() => undefined);
    await Promise.all(Object.keys(state.messages).map(loadMessages));
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
  async function send(agentId: string, body: string, files: Picked[] = [], replyTo?: string): Promise<void> {
    const form = new FormData();
    form.append("body", body);
    if (replyTo) form.append("replyTo", replyTo);
    for (const file of files) platform.attach(form, file);
    keep(await request<Message>(`/agents/${agentId}/messages`, { method: "POST", body: form }));
  }

  /** Answers an agent's ask: whether it may do what it asked about. It fails when the agent has stopped waiting. */
  async function answerAsk(ask: Message, allow: boolean): Promise<void> {
    const answered = await request<Message>(`/agents/${ask.agent_id}/asks/${ask.id}`, { method: "POST", body: { allow } });
    // An ask raised while working for another agent is in that agent's chat too.
    const messages = { ...state.messages };
    for (const agentId of [ask.agent_id, ask.peer_id]) if (agentId && messages[agentId]) messages[agentId] = upsert(messages[agentId], answered);
    set({ messages });
  }

  /** Replaces the agent's session. The chat stays, and the agent saves what is worth keeping first. */
  async function freshStart(agentId: string): Promise<void> {
    keep(await request<Message>(`/agents/${agentId}/fresh-start`, { method: "POST" }));
  }

  /** Sends again a message the agent never answered, as it was sent, with its files and the message it answers. */
  async function resend(message: Message): Promise<void> {
    await request(`/agents/${message.agent_id}/messages/${message.id}/resend`, { method: "POST" });
  }

  /**
   * Stops the turn the agent is running. The chat says "Stopped" once it has
   * ended, and the agent keeps what it had in mind. Unlike a change to an
   * agent, a stop doesn't wait on the device for a server that is out of reach.
   */
  async function stop(agentId: string): Promise<void> {
    await request(`/agents/${agentId}/stop`, { method: "POST" });
  }

  /** Adds an agent. It runs on `provider`, or with none named, on the first the person set up. */
  async function createAgent(name: string, avatarId: string, provider?: Provider): Promise<Agent> {
    const agent = await request<Agent>("/agents", { method: "POST", body: { name, avatarId, provider } });
    // The event stream may have brought the agent already.
    const others = state.agents.filter((each) => each.id !== agent.id);
    set({ agents: [{ ...agent, latest: null, working: false, unread: 0, waiting_on: null }, ...others], messages: { ...state.messages, [agent.id]: [] } });
    return agent;
  }

  /**
   * Changes an agent in the app at once, then sends the change. While the
   * server is out of reach the change waits on the device and goes when the
   * connection returns. It fails only when the server refuses it, and then the
   * agent goes back to what the server has.
   */
  function changeAgent(agentId: string, changes: AgentChanges): Promise<void> {
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
  async function deleteAgent(agentId: string): Promise<void> {
    await request(`/agents/${agentId}`, { method: "DELETE" });
    forget(agentId);
  }

  /** Fetches what an agent's page shows: its instructions, what it remembers and its jobs. */
  async function loadAbout(agentId: string): Promise<void> {
    const about = await request<About>(`/agents/${agentId}/about`);
    set({ about: { ...state.about, [agentId]: about } });
  }

  /** Fetches where the person's plan or API credit goes: what their agents used lately, and what is left of their plan. */
  async function loadUsage(): Promise<void> {
    set({ usage: await request<Usage>("/usage") });
  }

  /** Fetches the apps the person's agents can use as them, and which are connected. */
  async function loadConnections(): Promise<void> {
    set({ connections: await request<Connected[]>("/connections") });
  }

  /** Keeps a connection as the computer now says it stands, in the list the app has. */
  function keepConnection(now: Connected): void {
    if (state.connections) set({ connections: state.connections.map((each) => (each.connection === now.connection ? now : each)) });
  }

  /**
   * Connects one of the person's apps for all their agents. The app's own
   * sign-in opens, and the computer makes the connection from the address the
   * sign-in ends on. A person who closes the sign-in has connected nothing.
   */
  async function connect(connection: Connection): Promise<void> {
    const { url, redirect } = await request<SignIn>(`/connections/${connection}/sign-in`, { method: "POST" });
    const ended = await platform.signIn(url, redirect);
    if (ended !== null) keepConnection(await request<Connected>(`/connections/${connection}`, { method: "PUT", body: { url: ended } }));
  }

  /** Removes a connection, so none of the person's agents can use it. */
  async function removeConnection(connected: Connected): Promise<void> {
    await request(`/connections/${connected.connection}`, { method: "DELETE" });
    keepConnection({ ...connected, account: null });
  }

  async function removeJob(agentId: string, jobId: string): Promise<void> {
    await request(`/agents/${agentId}/jobs/${jobId}`, { method: "DELETE" });
    const about = state.about[agentId];
    if (about) set({ about: { ...state.about, [agentId]: { ...about, jobs: about.jobs.filter((job) => job.id !== jobId) } } });
  }

  /** The messages that contain `text`, in any of the person's chats, newest first. */
  function findMessages(text: string): Promise<Found[]> {
    return request<Found[]>(`/search?text=${encodeURIComponent(text)}`);
  }

  /** Tells the server the person has read everything in this chat so far. */
  function markRead(agentId: string): void {
    if (!state.agents.find((agent) => agent.id === agentId)?.unread) return;
    const replace = (read: AgentWithLatest) => set({ agents: state.agents.map((agent) => (agent.id === agentId ? withPending(read) : agent)) });
    // The count clears at once. If the server never hears, the next refresh brings it back.
    replace({ ...state.agents.find((agent) => agent.id === agentId)!, unread: 0 });
    request<AgentWithLatest>(`/agents/${agentId}/read`, { method: "POST" }).then(replace, () => undefined);
  }

  let syncing: (() => void) | null = null;
  /**
   * The event stream while it is open: when the computer last said anything
   * on it, and the chats whose newest page was fetched since it opened. The
   * stream brings what is said in those from then on.
   */
  let live: { heard: number; caughtUp: Set<string> } | null = null;

  /**
   * Keeps the app's copy current: listens to the server's event stream, and
   * opens it again when it drops. The app coming back to the front opens it
   * again too, unless the system left it alone meanwhile and the computer
   * spoke on it lately, which an open stream shows.
   */
  function startSync(): void {
    if (syncing) return;
    const abort = new AbortController();
    const front = platform.onFront((dropped) => {
      if (!dropped && live && Date.now() - live.heard < QUIET_MS) return;
      stopSync();
      startSync();
    });
    syncing = () => {
      abort.abort();
      front();
      live = null;
      syncing = null;
    };
    void listen(abort.signal);
  }

  /** Closes the event stream. The app's copy stays as it is. */
  function stopSync(): void {
    syncing?.();
  }

  async function listen(signal: AbortSignal): Promise<void> {
    let wait = 1000;
    while (!signal.aborted) {
      try {
        const response = await platform.events(signal);
        // A computer on another version of the contract is asked again until one side is updated.
        const side = behind(response);
        if (side !== state.behind) set({ behind: side });
        if (side) {
          void response.body?.cancel();
          throw new Error("the computer speaks another version");
        }
        // The computer doesn't know this device, so there is nothing to listen to until the app says otherwise.
        if (response.status === 401) {
          stopSync();
          return platform.onRefused();
        }
        if (!response.ok || !response.body) throw new Error(`events answered ${response.status}`);
        const opened = (live = { heard: Date.now(), caughtUp: new Set() });
        await refresh();
        set({ online: true });
        wait = 1000;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          opened.heard = Date.now();
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
      live = null;
      set({ online: false });
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 15_000);
    }
  }

  /** Lets go of everything the app kept, as when the device leaves its computer. */
  function clear(): void {
    set({ ...EMPTY, online: true, behind: null });
  }

  return {
    useAgents,
    useAgent,
    useMessages,
    useAvatars,
    useChatColor,
    useAbout,
    useUsage,
    useConnections,
    useOnline,
    useBehind,
    onAgents,
    loadMessages,
    loadOlder,
    send,
    answerAsk,
    freshStart,
    resend,
    stop,
    createAgent,
    changeAgent,
    deleteAgent,
    loadAbout,
    loadUsage,
    loadConnections,
    connect,
    removeConnection,
    removeJob,
    findMessages,
    markRead,
    startSync,
    stopSync,
    clear,
  };
}
