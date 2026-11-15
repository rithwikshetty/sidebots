// The store owns the database and the agent folders. Nothing else touches
// SQLite or ~/.simon.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { Agent, AgentWithLatest, Message, Pet, Sender, Status } from "./contract.ts";

export type Person = { id: string; name: string; tailscale_login: string; claude_config_dir: string };

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
  created_at  integer not null
);
create table if not exists messages (
  id              text primary key,
  agent_id        text not null references agents(id),
  sender          text not null check (sender in ('person', 'agent', 'simon')),
  body            text not null,
  attachment_path text,
  status          text not null check (status in ('queued', 'running', 'done', 'failed')),
  created_at      integer not null
);
create table if not exists devices (
  id         text primary key,
  person_id  text not null references people(id),
  push_token text not null unique
);
`;

const PAGE = 50;
const PET_ID = /^[a-z0-9-]+$/;

function instructions(agentName: string, personName: string): string {
  return `# ${agentName}

You are ${agentName}, one of ${personName}'s agents in Simon. Simon is a messaging app on their iPhone, and each agent is one chat in it.

${personName} only sees your final reply, as a text message on their phone. They never see your tool calls or working steps. Write the way a capable person texts: short, plain sentences, no headings or tables unless they ask for them.

Your home folder is where you run. Files ${personName} sends you are in \`attachments/\`.

You don't know what you're for yet. If this is a new chat, ask what ${personName} wants you to help with, then add what you learn to this file.
`;
}

export function openStore(home: string) {
  mkdirSync(join(home, "agents"), { recursive: true });
  const db = new DatabaseSync(join(home, "simon.sqlite"));
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
  db.exec(SCHEMA);

  const agentHome = (agentId: string) => join(home, "agents", agentId);
  const petsHome = join(home, "pets");
  const listeners = new Set<(message: Message) => void>();
  const changed = (message: Message) => listeners.forEach((listener) => listener(message));

  const latestMessage = db.prepare("select * from messages where agent_id = ? order by rowid desc limit 1");
  const pendingTurn = db.prepare("select 1 from messages where agent_id = ? and sender = 'person' and status in ('queued', 'running') limit 1");
  const withLatest = (agent: Agent): AgentWithLatest => ({
    ...agent,
    latest: (latestMessage.get(agent.id) as Message | undefined) ?? null,
    working: pendingTurn.get(agent.id) !== undefined,
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
      const agent: Agent = { id: randomUUID(), person_id: person.id, name, pet_id: petId, session_id: null, created_at: Date.now() };
      const folder = agentHome(agent.id);
      mkdirSync(join(folder, "memory"), { recursive: true });
      mkdirSync(join(folder, "attachments"), { recursive: true });
      writeFileSync(join(folder, "CLAUDE.md"), instructions(name, person.name));
      db.prepare("insert into agents (id, person_id, name, pet_id, session_id, created_at) values (?, ?, ?, ?, ?, ?)").run(
        agent.id,
        agent.person_id,
        agent.name,
        agent.pet_id,
        null,
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

    setSession(agentId: string, sessionId: string | null): void {
      db.prepare("update agents set session_id = ? where id = ?").run(sessionId, agentId);
    },

    addMessage(agentId: string, sender: Sender, body: string, status: Status): Message {
      const message: Message = { id: randomUUID(), agent_id: agentId, sender, body, attachment_path: null, status, created_at: Date.now() };
      db.prepare("insert into messages (id, agent_id, sender, body, attachment_path, status, created_at) values (?, ?, ?, ?, ?, ?, ?)").run(
        message.id,
        message.agent_id,
        message.sender,
        message.body,
        null,
        message.status,
        message.created_at,
      );
      changed(message);
      return message;
    },

    setStatus(messageId: string, status: Status): void {
      db.prepare("update messages set status = ? where id = ?").run(status, messageId);
      const message = db.prepare("select * from messages where id = ?").get(messageId) as Message | undefined;
      if (message) changed(message);
    },

    /** Everything after a known message, oldest first, or the latest page. */
    messages(agentId: string, after?: string): Message[] {
      if (after) {
        return db
          .prepare("select * from messages where agent_id = ? and rowid > (select rowid from messages where id = ?) order by rowid")
          .all(agentId, after) as Message[];
      }
      const page = db.prepare("select * from messages where agent_id = ? order by rowid desc limit ?").all(agentId, PAGE) as Message[];
      return page.reverse();
    },

    nextQueued(agentId: string): Message | undefined {
      return db
        .prepare("select * from messages where agent_id = ? and sender = 'person' and status = 'queued' order by rowid limit 1")
        .get(agentId) as Message | undefined;
    },

    /** Puts turns that a stopped server left running back in the queue, and lists the agents with queued turns. */
    requeueInterrupted(): string[] {
      db.prepare("update messages set status = 'queued' where status = 'running'").run();
      const rows = db.prepare("select distinct agent_id from messages where status = 'queued'").all() as { agent_id: string }[];
      return rows.map((row) => row.agent_id);
    },

    close(): void {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;
