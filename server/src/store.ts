// The store owns the database and the agent folders. Nothing else touches
// SQLite or ~/.simon.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { Agent, AgentWithLatest, Device, Message, Pet, Sender, Status } from "./contract.ts";

export type Person = { id: string; name: string; tailscale_login: string; claude_config_dir: string };
/** A file as it arrives with a message. */
export type Upload = { name: string; bytes: Uint8Array };
/** The key Apple gives a developer account for sending notifications, with the key's ID and the account's team ID. */
export type PushKey = { keyId: string; teamId: string; key: string };
/** A message found by a search, with the name of the agent whose chat it is in. */
export type Found = { agent: string; sender: Sender; body: string; created_at: number };

const SCHEMA = `
create table if not exists people (
  id                text primary key,
  name              text not null,
  tailscale_login   text not null unique,
  claude_config_dir text not null
);
create table if not exists agents (
  id          text primary key,
  person_id   text not null references people(id),
  name        text not null,
  pet_id      text not null,
  session_id  text,
  read_at     integer not null default 0,
  created_at  integer not null
);
create table if not exists messages (
  id          text primary key,
  agent_id    text not null references agents(id),
  sender      text not null check (sender in ('person', 'agent', 'simon')),
  body        text not null,
  attachments text not null default '[]',
  status      text not null check (status in ('queued', 'running', 'done', 'failed')),
  created_at  integer not null
);
create table if not exists devices (
  push_token  text primary key,
  person_id   text not null references people(id),
  topic       text not null,
  environment text not null check (environment in ('sandbox', 'production'))
);
`;

const PAGE = 50;
const SEARCH_LIMIT = 20;
const PET_ID = /^[a-z0-9-]+$/;
// A stored attachment's file name: no folders, and never a dot first.
const ATTACHMENT_NAME = /^[\w-][\w.-]*$/;

/** A message as SQLite holds it, with its attachments as JSON text. */
type Row = Omit<Message, "attachments"> & { attachments: string };
const toMessage = (row: Row): Message => ({ ...row, attachments: JSON.parse(row.attachments) as string[] });

function instructions(agentName: string, personName: string): string {
  return `# ${agentName}

You are ${agentName}, one of ${personName}'s agents in Simon. Simon is a messaging app on their iPhone, and each agent is one chat in it.

${personName} only sees your final reply, as a text message on their phone. They never see your tool calls or working steps. Write the way a capable person texts: short, plain sentences, no headings or tables unless they ask for them.

Your home folder is where you run. Files ${personName} sends you are in \`attachments/\`.

You don't know what you're for yet. If this is a new chat, ask what ${personName} wants you to help with, then write what you're for into this file. What you learn along the way goes in your memory.
`;
}

export function openStore(home: string) {
  mkdirSync(join(home, "agents"), { recursive: true });
  const db = new DatabaseSync(join(home, "simon.sqlite"));
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
  db.exec(SCHEMA);

  const agentHome = (agentId: string) => join(home, "agents", agentId);
  const petsHome = join(home, "pets");
  const pushKeyPath = join(home, "push.json");
  const listeners = new Set<(message: Message) => void>();
  const changed = (message: Message) => listeners.forEach((listener) => listener(message));

  const one = (sql: string, ...values: (string | number)[]): Message | undefined => {
    const row = db.prepare(sql).get(...values) as Row | undefined;
    return row && toMessage(row);
  };
  const many = (sql: string, ...values: (string | number)[]): Message[] => (db.prepare(sql).all(...values) as Row[]).map(toMessage);

  const pendingTurn = db.prepare("select 1 from messages where agent_id = ? and status in ('queued', 'running') limit 1");
  // What waits to be read: the agent's replies and Simon's failure notices.
  const unread = db.prepare(
    "select count(*) as unread from messages where agent_id = ? and created_at > ? and (sender = 'agent' or (sender = 'simon' and status = 'failed'))",
  );
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

    /** Copies the starter pets in `from` that this server doesn't have yet. */
    installStarterPets(from: string): void {
      for (const id of readdirSync(from)) {
        if (PET_ID.test(id) && !existsSync(join(petsHome, id))) cpSync(join(from, id), join(petsHome, id), { recursive: true });
      }
    },

    pets(): Pet[] {
      if (!existsSync(petsHome)) return [];
      return readdirSync(petsHome)
        .filter((id) => PET_ID.test(id) && existsSync(join(petsHome, id, "pet.json")))
        .map((id) => JSON.parse(readFileSync(join(petsHome, id, "pet.json"), "utf8")) as Pet);
    },

    /** The path of a pet's spritesheet, if the pet exists. */
    petSheet(id: string): string | undefined {
      if (!PET_ID.test(id) || !existsSync(join(petsHome, id, "pet.json"))) return undefined;
      const pet = JSON.parse(readFileSync(join(petsHome, id, "pet.json"), "utf8")) as Pet;
      const path = join(petsHome, id, pet.spritesheetPath);
      return existsSync(path) ? path : undefined;
    },

    addPerson(input: { name: string; login: string; configDir: string }): Person {
      const person: Person = { id: randomUUID(), name: input.name, tailscale_login: input.login, claude_config_dir: input.configDir };
      db.prepare("insert into people (id, name, tailscale_login, claude_config_dir) values (?, ?, ?, ?)").run(
        person.id,
        person.name,
        person.tailscale_login,
        person.claude_config_dir,
      );
      return person;
    },

    personByLogin(login: string): Person | undefined {
      return db.prepare("select * from people where tailscale_login = ?").get(login) as Person | undefined;
    },

    person(id: string): Person | undefined {
      return db.prepare("select * from people where id = ?").get(id) as Person | undefined;
    },

    createAgent(person: Person, name: string, petId: string): Agent {
      const now = Date.now();
      const agent: Agent = { id: randomUUID(), person_id: person.id, name, pet_id: petId, session_id: null, read_at: now, created_at: now };
      const folder = agentHome(agent.id);
      mkdirSync(join(folder, "memory"), { recursive: true });
      mkdirSync(join(folder, "attachments"), { recursive: true });
      writeFileSync(join(folder, "CLAUDE.md"), instructions(name, person.name));
      db.prepare("insert into agents (id, person_id, name, pet_id, session_id, read_at, created_at) values (?, ?, ?, ?, ?, ?, ?)").run(
        agent.id,
        agent.person_id,
        agent.name,
        agent.pet_id,
        null,
        agent.read_at,
        agent.created_at,
      );
      return agent;
    },

    agent(id: string): Agent | undefined {
      return db.prepare("select * from agents where id = ?").get(id) as Agent | undefined;
    },

    agentWithLatest(id: string): AgentWithLatest | undefined {
      const agent = db.prepare("select * from agents where id = ?").get(id) as Agent | undefined;
      return agent && withLatest(agent);
    },

    /** The person's agents, each with its latest message, most recent chat first. */
    agentsFor(personId: string): AgentWithLatest[] {
      const agents = db.prepare("select * from agents where person_id = ?").all(personId) as Agent[];
      return agents
        .map(withLatest)
        .sort((a, b) => (b.latest?.created_at ?? b.created_at) - (a.latest?.created_at ?? a.created_at));
    },

    /** Records that the person has read everything in the chat so far. */
    markRead(agentId: string): void {
      db.prepare("update agents set read_at = ? where id = ?").run(Date.now(), agentId);
    },

    setSession(agentId: string, sessionId: string | null): void {
      db.prepare("update agents set session_id = ? where id = ?").run(sessionId, agentId);
    },

    /** Saves a message, with any files sent with it written into the agent's `attachments/` folder. */
    addMessage(agentId: string, sender: Sender, body: string, status: Status, files: Upload[] = []): Message {
      const attachments = files.map((file) => {
        // A name keeps its letters, digits, dots and dashes. Anything else becomes a dash, as does a %20 the phone wrote for a space.
        const name = `${randomUUID().slice(0, 8)}-${basename(file.name).replace(/(?:%[0-9a-f]{2}|[^\w.-])+/gi, "-")}`;
        writeFileSync(join(agentHome(agentId), "attachments", name), file.bytes);
        return `attachments/${name}`;
      });
      const message: Message = { id: randomUUID(), agent_id: agentId, sender, body, attachments, status, created_at: Date.now() };
      db.prepare("insert into messages (id, agent_id, sender, body, attachments, status, created_at) values (?, ?, ?, ?, ?, ?, ?)").run(
        message.id,
        message.agent_id,
        message.sender,
        message.body,
        JSON.stringify(attachments),
        message.status,
        message.created_at,
      );
      changed(message);
      return message;
    },

    /** The path of a file in the agent's `attachments/` folder, if it is there. */
    attachment(agentId: string, name: string): string | undefined {
      if (!ATTACHMENT_NAME.test(name)) return undefined;
      const path = join(agentHome(agentId), "attachments", name);
      return statSync(path, { throwIfNoEntry: false })?.isFile() ? path : undefined;
    },

    setStatus(messageId: string, status: Status): void {
      db.prepare("update messages set status = ? where id = ?").run(status, messageId);
      const message = one("select * from messages where id = ?", messageId);
      if (message) changed(message);
    },

    /** Everything after a known message, oldest first, or the latest page. */
    messages(agentId: string, after?: string): Message[] {
      if (after) {
        return many("select * from messages where agent_id = ? and rowid > (select rowid from messages where id = ?) order by rowid", agentId, after);
      }
      return many("select * from messages where agent_id = ? order by rowid desc limit ?", agentId, PAGE).reverse();
    },

    /** The last few things the person and the agent said before a message, oldest first. */
    messagesBefore(messageId: string, limit: number): Message[] {
      return many(
        `select * from messages where sender != 'simon'
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
          `select agents.name as agent, messages.sender, messages.body, messages.created_at
           from messages join agents on agents.id = messages.agent_id
           where agents.person_id = ? and messages.sender != 'simon' and messages.body like ? escape '\\'
           order by messages.rowid desc limit ?`,
        )
        .all(personId, pattern, SEARCH_LIMIT) as Found[];
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

    /** Remembers a phone for the person. A phone that was someone else's becomes theirs. */
    saveDevice(personId: string, device: Device): void {
      db.prepare(
        `insert into devices (push_token, person_id, topic, environment) values (?, ?, ?, ?)
         on conflict (push_token) do update set person_id = excluded.person_id, topic = excluded.topic, environment = excluded.environment`,
      ).run(device.token, personId, device.topic, device.environment);
    },

    devicesFor(personId: string): Device[] {
      return db.prepare("select push_token as token, topic, environment from devices where person_id = ?").all(personId) as Device[];
    },

    removeDevice(token: string): void {
      db.prepare("delete from devices where push_token = ?").run(token);
    },

    setPushKey(key: PushKey): void {
      writeFileSync(pushKeyPath, JSON.stringify(key), { mode: 0o600 });
    },

    pushKey(): PushKey | undefined {
      return existsSync(pushKeyPath) ? (JSON.parse(readFileSync(pushKeyPath, "utf8")) as PushKey) : undefined;
    },

    close(): void {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;
