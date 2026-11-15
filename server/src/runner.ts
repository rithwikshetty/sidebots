// The runner runs turns. It is the only module that imports the Agent SDK.

import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Message } from "./contract.ts";
import type { Found, Person, Store } from "./store.ts";

export type Turn = {
  prompt: string;
  cwd: string;
  sessionId: string | null;
  configDir: string;
  /** Finds messages in any of the person's chats, for the agent's `search_history` tool. */
  searchHistory: (text: string) => string;
};
/** `contextTokens` is how much the session held when the turn ended. */
export type TurnResult = { reply: string; sessionId: string; contextTokens: number };
export type RunTurn = (turn: Turn) => Promise<TurnResult>;

/** What a fresh start shows in the chat. */
const FRESH_START = "Fresh start";
// A session this large gets a fresh start once its reply is in.
const FRESH_START_TOKENS = 120_000;
// How much of the chat a new session is shown before its first message.
const RECENT_MESSAGES = 20;
const RECENT_MESSAGE_CHARS = 1500;

/** Runs one turn through Claude Code, signed in as the person who owns the agent. */
export const claudeTurn: RunTurn = async ({ prompt, cwd, sessionId, configDir, searchHistory }) => {
  const simon = createSdkMcpServer({
    name: "simon",
    tools: [
      tool(
        "search_history",
        "Search the messages in every chat this person has in Simon, with this agent and their other agents. Use it for things said before this session or to another agent.",
        { text: z.string().describe("A word or phrase the messages contain") },
        async ({ text }) => ({ content: [{ type: "text", text: searchHistory(text) }] }),
      ),
    ],
  });
  const run = query({
    prompt,
    options: {
      cwd,
      resume: sessionId ?? undefined,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      settingSources: ["user", "project"],
      // Claude Code's full prompt. Left out, the SDK gives a short one that says nothing of memory.
      systemPrompt: { type: "preset", preset: "claude_code" },
      // Claude Code's own memory, kept in the agent's folder so it outlives
      // every session. It is on for a Simon agent even when its owner has
      // turned it off for their own Claude Code.
      settings: { autoMemoryEnabled: true, autoMemoryDirectory: join(cwd, "memory"), env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0" } },
      skills: "all",
      mcpServers: { simon },
      allowedTools: ["mcp__simon__search_history"],
      permissionMode: "auto",
      // Auto mode asks here when its classifier can't decide. Nobody is at
      // the keyboard, so the agent carries on without the action.
      canUseTool: async () => ({
        behavior: "deny",
        message: "Nobody is available to approve this. Skip it, finish the rest, and say in your reply what you couldn't do.",
      }),
    },
  });
  let contextTokens = 0;
  for await (const message of run) {
    if (message.type === "assistant" && message.parent_tool_use_id === null) {
      // Each of the agent's own steps reports everything the model read for it, which is the session so far.
      const usage = message.message.usage;
      contextTokens = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + usage.output_tokens;
    }
    if (message.type !== "result") continue;
    if (message.subtype !== "success") throw new Error(message.errors.join("; ") || message.subtype);
    if (message.is_error) throw new Error(message.result || "Claude Code returned an error");
    return { reply: message.result, sessionId: message.session_id, contextTokens };
  }
  throw new Error("Claude Code stopped without a reply");
};

function found(messages: Found[]): string {
  if (messages.length === 0) return "No messages match.";
  return messages
    .map((message) => `${new Date(message.created_at).toISOString().slice(0, 10)}, chat with ${message.agent}, ${message.sender === "person" ? "the person" : message.agent}: ${message.body}`)
    .join("\n\n");
}

/** What the agent is asked before its session is replaced. */
function remember(person: Person): string {
  return `This session is about to be replaced by a fresh one. Save what is worth keeping from it to your memory now: what you are in the middle of, what was decided, and what you learned about ${person.name}. Then reply "Saved."`;
}

/** A person's message as the agent reads it: the files sent with it, and for a new session the chat so far. */
function promptFor(message: Message, recent: Message[], person: Person): string {
  const sent = message.attachments.length ? `${message.body}\n\nSent with this message: ${message.attachments.join(", ")}`.trim() : message.body;
  if (recent.length === 0) return sent;
  const lines = recent.map((earlier) => `${earlier.sender === "person" ? person.name : "You"}: ${earlier.body.slice(0, RECENT_MESSAGE_CHARS)}`);
  return `This is a fresh session in a chat that was already going. The latest messages in it:\n\n${lines.join("\n\n")}\n\n${person.name}'s new message:\n\n${sent}`;
}

/**
 * Runs each agent's queued work in the order it was asked for, one turn at a
 * time per agent. `kick` starts an agent's queue if it isn't already running.
 */
export function createQueue(store: Store, runTurn: RunTurn) {
  const busy = new Map<string, Promise<void>>();

  async function drain(agentId: string): Promise<void> {
    for (let message = store.nextQueued(agentId); message; message = store.nextQueued(agentId)) {
      const agent = store.agent(agentId);
      const person = agent && store.person(agent.person_id);
      if (!agent || !person) return;
      const turn = (prompt: string) =>
        runTurn({
          prompt,
          cwd: store.agentHome(agent.id),
          sessionId: agent.session_id,
          configDir: person.claude_config_dir,
          searchHistory: (text) => found(store.searchMessages(person.id, text)),
        });
      store.setStatus(message.id, "running");

      if (message.sender === "simon") {
        // A fresh start. The session goes even when the agent couldn't save
        // first, since the chat itself is still there to search.
        if (agent.session_id) await turn(remember(person)).catch(() => undefined);
        store.setSession(agent.id, null);
        store.setStatus(message.id, "done");
        continue;
      }

      try {
        const recent = agent.session_id ? [] : store.messagesBefore(message.id, RECENT_MESSAGES);
        const result = await turn(promptFor(message, recent, person));
        store.setSession(agent.id, result.sessionId);
        store.addMessage(agent.id, "agent", result.reply, "done");
        store.setStatus(message.id, "done");
        if (result.contextTokens > FRESH_START_TOKENS) store.addMessage(agent.id, "simon", FRESH_START, "queued");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        store.addMessage(agent.id, "simon", `Simon couldn't finish this. ${reason}`, "failed");
        store.setStatus(message.id, "failed");
      }
    }
  }

  function kick(agentId: string): Promise<void> {
    const running = busy.get(agentId);
    if (running) return running;
    const done = drain(agentId).finally(() => busy.delete(agentId));
    busy.set(agentId, done);
    return done;
  }

  return {
    kick,

    /**
     * Replaces the agent's session once the turns ahead of it are done. The
     * agent first saves what is worth keeping to its memory.
     */
    freshStart(agentId: string): Message {
      const message = store.addMessage(agentId, "simon", FRESH_START, "queued");
      void kick(agentId);
      return message;
    },
  };
}

export type Queue = ReturnType<typeof createQueue>;
