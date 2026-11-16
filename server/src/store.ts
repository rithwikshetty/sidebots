// The store owns the database and the agent folders. Nothing else touches
// SQLite or ~/.sidebots.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_EFFORT, DEFAULT_MODEL } from "./contract.ts";
import type { About, Agent, AgentWithLatest, Avatar, Found, Job, Memory, Message, PushToken, Schedule, Sender, Status } from "./contract.ts";

export type Person = { id: string; name: string; claude_config_dir: string };
/** A phone that has paired with this server, and the person whose agents it reaches. */
export type Device = { id: string; person_id: string; name: string; paired_at: number };
/** Where Apple delivers a phone's notifications, and the key, in base64, that only that phone can read them with. */
export type PushTarget = PushToken & { notificationKey: string };
/** A file as it arrives with a message. */
export type Upload = { name: string; bytes: Uint8Array };
/** What a message can carry besides its text: files, the message it answers, and the job that sent it. */
export type Extras = { files?: Upload[]; replyTo?: string; jobId?: string; interim?: boolean };
/** What the person can change about an agent. */
export type AgentChanges = Partial<Pick<Agent, "name" | "avatar_id" | "model" | "effort" | "muted" | "hidden">>;
/** How this server is known to the relay: its signing key, and the id the relay gave it once it has registered. */
export type Machine = { privateKey: string; id?: string };

const SCHEMA = `
create table if not exists people (
  id                text primary key,
  name              text not null unique,
  claude_config_dir text not null
);
create table if not exists agents (
  id          text primary key,
  person_id   text not null references people(id),
  name        text not null,
  avatar_id   text not null,
  model       text not null default 'opus',
  effort      text not null default 'medium',
  muted       integer not null default 0,
  hidden      integer not null default 0,
  session_id  text,
  read_at     integer not null default 0,
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
  paired_at   integer not null
);
create table if not exists pairings (
  code_hash  text primary key,
  person_id  text not null references people(id),
  expires_at integer not null
);
`;

const PAGE = 50;
const SEARCH_LIMIT = 20;
const AVATAR_ID = /^[a-z0-9-]+$/;
// A stored attachment's file name: no folders, and never a dot first.
const ATTACHMENT_NAME = /^[\w-][\w.-]*$/;
// How long a pairing code works.
const PAIRING_MS = 10 * 60_000;

/** A pairing code or a device key: 32 random bytes, as text that fits in a link. */
const secret = () => randomBytes(32).toString("base64url");
/** What the database keeps of a secret, so that nobody who reads the database can use it. */
const hashOf = (value: string) => createHash("sha256").update(value).digest("hex");

/** A message as SQLite holds it, with its attachments as JSON text and yes and no as 1 and 0. */
type Row = Omit<Message, "attachments" | "interim"> & { attachments: string; interim: number };
const toMessage = (row: Row): Message => ({ ...row, attachments: JSON.parse(row.attachments) as string[], interim: row.interim === 1 });
/** An agent as SQLite holds it, with yes and no as 1 and 0. */
type AgentRow = Omit<Agent, "muted" | "hidden"> & { muted: number; hidden: number };
const toAgent = (row: AgentRow): Agent => ({ ...row, muted: row.muted === 1, hidden: row.hidden === 1 });
type JobRow = Omit<Job, "schedule"> & { schedule: string };
const toJob = (row: JobRow): Job => ({ ...row, schedule: JSON.parse(row.schedule) as Schedule });

/** A memory file as Claude Code writes one: a name and a description between `---` lines, then the memory itself. */
function toMemory(file: string, text: string): Memory {
  const [, head = "", body = text] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text) ?? [];
  const field = (name: string) => new RegExp(`^${name}:\\s*"?(.*?)"?\\s*$`, "m").exec(head)?.[1] ?? "";
  return { name: field("name") || file.replace(/\.md$/, ""), description: field("description"), body: body.trim() };
}

function instructions(agentName: string, personName: string): string {
  return `# ${agentName}

You are ${agentName}, one of ${personName}'s agents in Sidebots. Sidebots is a messaging app on their iPhone, and each agent is one chat in it.

${personName} only sees your final reply, as a text message on their phone. They never see your tool calls or working steps. Write the way a capable person texts: short, plain sentences, no headings or tables unless they ask for them.

Your home folder is where you run. Files ${personName} sends you are in \`attachments/\`.

You don't know what you're for yet. If this is a new chat, ask what ${personName} wants you to help with, then write what you're for into this file. What you learn along the way goes in your memory.
`;
}

export function openStore(home: string) {
  mkdirSync(join(home, "agents"), { recursive: true });
  const db = new DatabaseSync(join(home, "sidebots.sqlite"));
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
  db.exec(SCHEMA);

  const agentHome = (agentId: string) => join(home, "agents", agentId);
  const avatarsHome = join(home, "avatars");
  const machinePath = join(home, "machine.json");
  const apiKeysPath = join(home, "api-keys.json");
  /** Each person's Anthropic API key, by the person's id, for the people who have one. */
  const apiKeys = (): Record<string, string> => (existsSync(apiKeysPath) ? (JSON.parse(readFileSync(apiKeysPath, "utf8")) as Record<string, string>) : {});
  const listeners = new Set<(message: Message) => void>();
  const changed = (message: Message) => listeners.forEach((listener) => listener(message));

  const one = (sql: string, ...values: (string | number)[]): Message | undefined => {
    const row = db.prepare(sql).get(...values) as Row | undefined;
    return row && toMessage(row);
  };
  const many = (sql: string, ...values: (string | number)[]): Message[] => (db.prepare(sql).all(...values) as Row[]).map(toMessage);

  const pendingTurn = db.prepare("select 1 from messages where agent_id = ? and status in ('queued', 'running') limit 1");
  // What waits to be read: the agent's replies and Sidebots' failure notices.
  const unread = db.prepare(
    "select count(*) as unread from messages where agent_id = ? and created_at > ? and ((sender = 'agent' and interim = 0) or (sender = 'sidebots' and status = 'failed'))",
  );
  const agentById = (id: string): Agent | undefined => {
    const row = db.prepare("select * from agents where id = ?").get(id) as AgentRow | undefined;
    return row && toAgent(row);
  };
  const clearPushToken = db.prepare("update devices set push_token = null, environment = null where push_token = ?");
  const jobsFor = (agentId: string): Job[] => (db.prepare("select * from jobs where agent_id = ? order by next_at").all(agentId) as JobRow[]).map(toJob);
  const withLatest = (agent: Agent): AgentWithLatest => ({
    ...agent,
    latest: one("select * from messages where agent_id = ? order by rowid desc limit 1", agent.id) ?? null,
    working: pendingTurn.get(agent.id) !== undefined,
    unread: (unread.get(agent.id, agent.read_at) as { unread: number }).unread,
  });

  return {
    agentHome,

    /** Calls `listener` with every message that is added or changes status. Returns a function that stops it. */
    onMessage(listener: (message: Message) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Copies the starter avatars in `from` that this server doesn't have yet. */
    installStarterAvatars(from: string): void {
      for (const id of readdirSync(from)) {
        if (AVATAR_ID.test(id) && !existsSync(join(avatarsHome, id))) cpSync(join(from, id), join(avatarsHome, id), { recursive: true });
      }
    },

    avatars(): Avatar[] {
      if (!existsSync(avatarsHome)) return [];
      return readdirSync(avatarsHome)
        .filter((id) => AVATAR_ID.test(id) && existsSync(join(avatarsHome, id, "avatar.json")))
        .map((id) => JSON.parse(readFileSync(join(avatarsHome, id, "avatar.json"), "utf8")) as Avatar);
    },

    /** The path of an avatar's spritesheet, if the avatar exists. */
    avatarSheet(id: string): string | undefined {
      if (!AVATAR_ID.test(id) || !existsSync(join(avatarsHome, id, "avatar.json"))) return undefined;
      const avatar = JSON.parse(readFileSync(join(avatarsHome, id, "avatar.json"), "utf8")) as Avatar;
      const path = join(avatarsHome, id, avatar.spritesheetPath);
      return existsSync(path) ? path : undefined;
    },

    /** Adds a person. Each person on a server has a name of their own, which the commands know them by. */
    addPerson(input: { name: string; configDir: string }): Person {
      const person: Person = { id: randomUUID(), name: input.name, claude_config_dir: input.configDir };
      db.prepare("insert into people (id, name, claude_config_dir) values (?, ?, ?)").run(person.id, person.name, person.claude_config_dir);
      return person;
    },

    personByName(name: string): Person | undefined {
      return db.prepare("select * from people where name = ?").get(name) as Person | undefined;
    },

    person(id: string): Person | undefined {
      return db.prepare("select * from people where id = ?").get(id) as Person | undefined;
    },

    /**
     * Has the person's agents run on this Anthropic API key, from their next
     * turn. The file is swapped in whole, since the server reads it for a turn
     * that may start while a key is being saved.
     */
    setApiKey(personId: string, key: string): void {
      const written = `${apiKeysPath}.new`;
      writeFileSync(written, JSON.stringify({ ...apiKeys(), [personId]: key }), { mode: 0o600 });
      renameSync(written, apiKeysPath);
    },

    /** The Anthropic API key the person's agents run on. A person without one uses the Claude login in their config folder. */
    apiKey(personId: string): string | undefined {
      return apiKeys()[personId];
    },

    createAgent(person: Person, name: string, avatarId: string): Agent {
      const now = Date.now();
      const agent: Agent = {
        id: randomUUID(),
        person_id: person.id,
        name,
        avatar_id: avatarId,
        model: DEFAULT_MODEL,
        effort: DEFAULT_EFFORT,
        muted: false,
        hidden: false,
        session_id: null,
        read_at: now,
        created_at: now,
      };
      const folder = agentHome(agent.id);
      mkdirSync(join(folder, "memory"), { recursive: true });
      mkdirSync(join(folder, "attachments"), { recursive: true });
      writeFileSync(join(folder, "CLAUDE.md"), instructions(name, person.name));
      db.prepare("insert into agents (id, person_id, name, avatar_id, model, effort, session_id, read_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        agent.id,
        agent.person_id,
        agent.name,
        agent.avatar_id,
        agent.model,
        agent.effort,
        null,
        agent.read_at,
        agent.created_at,
      );
      return agent;
    },

    agent: agentById,

    agentWithLatest(id: string): AgentWithLatest | undefined {
      const agent = agentById(id);
      return agent && withLatest(agent);
    },

    /** The person's agents, each with its latest message, most recent chat first. */
    agentsFor(personId: string): AgentWithLatest[] {
      const agents = (db.prepare("select * from agents where person_id = ?").all(personId) as AgentRow[]).map(toAgent);
      return agents
        .map(withLatest)
        .sort((a, b) => (b.latest?.created_at ?? b.created_at) - (a.latest?.created_at ?? a.created_at));
    },

    /** Changes an agent's name, avatar, model, effort, or whether it is muted or hidden. A new name is written into the agent's instructions where they say who it is. */
    updateAgent(agent: Agent, changes: AgentChanges): void {
      const columns = Object.keys(changes) as (keyof AgentChanges)[];
      if (columns.length === 0) return;
      const values = columns.map((column) => (typeof changes[column] === "boolean" ? Number(changes[column]) : changes[column]!));
      db.prepare(`update agents set ${columns.map((column) => `${column} = ?`).join(", ")} where id = ?`).run(...values, agent.id);
      if (changes.name === undefined || changes.name === agent.name) return;
      const path = join(agentHome(agent.id), "CLAUDE.md");
      const text = readFileSync(path, "utf8");
      writeFileSync(path, text.replace(`# ${agent.name}\n`, `# ${changes.name}\n`).replace(`You are ${agent.name},`, `You are ${changes.name},`));
    },

    /**
     * Removes an agent and everything it had: its messages, its jobs, its home
     * folder, and the sessions Claude Code kept for it. Claude Code keeps a
     * folder's sessions in its config folder, under `projects`, in a folder
     * named after the path with every other character turned into a dash.
     */
    deleteAgent(agent: Agent, person: Person): void {
      db.prepare("delete from jobs where agent_id = ?").run(agent.id);
      db.prepare("delete from messages where agent_id = ?").run(agent.id);
      db.prepare("delete from agents where id = ?").run(agent.id);
      rmSync(agentHome(agent.id), { recursive: true, force: true });
      rmSync(join(person.claude_config_dir, "projects", agentHome(agent.id).replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true, force: true });
    },

    /** The instructions an agent follows, what it remembers and its jobs. */
    about(agentId: string): About {
      const folder = agentHome(agentId);
      const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
      const memory = join(folder, "memory");
      // MEMORY.md is Claude Code's list of the other files.
      const files = existsSync(memory) ? readdirSync(memory).filter((file) => file.endsWith(".md") && file !== "MEMORY.md") : [];
      return {
        instructions: read(join(folder, "CLAUDE.md")),
        memories: files.sort().map((file) => toMemory(file, read(join(memory, file)))),
        jobs: jobsFor(agentId),
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

    /** Records that the person has read everything in the chat so far. */
    markRead(agentId: string): void {
      db.prepare("update agents set read_at = ? where id = ?").run(Date.now(), agentId);
    },

    setSession(agentId: string, sessionId: string | null): void {
      db.prepare("update agents set session_id = ? where id = ?").run(sessionId, agentId);
    },

    /**
     * Saves a message, with any files sent with it written into the agent's
     * `attachments/` folder. A reply or a failure notice brings a hidden agent
     * back to the home screen, unless the agent is muted. An update while the
     * agent works doesn't.
     */
    addMessage(agentId: string, sender: Sender, body: string, status: Status, { files = [], replyTo, jobId, interim = false }: Extras = {}): Message {
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
        created_at: Date.now(),
      };
      db.prepare("insert into messages (id, agent_id, sender, body, attachments, status, reply_to, job_id, interim, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        message.id,
        message.agent_id,
        message.sender,
        message.body,
        JSON.stringify(attachments),
        message.status,
        message.reply_to,
        message.job_id,
        Number(interim),
        message.created_at,
      );
      if ((sender === "agent" && !interim) || (sender === "sidebots" && status === "failed")) {
        db.prepare("update agents set hidden = 0 where id = ? and muted = 0").run(agentId);
      }
      changed(message);
      return message;
    },

    /** The path of a file in the agent's `attachments/` folder, if it is there. */
    attachment(agentId: string, name: string): string | undefined {
      if (!ATTACHMENT_NAME.test(name)) return undefined;
      const path = join(agentHome(agentId), "attachments", name);
      return statSync(path, { throwIfNoEntry: false })?.isFile() ? path : undefined;
    },

    /** Records that the agent has read these messages from the person, the ones it hadn't yet. */
    markSeen(messageIds: string[]): void {
      const now = Date.now();
      for (const id of messageIds) {
        const read = db.prepare("update messages set status = 'running', seen_at = ? where id = ? and sender = 'person' and status = 'queued'").run(now, id);
        const message = read.changes ? one("select * from messages where id = ?", id) : undefined;
        if (message) changed(message);
      }
    },

    setStatus(messageId: string, status: Status): void {
      db.prepare("update messages set status = ? where id = ?").run(status, messageId);
      const message = one("select * from messages where id = ?", messageId);
      if (message) changed(message);
    },

    /** Oldest first: everything after a known message, the page before one, or the latest page. */
    messages(agentId: string, { after, before }: { after?: string; before?: string } = {}): Message[] {
      if (after) {
        return many("select * from messages where agent_id = ? and rowid > (select rowid from messages where id = ?) order by rowid", agentId, after);
      }
      if (before) {
        return many(
          "select * from messages where agent_id = ? and rowid < (select rowid from messages where id = ?) order by rowid desc limit ?",
          agentId,
          before,
          PAGE,
        ).reverse();
      }
      return many("select * from messages where agent_id = ? order by rowid desc limit ?", agentId, PAGE).reverse();
    },

    /** A message, if it is in the agent's chat. */
    message(agentId: string, id: string): Message | undefined {
      return one("select * from messages where id = ? and agent_id = ?", id, agentId);
    },

    /**
     * What the agent's jobs have sent since the agent last replied in the
     * chat, before a message, oldest first. The session a reply comes from
     * never saw them.
     */
    sentByJobsBefore(messageId: string): Message[] {
      return many(
        `select * from messages where sender = 'agent' and job_id is not null
           and agent_id = (select agent_id from messages where id = ?1) and rowid < (select rowid from messages where id = ?1)
           and rowid > coalesce((select max(rowid) from messages where sender = 'agent' and job_id is null
             and agent_id = (select agent_id from messages where id = ?1) and rowid < (select rowid from messages where id = ?1)), 0)
         order by rowid`,
        messageId,
      );
    },

    /** The last few things the person and the agent said before a message, oldest first. */
    messagesBefore(messageId: string, limit: number): Message[] {
      return many(
        `select * from messages where sender != 'sidebots'
           and agent_id = (select agent_id from messages where id = ?) and rowid < (select rowid from messages where id = ?)
         order by rowid desc limit ?`,
        messageId,
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

    /** The agent's oldest message that is waiting for its turn. */
    nextQueued(agentId: string): Message | undefined {
      return one("select * from messages where agent_id = ? and status = 'queued' order by rowid limit 1", agentId);
    },

    /** Puts turns that a stopped server left running back in the queue, and lists the agents with queued turns. */
    requeueInterrupted(): string[] {
      db.prepare("update messages set status = 'queued' where status = 'running'").run();
      const rows = db.prepare("select distinct agent_id from messages where status = 'queued'").all() as { agent_id: string }[];
      return rows.map((row) => row.agent_id);
    },

    /** Makes a code that pairs one phone as the person, once, within ten minutes. */
    addPairing(personId: string): string {
      const now = Date.now();
      db.prepare("delete from pairings where expires_at <= ?").run(now);
      const code = secret();
      db.prepare("insert into pairings (code_hash, person_id, expires_at) values (?, ?, ?)").run(hashOf(code), personId, now + PAIRING_MS);
      return code;
    },

    /**
     * Pairs a phone that brings a pairing code, and uses the code up. Returns
     * the key the phone sends with every request from then on and the key its
     * notifications are encrypted with, or nothing when the code is unknown,
     * used or too old.
     */
    pair(code: string, name: string): { key: string; notificationKey: string } | undefined {
      const pairing = db.prepare("delete from pairings where code_hash = ? returning person_id, expires_at").get(hashOf(code)) as
        | { person_id: string; expires_at: number }
        | undefined;
      if (!pairing || pairing.expires_at <= Date.now()) return undefined;
      const key = secret();
      // The server encrypts with this one, so it keeps the key itself. The phone reads it in base64.
      const notificationKey = randomBytes(32).toString("base64");
      db.prepare("insert into devices (id, person_id, name, key_hash, notification_key, paired_at) values (?, ?, ?, ?, ?, ?)").run(
        randomUUID(),
        pairing.person_id,
        name,
        hashOf(key),
        notificationKey,
        Date.now(),
      );
      return { key, notificationKey };
    },

    /** The paired phone that holds this key. */
    deviceByKey(key: string): Device | undefined {
      return db.prepare("select id, person_id, name, paired_at from devices where key_hash = ?").get(hashOf(key)) as Device | undefined;
    },

    /** Remembers where Apple delivers a phone's notifications. A token another paired phone held becomes this one's. */
    setPushToken(deviceId: string, push: PushToken): void {
      clearPushToken.run(push.token);
      db.prepare("update devices set push_token = ?, environment = ? where id = ?").run(push.token, push.environment, deviceId);
    },

    /** Where Apple delivers the notifications of the person's phones, for the phones that allow them, with each phone's notification key. */
    pushTargetsFor(personId: string): PushTarget[] {
      return db
        .prepare("select push_token as token, environment, notification_key as notificationKey from devices where person_id = ? and push_token is not null")
        .all(personId) as PushTarget[];
    },

    /** Forgets a token Apple no longer delivers to. The phone stays paired. */
    clearPushToken(token: string): void {
      clearPushToken.run(token);
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
