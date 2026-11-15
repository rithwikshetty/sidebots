// The runner runs turns. It is the only module that imports the Agent SDK.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Store } from "./store.ts";

export type Turn = { prompt: string; cwd: string; sessionId: string | null; configDir: string };
export type TurnResult = { reply: string; sessionId: string };
export type RunTurn = (turn: Turn) => Promise<TurnResult>;

/** Runs one turn through Claude Code, signed in as the person who owns the agent. */
export const claudeTurn: RunTurn = async ({ prompt, cwd, sessionId, configDir }) => {
  const run = query({
    prompt,
    options: {
      cwd,
      resume: sessionId ?? undefined,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      settingSources: ["user", "project"],
      skills: "all",
      permissionMode: "auto",
      // Auto mode asks here when its classifier can't decide. Nobody is at
      // the keyboard, so the agent carries on without the action.
      canUseTool: async () => ({
        behavior: "deny",
        message: "Nobody is available to approve this. Skip it, finish the rest, and say in your reply what you couldn't do.",
      }),
    },
  });
  for await (const message of run) {
    if (message.type !== "result") continue;
    if (message.subtype !== "success") throw new Error(message.errors.join("; ") || message.subtype);
    if (message.is_error) throw new Error(message.result || "Claude Code returned an error");
    return { reply: message.result, sessionId: message.session_id };
  }
  throw new Error("Claude Code stopped without a reply");
};

/**
 * Runs each agent's queued messages in the order they were sent, one turn at
 * a time per agent. `kick` starts an agent's queue if it isn't already running.
 */
export function createQueue(store: Store, runTurn: RunTurn) {
  const busy = new Map<string, Promise<void>>();

  async function drain(agentId: string): Promise<void> {
    for (let message = store.nextQueued(agentId); message; message = store.nextQueued(agentId)) {
      const agent = store.agent(agentId);
      const person = agent && store.person(agent.person_id);
      if (!agent || !person) return;
      store.setStatus(message.id, "running");
      try {
        const result = await runTurn({
          prompt: message.body,
          cwd: store.agentHome(agent.id),
          sessionId: agent.session_id,
          configDir: person.claude_config_dir,
        });
        store.setSession(agent.id, result.sessionId);
        store.addMessage(agent.id, "agent", result.reply, "done");
        store.setStatus(message.id, "done");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        store.addMessage(agent.id, "simon", `Simon couldn't finish this. ${reason}`, "done");
        store.setStatus(message.id, "failed");
      }
    }
  }

  return {
    kick(agentId: string): Promise<void> {
      const running = busy.get(agentId);
      if (running) return running;
      const done = drain(agentId).finally(() => busy.delete(agentId));
      busy.set(agentId, done);
      return done;
    },
  };
}

export type Queue = ReturnType<typeof createQueue>;
