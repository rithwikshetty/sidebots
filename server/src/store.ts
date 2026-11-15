// The store owns the database and the agent folders. Nothing else touches
// SQLite or ~/.julius.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type Person = { id: string; name: string; tailscale_login: string; claude_config_dir: string };
export type Agent = { id: string; person_id: string; name: string; pet_id: string; session_id: string | null; created_at: number };
export type Sender = "person" | "agent" | "julius";
export type Status = "queued" | "running" | "done" | "failed";
export type Message = {
  id: string;
  agent_id: string;
  sender: Sender;
  body: string;
  attachment_path: string | null;
  status: Status;
  created_at: number;
};

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
  sender          text not null check (sender in ('person', 'agent', 'julius')),
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

function instructions(agentName: string, personName: string): string {
  return `# ${agentName}

You are ${agentName}, one of ${personName}'s agents in Julius. Julius is a messaging app on their iPhone, and each agent is one chat in it.

${personName} only sees your final reply, as a text message on their phone. They never see your tool calls or working steps. Write the way a capable person texts: short, plain sentences, no headings or tables unless they ask for them.

Your home folder is where you run. Files ${personName} sends you are in \`attachments/\`.

You don't know what you're for yet. If this is a new chat, ask what ${personName} wants you to help with, then add what you learn to this file.
`;
}

export function openStore(home: string) {
  mkdirSync(join(home, "agents"), { recursive: true });
  const db = new DatabaseSync(join(home, "julius.sqlite"));
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
  db.exec(SCHEMA);

  const agentHome = (agentId: string) => join(home, "agents", agentId);

  return {
    agentHome,

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

    /** The person's agents, each with its latest message, most recent chat first. */
    agentsFor(personId: string): (Agent & { latest: Message | null })[] {
      const agents = db.prepare("select * from agents where person_id = ?").all(personId) as Agent[];
      const latest = db.prepare("select * from messages where agent_id = ? order by rowid desc limit 1");
      return agents
        .map((agent) => ({ ...agent, latest: (latest.get(agent.id) as Message | undefined) ?? null }))
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
      return message;
    },

    setStatus(messageId: string, status: Status): void {
      db.prepare("update messages set status = ? where id = ?").run(status, messageId);
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
