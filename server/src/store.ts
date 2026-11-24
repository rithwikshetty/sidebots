// The store owns the database and the agent folders. Nothing else touches
// SQLite or ~/.sidebots.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { COLOR, PAGE, PROVIDERS, RUN, USAGE_DAYS, betweenAgents, readableColor, selectionOf } from "./contract.ts";
import type { About, Agent, AgentWithLatest, Ask, Avatar, Connection, Day, Found, Job, Limit, Memory, Message, Plan, Provider, PushToken, Question, Schedule, Selection, Sender, Status, Switched, TurnKind, Usage, Used } from "./contract.ts";

export type Person = { id: string; name: string };
/** How a person's agents sign in to a provider: the provider's config folder of the person's own, which holds their login, rules, skills and sessions. */
export type Account = { person_id: string; provider: Provider; config_dir: string };
/** What a paired device is: a phone, or the desktop app on the computer the server runs on. */
export type DeviceKind = "phone" | "desktop";
/** A device that has paired with this server, and the person whose agents it reaches. */
export type Device = { id: string; person_id: string; name: string; kind: DeviceKind; paired_at: number };
/** Where Apple delivers a phone's notifications, and the key, in base64, that only that phone can read them with. */
export type PushTarget = PushToken & { notificationKey: string };
/** What Sidebots keeps of a connection a person made: the account they signed in to the app with, and the token the app gave for acting as them from then on. */
export type Kept = { account: string; token: string };
/** A file as it arrives with a message. */
export type Upload = { name: string; bytes: Uint8Array };
/** What a message can carry besides its text: files, the message it answers, the job that sent it, when it is an ask, where the ask stands and what it asks, the other agent when it is between two, and the change it tells of when it is a notice of one. */
export type Extras = { files?: Upload[]; replyTo?: string; jobId?: string; interim?: boolean; ask?: Ask; question?: Question; peerId?: string; switched?: Switched };
/** What the person can change about an agent. */
export type AgentChanges = Partial<Pick<Agent, "name" | "avatar_id" | "provider" | "model" | "effort" | "fast" | "muted" | "hidden" | "color">>;
/**
 * What the store tells its listeners about: a message that was added, changed
 * status or had its ask closed, with the agents whose chats it is in, or an
 * agent that was added or changed, each as the home screen now shows it, or an
 * agent that was deleted, or how a person signs in to a provider, as a
 * provider just said.
 */
export type Change =
  | { message: Message; agents: AgentWithLatest[] }
  | { agent: AgentWithLatest; deleted: false }
  | { agent: Agent; deleted: true }
  | { person_id: string; plan: Plan };
/** How this server is known to the relay: its signing key, and the id, the address phones reach it at and the token its tunnel runs with, which the relay gives it once it has registered. */
export type Machine = { privateKey: string; id?: string; address?: string; tunnelToken?: string };
/**
 * How much this server is used, which it tells the relay as it registers: how
 * many agents and paired phones it has, and how many turns its agents ran on
 * each of the last days, by provider and kind of turn. It names nobody and
 * holds nothing anyone said.
 */
type Counts = { agents: number; phones: number; turns: { day: string; provider: Provider; kind: TurnKind; turns: number }[] };

// The app's blue, for an avatar with no colour of its own and no design to take one from.
const DEFAULT_COLOR = "#1F5FD6";

/**
 * The changes made to the tables since the first published version, in order.
 * A database records how many it has had in \`user_version\`. One made from
 * SCHEMA, which has every change in it, starts with all of them. A change to
 * a table that SCHEMA brought in after the first published version names the
 * table: a database that only now gets the table from SCHEMA has the change
 * in it, and skips it. A database that a newer Sidebots has changed keeps the
 * newer count when this one opens it, so the newer one doesn't make its
 * changes a second time.
 */
const TABLE_CHANGES: (string | { table: string; change: string })[] = [
  "alter table devices add column app text",
  "alter table agents add column color text",
  "insert into accounts (person_id, provider, config_dir) select id, 'claude', claude_config_dir from people",
  "alter table people drop column claude_config_dir",
  "alter table agents add column provider text not null default 'claude'",
  "alter table messages add column ask text check (ask in ('waiting', 'allowed', 'refused', 'unanswered'))",
  "alter table messages add column question text",
  "alter table messages add column peer_id text references agents(id)",
  { table: "usage", change: "alter table usage add column tokens integer not null default 0" },
  { table: "usage", change: "alter table usage add column session_tokens integer" },
  // A Codex session keeps the tools it started with, so each one from before the connections' tools gets a fresh start.
  "insert into messages (id, agent_id, sender, body, status, created_at) select lower(hex(randomblob(16))), id, 'sidebots', 'Fresh start', 'queued', cast(unixepoch('subsec') * 1000 as integer) from agents where provider = 'codex' and session_id is not null",
  "alter table devices add column kind text not null default 'phone' check (kind in ('phone', 'desktop'))",
  // A Codex session from before `calendar_event` and `calendar_list`, and before the calendar's tools took the calendar an event is on, gets a fresh start too, unless one waits for it already.
  "insert into messages (id, agent_id, sender, body, status, created_at) select lower(hex(randomblob(16))), id, 'sidebots', 'Fresh start', 'queued', cast(unixepoch('subsec') * 1000 as integer) from agents where provider = 'codex' and session_id is not null and not exists (select 1 from messages where agent_id = agents.id and sender = 'sidebots' and status in ('queued', 'running'))",
  "alter table agents add column fast integer not null default 0",
  "alter table agents add column ran_on text",
  "alter table messages add column switched text",
  // An agent in the middle of a session ran its last turn on what it answers with now.
  "update agents set ran_on = json_object('provider', provider, 'model', model, 'effort', effort, 'fast', json('false')) where session_id is not null",
  "alter table agents add column chat_changes integer not null default 0",
];

const SCHEMA = `
create table if not exists people (
  id          text primary key,
  name        text not null unique
);
create table if not exists accounts (
  person_id   text not null references people(id),
  provider    text not null,
  config_dir  text not null,
  primary key (person_id, provider)
);
create table if not exists agents (
  id          text primary key,
  person_id   text not null references people(id),
  name        text not null,
  avatar_id   text not null,
  provider    text not null default 'claude',
  model       text not null default 'opus',
  effort      text not null default 'medium',
  fast        integer not null default 0,
  ran_on      text,
  muted       integer not null default 0,
  hidden      integer not null default 0,
  color       text,
  session_id  text,
  read_at     integer not null default 0,
  chat_changes integer not null default 0,
  created_at  integer not null
);
create table if not exists messages (
  id          text primary key,
  agent_id    text not null references agents(id),
  sender      text not null check (sender in ('person', 'agent', 'sidebots')),
  body        text not null,
  attachments text not null default '[]',
  status      text not null check (status in ('queued', 'running', 'done', 'failed')),
  seen_at     integer,
  reply_to    text,
  job_id      text,
  interim     integer not null default 0,
  ask         text check (ask in ('waiting', 'allowed', 'refused', 'unanswered')),
  question    text,
  peer_id     text references agents(id),
  switched    text,
  created_at  integer not null
);
create table if not exists jobs (
  id          text primary key,
  agent_id    text not null references agents(id),
  what        text not null,
  schedule    text not null,
  next_at     integer not null,
  created_at  integer not null
);
create table if not exists devices (
  id          text primary key,
  person_id   text not null references people(id),
  name        text not null,
  key_hash    text not null unique,
  notification_key text not null,
  push_token  text,
  environment text check (environment in ('sandbox', 'production')),
  app         text,
  kind        text not null default 'phone' check (kind in ('phone', 'desktop')),
  paired_at   integer not null
);
create table if not exists pairings (
  code_hash  text primary key,
  person_id  text not null references people(id),
  expires_at integer not null
);
create table if not exists usage (
  agent_id     text not null references agents(id),
  kind         text not null check (kind in ('reply', 'job', 'memory')),
  cost         real not null,
  session_id   text not null,
  session_cost real not null,
  at           integer not null,
  tokens       integer not null default 0,
  session_tokens integer
);
create table if not exists limits (
  person_id  text not null references people(id),
  provider   text not null,
  name       text not null,
  used       real,
  resets_at  integer,
  at         integer not null,
  primary key (person_id, provider, name)
);
create table if not exists activities (
  device_id   text not null references devices(id) on delete cascade,
  agent_id    text not null references agents(id) on delete cascade,
  token       text not null,
  environment text not null check (environment in ('sandbox', 'production')),
  app         text,
  primary key (device_id, agent_id)
);
create table if not exists settings (
  name   text primary key,
  value  text not null
);
`;

/**
 * The indexes, made once the tables have every change, since one may be on a
 * column a change brought in. Each serves queries that run with every message
 * or every look at a chat, which without it read every message there is.
 */
const INDEXES = `
-- An agent's own messages in the order they came: the latest, a page of its chat, what was said before a turn.
create index if not exists messages_agent on messages (agent_id);
-- An agent's messages by when they came: the ones since the person last read its chat.
create index if not exists messages_agent_created on messages (agent_id, created_at);
-- What other agents sent an agent, which is in its chat too. Most messages name no other agent, and it leaves them out.
create index if not exists messages_peer on messages (peer_id) where peer_id is not null;
-- The few messages whose turn hasn't ended: what waits on an agent, and whether it works.
create index if not exists messages_unfinished on messages (status) where status = 'queued' or status = 'running';
`;

/**
 * What keeps each agent's count of the changes to its chat, made once the
 * tables have every change. A message that is added, changed or removed
 * counts once for its agent, and once for the other agent when it is between
 * two, whose chat it is in too. The database does the counting, so nothing
 * changes a message without moving the count of each chat it is in.
 */
const TRIGGERS = `
create trigger if not exists messages_added after insert on messages begin
  update agents set chat_changes = chat_changes + 1 where id in (new.agent_id, new.peer_id);
end;
create trigger if not exists messages_changed after update on messages begin
  update agents set chat_changes = chat_changes + 1 where id in (new.agent_id, new.peer_id, old.peer_id);
end;
create trigger if not exists messages_removed after delete on messages begin
  update agents set chat_changes = chat_changes + 1 where id in (old.agent_id, old.peer_id);
end;
`;

const SEARCH_LIMIT = 20;
const AVATAR_ID = /^[a-z0-9-]+$/;
// A stored attachment's file name: no folders, and never a dot first.
const ATTACHMENT_NAME = /^[\w-][\w.-]*$/;
// How long a pairing code works, unless whoever makes it says.
const PAIRING_MS = 10 * 60_000;

/** A pairing code or a device key: 32 random bytes, as text that fits in a link. */
const secret = () => randomBytes(32).toString("base64url");
/** What the database keeps of a secret, so that nobody who reads the database can use it. */
const hashOf = (value: string) => createHash("sha256").update(value).digest("hex");

// Which messages a query means, as conditions on a row. `?1` is an agent's id.
// A message between the agent and the person, or an ask, which is the person's to answer whoever it was raised for.
const WITH_PERSON = "(peer_id is null or ask is not null)";
// A message one agent sent another that asks something, as apart from one that answers.
const ASKED = "peer_id is not null and ask is null and reply_to is null";
// What is in an agent's chat: its own messages, and what another agent said to it or asked the person while working for it.
const IN_CHAT = "(agent_id = ?1 or peer_id = ?1)";
/**
 * The same for a page of the chat: the newest `limit` of its messages that
 * `where` leaves, or the oldest. The agent's own messages and the ones that
 * name it as the other agent are each read in order from their own index and
 * merged, so a page costs what it holds however long the chat is. Asked as
 * one condition, SQLite gathers the whole chat and sorts it.
 */
const pageOfChat = (where: string, limit: string, end: "newest" | "oldest" = "newest") =>
  `rowid in (select rowid from messages where agent_id = ?1 and ${where} union select rowid from messages where peer_id = ?1 and ${where} order by 1 ${end === "newest" ? "desc" : "asc"} limit ${limit})`;
// What waits on an agent: the messages in its chat that aren't for another agent, and other agents' messages to it.
const FOR_AGENT = "((agent_id = ?1 and peer_id is null) or (peer_id = ?1 and ask is null))";
// A message whose turn hasn't ended: it waits to be read, or the agent works on it. It is worded as `messages_unfinished` is, which is how SQLite knows the index holds every such message.
const UNFINISHED = "(status = 'queued' or status = 'running')";

/** A message as SQLite holds it, with its attachments, its question and its change as JSON text and yes and no as 1 and 0. */
type Row = Omit<Message, "attachments" | "interim" | "question" | "switched"> & { attachments: string; interim: number; question: string | null; switched: string | null };
const toMessage = (row: Row): Message => ({
  ...row,
  attachments: JSON.parse(row.attachments) as string[],
  interim: row.interim === 1,
  question: row.question === null ? null : (JSON.parse(row.question) as Question),
  switched: row.switched === null ? null : (JSON.parse(row.switched) as Switched),
});
/** An agent as SQLite holds it, with yes and no as 1 and 0 and what it last answered with as JSON text. */
type AgentRow = Omit<Agent, "fast" | "muted" | "hidden" | "ran_on"> & { fast: number; muted: number; hidden: number; ran_on: string | null };
const toAgent = (row: AgentRow): Agent => ({
  ...row,
  fast: row.fast === 1,
  muted: row.muted === 1,
  hidden: row.hidden === 1,
  ran_on: row.ran_on === null ? null : (JSON.parse(row.ran_on) as Selection),
});
type JobRow = Omit<Job, "schedule"> & { schedule: string };
const toJob = (row: JobRow): Job => ({ ...row, schedule: JSON.parse(row.schedule) as Schedule });

/** A memory file as an agent writes one: a name and a description between `---` lines, then the memory itself. */
function toMemory(file: string, text: string): Memory {
  const [, head = "", body = text] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text) ?? [];
  const field = (name: string) => new RegExp(`^${name}:\\s*"?(.*?)"?\\s*$`, "m").exec(head)?.[1] ?? "";
  return { name: field("name") || file.replace(/\.md$/, ""), description: field("description"), body: body.trim() };
}

function instructions(agentName: string, personName: string): string {
  return `# ${agentName}

You are ${agentName}, one of ${personName}'s agents in Sidebots. Sidebots is a messaging app on their phone and computer, and each agent is one chat in it.

${personName} only sees your final reply, as a text message. They never see your tool calls or working steps. Write the way a capable person texts: short, plain sentences, no headings or tables unless they ask for them.

Your home folder is where you run. Files ${personName} sends you are in \`attachments/\`. To send ${personName} a file, use your \`send_files\` tool.

You don't know what you're for yet. If this is a new chat, ask what ${personName} wants you to help with, then write what you're for into this file. What you learn along the way goes in your memory.
`;
}

export function openStore(home: string) {
  mkdirSync(join(home, "agents"), { recursive: true });
  // The server and its commands open the database at once, as the Mac app runs them, so each waits its turn for a lock.
  const db = new DatabaseSync(join(home, "sidebots.sqlite"), { timeout: 5000 });
  // SQLite gives a statement that long to get its lock, but none to a change of journal mode, which fails at once while another is making the database or closing it. So this gives it as long.
  for (const until = Date.now() + 5000; ; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)) {
    try {
      db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
      break;
    } catch (failure) {
      if ((failure as { errcode?: number }).errcode !== 5 || Date.now() > until) throw failure;
    }
  }
  // The tables are read and made, and the count read, under the lock the changes are made under, so when two open a database at once, the second finds the first's tables made and its changes counted.
  db.exec("begin immediate");
  const had = new Set((db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((table) => table.name));
  db.exec(SCHEMA);
  const version = had.has("people") ? (db.prepare("pragma user_version").get() as { user_version: number }).user_version : TABLE_CHANGES.length;
  for (const change of TABLE_CHANGES.slice(version)) {
    if (typeof change === "string") db.exec(change);
    else if (had.has(change.table)) db.exec(change.change);
  }
  db.exec(INDEXES);
  db.exec(TRIGGERS);
  db.exec(`pragma user_version = ${Math.max(version, TABLE_CHANGES.length)}`);
  db.exec("commit");

  const agentHome = (agentId: string) => join(home, "agents", agentId);
  const avatarsHome = join(home, "avatars");
  const machinePath = join(home, "machine.json");
  const apiKeysPath = join(home, "api-keys.json");
  /**
   * Each person's API keys, by the person's id and then by provider, for the
   * people who have one. A key saved on its own, as Sidebots 1.0.2 saved one,
   * is a Claude Code key.
   */
  const apiKeys = (): Record<string, Partial<Record<Provider, string>>> => {
    if (!existsSync(apiKeysPath)) return {};
    const saved = JSON.parse(readFileSync(apiKeysPath, "utf8")) as Record<string, string | Partial<Record<Provider, string>>>;
    return Object.fromEntries(Object.entries(saved).map(([personId, keys]) => [personId, typeof keys === "string" ? { claude: keys } : keys]));
  };
  const connectionsPath = join(home, "connections.json");
  /** Each person's connections, by the person's id and then by connection, for the people who have made one. */
  const connections = (): Record<string, Partial<Record<Connection, Kept>>> => (existsSync(connectionsPath) ? JSON.parse(readFileSync(connectionsPath, "utf8")) : {});
  /** Saves a file only this account can read. The file is swapped in whole, since the server reads it for a turn that may start while it is being saved. */
  const swapIn = (path: string, contents: unknown) => {
    const written = `${path}.new`;
    writeFileSync(written, JSON.stringify(contents), { mode: 0o600 });
    renameSync(written, path);
  };
  const listeners = new Set<(change: Change) => void>();
  const changed = (change: Change) => listeners.forEach((listener) => listener(change));
  // The logins a provider last said are API keys since the server started, each as the person and the provider.
  const keyLogins = new Set<string>();
  const limitsOf = db.prepare(
    "select name, used, resets_at, at from limits where person_id = ? and provider = ? and (resets_at is null or resets_at > ?) order by resets_at, name",
  );
  /** How the person signs in to a provider. A limit whose time to reset has passed is left out, since nobody knows where it has stood since. */
  const planOf = (personId: string, provider: Provider): Plan => {
    const apiKey = apiKeys()[personId]?.[provider] !== undefined || keyLogins.has(`${personId} ${provider}`);
    return { provider, apiKey, limits: apiKey ? [] : (limitsOf.all(personId, provider, Date.now()) as Limit[]) };
  };

  const one = (sql: string, ...values: (string | number)[]): Message | undefined => {
    const row = db.prepare(sql).get(...values) as Row | undefined;
    return row && toMessage(row);
  };
  const many = (sql: string, ...values: (string | number)[]): Message[] => (db.prepare(sql).all(...values) as Row[]).map(toMessage);

  const pendingTurn = db.prepare(`select 1 from messages where ${FOR_AGENT} and ${UNFINISHED} limit 1`);
  // What waits to be read: the agent's replies, its asks that still wait, and Sidebots' failure notices. An ask the person answered, which they may have done in another agent's chat, is read.
  const unread = db.prepare(
    `select count(*) as unread from messages where agent_id = ? and created_at > ? and ${WITH_PERSON}
       and ((sender = 'agent' and interim = 0 and (ask is null or ask = 'waiting')) or (sender = 'sidebots' and status = 'failed'))`,
  );
  // What the agent asked other agents and hasn't heard back on, oldest first. It names the index, since SQLite left to choose reads the agent's whole chat for the order it comes in.
  const asked = (agentId: string): Message[] => many(`select * from messages indexed by messages_unfinished where agent_id = ? and ${ASKED} and ${UNFINISHED} order by rowid`, agentId);
  const agentById = (id: string): Agent | undefined => {
    const row = db.prepare("select * from agents where id = ?").get(id) as AgentRow | undefined;
    return row && toAgent(row);
  };
  const clearPushToken = db.prepare("update devices set push_token = null, environment = null, app = null where push_token = ?");
  const jobsFor = (agentId: string): Job[] => (db.prepare("select * from jobs where agent_id = ? order by next_at").all(agentId) as JobRow[]).map(toJob);
  const withLatest = (agent: Agent): AgentWithLatest => ({
    ...agent,
    latest: one(`select * from messages where agent_id = ? and ${WITH_PERSON} order by rowid desc limit 1`, agent.id) ?? null,
    working: pendingTurn.get(agent.id) !== undefined,
    unread: (unread.get(agent.id, agent.read_at) as { unread: number }).unread,
    waiting_on: asked(agent.id)[0]?.peer_id ?? null,
  });
  const agentWithLatest = (id: string): AgentWithLatest | undefined => {
    const agent = agentById(id);
    return agent && withLatest(agent);
  };
  /** Tells the listeners of a message, with its agent and, when it is between two, the other one. */
  const messageChanged = (message: Message) => {
    const agents = [message.agent_id, message.peer_id].map((id) => (id === null ? undefined : agentWithLatest(id)));
    changed({ message, agents: agents.filter((agent) => agent !== undefined) });
  };

  return {
    agentHome,

    /** Calls `listener` with every message that is added, changes status or has its ask closed, and every agent that is added, changed or deleted. Returns a function that stops it. */
    onChange(listener: (change: Change) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Copies the starter avatars in `from` that this server doesn't have yet. */
    installStarterAvatars(from: string): void {
      for (const id of readdirSync(from)) {
        if (AVATAR_ID.test(id) && !existsSync(join(avatarsHome, id))) cpSync(join(from, id), join(avatarsHome, id), { recursive: true });
      }
    },

    /**
     * The avatars, each with the colour it gives its agents' chats: the one its
     * avatar.json names, or its body colour, `b` in its design.json, made dark
     * enough to read white text on.
     */
    avatars(): Avatar[] {
      if (!existsSync(avatarsHome)) return [];
      return readdirSync(avatarsHome)
        .filter((id) => AVATAR_ID.test(id) && existsSync(join(avatarsHome, id, "avatar.json")))
        .map((id) => {
          const avatar = JSON.parse(readFileSync(join(avatarsHome, id, "avatar.json"), "utf8")) as Omit<Avatar, "color"> & { color?: string };
          const design = join(avatarsHome, id, "design.json");
          const body = existsSync(design) ? (JSON.parse(readFileSync(design, "utf8")) as { palette?: Record<string, string> }).palette?.b : undefined;
          const color = [avatar.color, body].find((each) => each !== undefined && COLOR.test(each));
          return { ...avatar, color: readableColor(color ?? DEFAULT_COLOR) };
        });
    },

    /** The path of an avatar's spritesheet, if the avatar exists. */
    avatarSheet(id: string): string | undefined {
      if (!AVATAR_ID.test(id) || !existsSync(join(avatarsHome, id, "avatar.json"))) return undefined;
      const avatar = JSON.parse(readFileSync(join(avatarsHome, id, "avatar.json"), "utf8")) as Avatar;
      const path = join(avatarsHome, id, avatar.spritesheetPath);
      return existsSync(path) ? path : undefined;
    },

    /**
     * Adds a person, with the config folder their agents sign in to a provider
     * with. Each person on a server has a name of their own, which the
     * commands know them by.
     */
    addPerson(input: { name: string; provider: Provider; configDir: string }): Person {
      const person: Person = { id: randomUUID(), name: input.name };
      db.exec("begin");
      db.prepare("insert into people (id, name) values (?, ?)").run(person.id, person.name);
      db.prepare("insert into accounts (person_id, provider, config_dir) values (?, ?, ?)").run(person.id, input.provider, input.configDir);
      db.exec("commit");
      return person;
    },

    /** Sets a person up on another provider, with the config folder their agents sign in to it with. */
    addAccount(personId: string, provider: Provider, configDir: string): void {
      db.prepare("insert into accounts (person_id, provider, config_dir) values (?, ?, ?)").run(personId, provider, configDir);
    },

    /** How the person's agents sign in to each provider they have set up, the first they set up first. */
    accounts(personId: string): Account[] {
      return db.prepare("select * from accounts where person_id = ? order by rowid").all(personId) as Account[];
    },

    account(personId: string, provider: Provider): Account | undefined {
      return db.prepare("select * from accounts where person_id = ? and provider = ?").get(personId, provider) as Account | undefined;
    },

    /** Everyone on this server, in the order they were added. */
    people(): Person[] {
      return db.prepare("select * from people order by rowid").all() as Person[];
    },

    personByName(name: string): Person | undefined {
      return db.prepare("select * from people where name = ?").get(name) as Person | undefined;
    },

    person(id: string): Person | undefined {
      return db.prepare("select * from people where id = ?").get(id) as Person | undefined;
    },

    /**
     * Has the person's agents on a provider run on this API key from their
     * next turn, or with no key, on the login in their config folder.
     */
    setApiKey(personId: string, provider: Provider, key: string | null): void {
      const keys = apiKeys();
      const theirs = { ...keys[personId] };
      if (key === null) delete theirs[provider];
      else theirs[provider] = key;
      keys[personId] = theirs;
      swapIn(apiKeysPath, keys);
    },

    /** The API key the person's agents on a provider run on. Without one, they use the login in the person's config folder. */
    apiKey(personId: string, provider: Provider): string | undefined {
      return apiKeys()[personId]?.[provider];
    },

    /** Keeps a connection the person made, for all their agents from their next turn, or forgets it. */
    setConnection(personId: string, connection: Connection, kept: Kept | null): void {
      const all = connections();
      const theirs = { ...all[personId] };
      if (kept === null) delete theirs[connection];
      else theirs[connection] = kept;
      all[personId] = theirs;
      swapIn(connectionsPath, all);
    },

    /** What Sidebots keeps of a connection the person made. Nothing for one they haven't. */
    connection(personId: string, connection: Connection): Kept | undefined {
      return connections()[personId]?.[connection];
    },

    /** Adds an agent that runs on a provider, on the model and effort a new agent starts on there. */
    createAgent(person: Person, name: string, avatarId: string, provider: Provider): Agent {
      const now = Date.now();
      const agent: Agent = {
        id: randomUUID(),
        person_id: person.id,
        name,
        avatar_id: avatarId,
        provider,
        model: PROVIDERS[provider].model,
        effort: PROVIDERS[provider].effort,
        fast: false,
        ran_on: null,
        muted: false,
        hidden: false,
        color: null,
        session_id: null,
        read_at: now,
        chat_changes: 0,
        created_at: now,
      };
      const folder = agentHome(agent.id);
      mkdirSync(join(folder, "memory"), { recursive: true });
      mkdirSync(join(folder, "attachments"), { recursive: true });
      writeFileSync(join(folder, PROVIDERS[agent.provider].instructions), instructions(name, person.name));
      db.prepare(
        "insert into agents (id, person_id, name, avatar_id, provider, model, effort, session_id, read_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        agent.id,
        agent.person_id,
        agent.name,
        agent.avatar_id,
        agent.provider,
        agent.model,
        agent.effort,
        null,
        agent.read_at,
        agent.created_at,
      );
      changed({ agent: withLatest(agent), deleted: false });
      return agent;
    },

    agent: agentById,

    agentWithLatest,

    /** The person's agents, each with its latest message, most recent chat first. */
    agentsFor(personId: string): AgentWithLatest[] {
      const agents = (db.prepare("select * from agents where person_id = ?").all(personId) as AgentRow[]).map(toAgent);
      return agents
        .map(withLatest)
        .sort((a, b) => (b.latest?.created_at ?? b.created_at) - (a.latest?.created_at ?? a.created_at));
    },

    /**
     * Changes an agent's name, avatar or colour, what it answers with, or
     * whether it is muted or hidden. A new name is written into the agent's
     * instructions where they say who it is. An agent moved to another
     * provider takes its instructions with it, in the file that provider
     * reads.
     */
    updateAgent(agent: Agent, changes: AgentChanges): void {
      const columns = Object.keys(changes) as (keyof AgentChanges)[];
      if (columns.length === 0) return;
      const next = { ...agent, ...changes };
      const values = columns.map((column) => (typeof changes[column] === "boolean" ? Number(changes[column]) : changes[column]!));
      db.prepare(`update agents set ${columns.map((column) => `${column} = ?`).join(", ")} where id = ?`).run(...values, agent.id);
      const instructions = (provider: Provider) => join(agentHome(agent.id), PROVIDERS[provider].instructions);
      if (next.provider !== agent.provider && existsSync(instructions(agent.provider))) renameSync(instructions(agent.provider), instructions(next.provider));
      if (next.name !== agent.name) {
        const text = readFileSync(instructions(next.provider), "utf8");
        writeFileSync(instructions(next.provider), text.replace(`# ${agent.name}\n`, `# ${next.name}\n`).replace(`You are ${agent.name},`, `You are ${next.name},`));
      }
      changed({ agent: withLatest(next), deleted: false });
    },

    /** Records what the agent's turn runs on, as the turn starts. */
    setRanOn(agentId: string, selection: Selection): void {
      db.prepare("update agents set ran_on = ? where id = ?").run(JSON.stringify(selectionOf(selection)), agentId);
    },

    /**
     * Removes an agent and everything Sidebots kept for it: its messages, its
     * jobs, what it used and its home folder. The agents it had talked with
     * are told of after it, as they now stand, since their chats lost what
     * the two said to each other.
     */
    deleteAgent(agent: Agent): void {
      const talkedWith = db.prepare("select agent_id as id from messages where peer_id = ?1 union select peer_id from messages where agent_id = ?1 and peer_id is not null").all(agent.id) as { id: string }[];
      db.prepare("delete from usage where agent_id = ?").run(agent.id);
      db.prepare("delete from jobs where agent_id = ?").run(agent.id);
      db.prepare("delete from messages where agent_id = ?").run(agent.id);
      // What other agents said to it goes too, and an ask raised while working for it stays as its own agent's.
      db.prepare("delete from messages where peer_id = ? and ask is null").run(agent.id);
      db.prepare("update messages set peer_id = null where peer_id = ?").run(agent.id);
      db.prepare("delete from agents where id = ?").run(agent.id);
      rmSync(agentHome(agent.id), { recursive: true, force: true });
      changed({ agent, deleted: true });
      for (const { id } of talkedWith) changed({ agent: agentWithLatest(id)!, deleted: false });
    },

    /** The instructions an agent follows, what it remembers and its jobs. */
    about(agent: Agent): About {
      const folder = agentHome(agent.id);
      const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
      const memory = join(folder, "memory");
      // MEMORY.md is the agent's list of the other files.
      const files = existsSync(memory) ? readdirSync(memory).filter((file) => file.endsWith(".md") && file !== "MEMORY.md") : [];
      return {
        instructions: read(join(folder, PROVIDERS[agent.provider].instructions)),
        memories: files.sort().map((file) => toMemory(file, read(join(memory, file)))),
        jobs: jobsFor(agent.id),
      };
    },

    addJob(agentId: string, what: string, schedule: Schedule, nextAt: number): Job {
      const job: Job = { id: randomUUID().slice(0, 8), agent_id: agentId, what, schedule, next_at: nextAt, created_at: Date.now() };
      db.prepare("insert into jobs (id, agent_id, what, schedule, next_at, created_at) values (?, ?, ?, ?, ?, ?)").run(
        job.id,
        job.agent_id,
        job.what,
        JSON.stringify(schedule),
        job.next_at,
        job.created_at,
      );
      return job;
    },

    /** The agent's jobs, the next to run first. */
    jobs: jobsFor,

    /** Removes one of the agent's jobs. False when the agent has no such job. */
    removeJob(agentId: string, jobId: string): boolean {
      return db.prepare("delete from jobs where id = ? and agent_id = ?").run(jobId, agentId).changes > 0;
    },

    setJobNext(jobId: string, nextAt: number): void {
      db.prepare("update jobs set next_at = ? where id = ?").run(nextAt, jobId);
    },

    /** The agent's job that has waited longest past its time. */
    dueJob(agentId: string, now: number): Job | undefined {
      const row = db.prepare("select * from jobs where agent_id = ? and next_at <= ? order by next_at limit 1").get(agentId, now) as JobRow | undefined;
      return row && toJob(row);
    },

    /** The agents with a job whose time has come. */
    agentsWithDueJobs(now: number): string[] {
      const rows = db.prepare("select distinct agent_id from jobs where next_at <= ?").all(now) as { agent_id: string }[];
      return rows.map((row) => row.agent_id);
    },

    /**
     * What a session had cost in all, and the tokens it had used, as of the
     * last turn recorded in it, or nothing when none is. The tokens are null
     * when that turn was recorded without them.
     */
    sessionUsed(agentId: string, sessionId: string): { cost: number; tokens: number | null } | undefined {
      return db.prepare("select session_cost as cost, session_tokens as tokens from usage where agent_id = ? and session_id = ? order by rowid desc limit 1").get(agentId, sessionId) as
        | { cost: number; tokens: number | null }
        | undefined;
    },

    /**
     * Records a turn the agent ran, with what it cost and the tokens it used.
     * A provider says what a session has used in all, so a turn's part is
     * what its session has used since the turn before it there, or all of it
     * once the session's count has started again. `resumed` says the session
     * had turns before this one. When what they had used isn't recorded,
     * nobody can tell how much of the total is this turn's, and the turn is
     * recorded as using nothing.
     */
    addUsage(agentId: string, kind: TurnKind, session: { sessionId: string; cost: number; tokens: number }, resumed: boolean): void {
      const last = this.sessionUsed(agentId, session.sessionId);
      const part = (total: number, recorded: number | null | undefined) => {
        const before = recorded ?? (resumed ? total : 0);
        return total >= before ? total - before : total;
      };
      db.prepare("insert into usage (agent_id, kind, cost, session_id, session_cost, at, tokens, session_tokens) values (?, ?, ?, ?, ?, ?, ?, ?)").run(
        agentId,
        kind,
        part(session.cost, last?.cost),
        session.sessionId,
        session.cost,
        Date.now(),
        part(session.tokens, last?.tokens),
        session.tokens,
      );
    },

    /**
     * Keeps what a provider just said of the person's login in their config
     * folder: where the limits of its plan stand, or null when the login is an
     * API key, which has no plan. Tells the listeners how the person now signs
     * in to the provider.
     */
    setLimits(personId: string, provider: Provider, limits: Limit[] | null): void {
      if (limits) {
        keyLogins.delete(`${personId} ${provider}`);
        const keep = db.prepare("insert or replace into limits (person_id, provider, name, used, resets_at, at) values (?, ?, ?, ?, ?, ?)");
        for (const limit of limits) keep.run(personId, provider, limit.name, limit.used, limit.resets_at, limit.at);
      } else keyLogins.add(`${personId} ${provider}`);
      changed({ person_id: personId, plan: planOf(personId, provider) });
    },

    /**
     * Where the person's plan or API credit goes: the turns their agents ran
     * in the last days, added up by agent and by day, and how they sign in to
     * each provider, as the providers last said.
     */
    usage(personId: string): Usage {
      const now = Date.now();
      const today = new Date(now);
      // Each day's midnight on the computer, and the one that ends today. A change of the clocks makes a day an hour off 24.
      const starts = Array.from({ length: USAGE_DAYS + 1 }, (_, index) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - USAGE_DAYS + 1 + index));
      const turns = "from usage join agents on agents.id = usage.agent_id where agents.person_id = ?1 and usage.at >= ?2";
      const used = db
        .prepare(`select usage.agent_id, usage.kind, count(*) as turns, sum(usage.cost) as cost, sum(usage.tokens) as tokens ${turns} group by usage.agent_id, usage.kind`)
        .all(personId, starts[0].getTime()) as Used[];
      // What the turns of each day add up to, for the days that had one. A turn's day is the first that ends after it, and each day's end is a value from `?3` on.
      const ends = starts.slice(1).map((end) => end.getTime());
      const spent = db
        .prepare(`select case ${ends.map((_, nth) => `when usage.at < ?${nth + 3} then ${nth}`).join(" ")} end as nth, sum(usage.cost) as cost, sum(usage.tokens) as tokens ${turns} group by nth`)
        .all(personId, starts[0].getTime(), ...ends) as (Pick<Day, "cost" | "tokens"> & { nth: number | null })[];
      const two = (value: number) => String(value).padStart(2, "0");
      const days = starts.slice(0, -1).map((start, index) => {
        const { cost = 0, tokens = 0 } = spent.find((each) => each.nth === index) ?? {};
        return { day: `${start.getFullYear()}-${two(start.getMonth() + 1)}-${two(start.getDate())}`, cost, tokens };
      });
      const providers = db.prepare("select provider from accounts where person_id = ? order by rowid").all(personId) as Pick<Account, "provider">[];
      return { used, days, accounts: providers.map(({ provider }) => planOf(personId, provider)) };
    },

    /**
     * What the server tells the relay of how much it is used: its agents and
     * paired phones, and the turns of the last `USAGE_DAYS` days, each on its
     * date on the computer. A server whose owner turned the counts off and on
     * again counts from when they came back on, so it tells nothing of the
     * time they were off.
     */
    counts(): Counts {
      const today = new Date();
      const on = db.prepare("select value from settings where name = 'counts'").get() as { value: string } | undefined;
      const since = Math.max(new Date(today.getFullYear(), today.getMonth(), today.getDate() - USAGE_DAYS + 1).getTime(), Number(on?.value ?? 0));
      return {
        agents: (db.prepare("select count(*) as agents from agents").get() as { agents: number }).agents,
        phones: (db.prepare("select count(*) as phones from devices where kind = 'phone'").get() as { phones: number }).phones,
        turns: db
          .prepare(
            `select date(usage.at / 1000, 'unixepoch', 'localtime') as day, agents.provider, usage.kind, count(*) as turns
               from usage join agents on agents.id = usage.agent_id where usage.at >= ? group by day, agents.provider, usage.kind`,
          )
          .all(since) as Counts["turns"],
      };
    },

    /** Whether the server tells the relay how much it is used, which it does unless its owner turned that off. */
    counting(): boolean {
      return db.prepare("select 1 from settings where name = 'counts' and value = 'off'").get() === undefined;
    },

    /** Turns on or off what the server tells the relay of how much it is used. The setting is `off`, or when the counts came on, in milliseconds since 1970. */
    setCounting(on: boolean): void {
      if (on) db.prepare("update settings set value = ? where name = 'counts' and value = 'off'").run(String(Date.now()));
      else db.prepare("insert or replace into settings (name, value) values ('counts', 'off')").run();
    },

    /** Records that the person has read everything in the chat so far, and says so when that leaves less unread, so their other devices hear of it. Returns the agent as the home screen now shows it. */
    markRead(agentId: string): AgentWithLatest | undefined {
      const shown = agentWithLatest(agentId);
      if (!shown || shown.unread === 0) return shown;
      const readAt = Date.now();
      db.prepare("update agents set read_at = ? where id = ?").run(readAt, agentId);
      const read = withLatest({ ...shown, read_at: readAt });
      changed({ agent: read, deleted: false });
      return read;
    },

    setSession(agentId: string, sessionId: string | null): void {
      db.prepare("update agents set session_id = ? where id = ?").run(sessionId, agentId);
    },

    /**
     * Saves a message, with any files sent with it written into the agent's
     * `attachments/` folder. A reply, an ask or a failure notice brings a hidden
     * agent back to the home screen, unless the agent is muted. An update while
     * the agent works doesn't, and neither does what it says to another agent.
     */
    addMessage(agentId: string, sender: Sender, body: string, status: Status, { files = [], replyTo, jobId, interim = false, ask, question, peerId, switched }: Extras = {}): Message {
      const attachments = files.map((file) => {
        // A name keeps its letters, digits, dots and dashes. Anything else becomes a dash, as does a %20 the phone wrote for a space.
        const name = `${randomUUID().slice(0, 8)}-${basename(file.name).replace(/(?:%[0-9a-f]{2}|[^\w.-])+/gi, "-")}`;
        writeFileSync(join(agentHome(agentId), "attachments", name), file.bytes);
        return `attachments/${name}`;
      });
      const message: Message = {
        id: randomUUID(),
        agent_id: agentId,
        sender,
        body,
        attachments,
        status,
        seen_at: null,
        reply_to: replyTo ?? null,
        job_id: jobId ?? null,
        interim,
        ask: ask ?? null,
        question: question ?? null,
        peer_id: peerId ?? null,
        switched: switched ?? null,
        created_at: Date.now(),
      };
      db.prepare("insert into messages (id, agent_id, sender, body, attachments, status, reply_to, job_id, interim, ask, question, peer_id, switched, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        message.id,
        message.agent_id,
        message.sender,
        message.body,
        JSON.stringify(attachments),
        message.status,
        message.reply_to,
        message.job_id,
        Number(interim),
        message.ask,
        question ? JSON.stringify(question) : null,
        message.peer_id,
        switched ? JSON.stringify(switched) : null,
        message.created_at,
      );
      if ((sender === "agent" && !interim && !betweenAgents(message)) || (sender === "sidebots" && status === "failed")) {
        db.prepare("update agents set hidden = 0 where id = ? and muted = 0").run(agentId);
      }
      messageChanged(message);
      return message;
    },

    /**
     * A file the agent names to send with a message, by its path in full or
     * from the agent's home folder, as it is now. Nothing when no file is
     * there. A file of more than `room` bytes is sized and never read, and is
     * answered as too big.
     */
    fileToSend(agentId: string, path: string, room: number): Upload | "too big" | undefined {
      const full = resolve(agentHome(agentId), path);
      const file = statSync(full, { throwIfNoEntry: false });
      if (!file?.isFile()) return undefined;
      return file.size > room ? "too big" : { name: basename(full), bytes: readFileSync(full) };
    },

    /** The path of a file in the agent's `attachments/` folder, if it is there. */
    attachment(agentId: string, name: string): string | undefined {
      if (!ATTACHMENT_NAME.test(name)) return undefined;
      const path = join(agentHome(agentId), "attachments", name);
      return statSync(path, { throwIfNoEntry: false })?.isFile() ? path : undefined;
    },

    /** Records that an agent has read these messages, from the person or from another agent, the ones it hadn't yet. */
    markSeen(messageIds: string[]): void {
      const now = Date.now();
      for (const id of messageIds) {
        const read = db.prepare("update messages set status = 'running', seen_at = ? where id = ? and sender != 'sidebots' and status = 'queued'").run(now, id);
        const message = read.changes ? one("select * from messages where id = ?", id) : undefined;
        if (message) messageChanged(message);
      }
    },

    setStatus(messageId: string, status: Status): void {
      db.prepare("update messages set status = ? where id = ?").run(status, messageId);
      const message = one("select * from messages where id = ?", messageId);
      if (message) messageChanged(message);
    },

    /** Records where an ask that was waiting now stands. */
    answerAsk(messageId: string, answer: Exclude<Ask, "waiting">): void {
      const answered = db.prepare("update messages set ask = ? where id = ? and ask = 'waiting'").run(answer, messageId).changes > 0;
      const message = answered ? one("select * from messages where id = ?", messageId) : undefined;
      if (message) messageChanged(message);
    },

    /**
     * A chat, oldest first: everything after a known message, the page before
     * one, or the latest page. With `through` as well as `before`, it is the
     * run from the message `through` names to the one `before` names, both of
     * them in it, or the first `RUN` of it when it is longer. What the agent and another
     * agent said to each other is in both their chats.
     */
    messages(agentId: string, { after, before, through }: { after?: string; before?: string; through?: string } = {}): Message[] {
      const known = "(select rowid from messages where id = ?2)";
      // A limit below zero is no limit.
      if (after) return many(`select * from messages where ${pageOfChat(`rowid > ${known}`, "-1")} order by rowid`, agentId, after);
      if (before && through) {
        const from = `(select rowid from messages where ${IN_CHAT} and id = ?3)`;
        return many(`select * from messages where ${pageOfChat(`rowid between ${from} and ${known}`, "?4", "oldest")} order by rowid`, agentId, before, through, RUN);
      }
      if (before) return many(`select * from messages where ${pageOfChat(`rowid < ${known}`, "?3")} order by rowid`, agentId, before, PAGE);
      return many(`select * from messages where ${pageOfChat("true", "?2")} order by rowid`, agentId, PAGE);
    },

    /** A message, if it is in the agent's chat. */
    message(agentId: string, id: string): Message | undefined {
      return one(`select * from messages where ${IN_CHAT} and id = ?2`, agentId, id);
    },

    /** What the agent asked other agents and hasn't heard back on, oldest first. */
    asked,

    /** What other agents asked the agent that it has read and not answered, oldest first. */
    askedOf(agentId: string): Message[] {
      return many(`select * from messages where peer_id = ? and ${ASKED} and status = 'running' order by rowid`, agentId);
    },

    /**
     * The latest `limit` of what the agent's jobs have sent since the agent
     * last replied in the chat, before a message, oldest first. The session a
     * reply comes from never saw them. It reads back from the message and
     * stops at that reply, so it reads what it returns and one message more.
     */
    sentByJobsBefore(agentId: string, messageId: string, limit: number): Message[] {
      const latest: Message[] = [];
      const back = db.prepare(
        `select * from messages where sender = 'agent' and ${WITH_PERSON} and agent_id = ?1 and rowid < (select rowid from messages where id = ?2)
         order by rowid desc limit ?3`,
      );
      for (const row of back.iterate(agentId, messageId, limit) as Iterable<Row>) {
        if (row.job_id === null) break;
        latest.push(toMessage(row));
      }
      return latest.reverse();
    },

    /** The last few things the person and the agent said to each other before a message, oldest first. */
    messagesBefore(agentId: string, messageId: string, limit: number): Message[] {
      return many(
        `select * from messages where sender != 'sidebots' and ${WITH_PERSON} and agent_id = ?1 and rowid < (select rowid from messages where id = ?2)
         order by rowid desc limit ?3`,
        agentId,
        messageId,
        limit,
      ).reverse();
    },

    /** Messages containing `text` in any chat of the person's, newest first. */
    searchMessages(personId: string, text: string): Found[] {
      const pattern = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
      return db
        .prepare(
          `select messages.id, messages.agent_id, agents.name as agent, messages.sender, messages.body, messages.created_at
           from messages join agents on agents.id = messages.agent_id
           where agents.person_id = ? and messages.sender != 'sidebots' and messages.body like ? escape '\\'
           order by messages.rowid desc limit ?`,
        )
        .all(personId, pattern, SEARCH_LIMIT) as Found[];
    },

    /** The messages from the person that wait for the agent to read them, oldest first. */
    waitingFromPerson(agentId: string): Message[] {
      return many("select * from messages where agent_id = ? and sender = 'person' and status = 'queued' order by rowid", agentId);
    },

    /** The oldest message that waits for the agent's turn: the person's, a fresh start, or another agent's to it. */
    nextQueued(agentId: string): Message | undefined {
      return one(`select * from messages where ${FOR_AGENT} and status = 'queued' order by rowid limit 1`, agentId);
    },

    /**
     * Puts turns that a stopped server left running back in the queue, with
     * the asks they left waiting closed, and lists the agents with queued
     * turns. A switch notice that was handing over is done with, since the
     * turn it came before hands over again.
     */
    requeueInterrupted(): string[] {
      db.prepare("update messages set status = 'done' where status = 'running' and switched is not null").run();
      db.prepare("update messages set status = 'queued' where status = 'running'").run();
      db.prepare("update messages set ask = 'unanswered' where ask = 'waiting'").run();
      // A message one agent sent another waits in the other's queue.
      const rows = db.prepare("select distinct coalesce(peer_id, agent_id) as agent_id from messages where status = 'queued'").all() as { agent_id: string }[];
      return rows.map((row) => row.agent_id);
    },

    /** Makes a code that pairs one device as the person, once, within `life` milliseconds, which is ten minutes unless one is given. Returns the code and when it expires. */
    addPairing(personId: string, life = PAIRING_MS): { code: string; expiresAt: number } {
      const now = Date.now();
      db.prepare("delete from pairings where expires_at <= ?").run(now);
      const code = secret();
      const expiresAt = now + life;
      db.prepare("insert into pairings (code_hash, person_id, expires_at) values (?, ?, ?)").run(hashOf(code), personId, expiresAt);
      return { code, expiresAt };
    },

    /**
     * Pairs a device that brings a pairing code, and uses the code up. A device
     * that pairs again brings the hash of the key it had as `replaces`, and
     * this pairing takes that one's place. Returns the key the device sends
     * with every request from then on and the key a phone's notifications are
     * encrypted with, or nothing when the code is unknown, used or too old.
     */
    pair(code: string, name: string, kind: DeviceKind, replaces?: string): { key: string; notificationKey: string } | undefined {
      const pairing = db.prepare("delete from pairings where code_hash = ? returning person_id, expires_at").get(hashOf(code)) as
        | { person_id: string; expires_at: number }
        | undefined;
      if (!pairing || pairing.expires_at <= Date.now()) return undefined;
      if (replaces) db.prepare("delete from devices where key_hash = ?").run(replaces);
      const key = secret();
      // The server encrypts with this one, so it keeps the key itself. The phone reads it in base64.
      const notificationKey = randomBytes(32).toString("base64");
      db.prepare("insert into devices (id, person_id, name, kind, key_hash, notification_key, paired_at) values (?, ?, ?, ?, ?, ?, ?)").run(
        randomUUID(),
        pairing.person_id,
        name,
        kind,
        hashOf(key),
        notificationKey,
        Date.now(),
      );
      return { key, notificationKey };
    },

    /** Every paired device, the first to pair first. */
    devices(): Device[] {
      return db.prepare("select id, person_id, name, kind, paired_at from devices order by rowid").all() as Device[];
    },

    /** Unpairs a device, which is refused from its next request. Returns the device, or nothing when no device has the id. */
    removeDevice(id: string): Device | undefined {
      return db.prepare("delete from devices where id = ? returning id, person_id, name, kind, paired_at").get(id) as Device | undefined;
    },

    /** The paired device that holds this key. */
    deviceByKey(key: string): Device | undefined {
      return db.prepare("select id, person_id, name, kind, paired_at from devices where key_hash = ?").get(hashOf(key)) as Device | undefined;
    },

    /** Remembers where Apple delivers a phone's notifications. A token another paired phone held becomes this one's. */
    setPushToken(deviceId: string, push: PushToken): void {
      clearPushToken.run(push.token);
      db.prepare("update devices set push_token = ?, environment = ?, app = ? where id = ?").run(push.token, push.environment, push.app ?? null, deviceId);
    },

    /** Where Apple delivers the notifications of the person's phones, for the phones that allow them, with each phone's notification key. */
    pushTargetsFor(personId: string): PushTarget[] {
      return db
        .prepare("select push_token as token, environment, app, notification_key as notificationKey from devices where person_id = ? and push_token is not null")
        .all(personId)
        .map(({ app, ...target }) => (app === null ? target : { ...target, app })) as PushTarget[];
    },

    /** Forgets a token Apple no longer delivers to. The phone stays paired. */
    clearPushToken(token: string): void {
      clearPushToken.run(token);
    },

    /** Remembers where Apple delivers to the Live Activity a phone shows for a working agent. A phone shows one for an agent at a time, so a new one takes the last one's place. */
    setActivityToken(deviceId: string, agentId: string, push: PushToken): void {
      db.prepare(
        "insert into activities (device_id, agent_id, token, environment, app) values (?1, ?2, ?3, ?4, ?5) on conflict (device_id, agent_id) do update set token = ?3, environment = ?4, app = ?5",
      ).run(deviceId, agentId, push.token, push.environment, push.app ?? null);
    },

    /** Where Apple delivers to the Live Activities phones show for an agent. It forgets them as it answers, since each ends with the one push its token is for. */
    endActivities(agentId: string): PushToken[] {
      return db
        .prepare("delete from activities where agent_id = ? returning token, environment, app")
        .all(agentId)
        .map(({ app, ...target }) => (app === null ? target : { ...target, app })) as PushToken[];
    },

    /** Keeps how this server is known to the relay, readable only by the server's user account. */
    setMachine(machine: Machine): void {
      writeFileSync(machinePath, JSON.stringify(machine), { mode: 0o600 });
    },

    machine(): Machine | undefined {
      return existsSync(machinePath) ? (JSON.parse(readFileSync(machinePath, "utf8")) as Machine) : undefined;
    },

    close(): void {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;
