// What the chat's tests share: finding an agent and opening its chat, the
// parts of the chat a person looks at, and reading the chat back from the
// server as a second device does.

import { execFileSync } from "node:child_process";
import type { Locator, Page } from "@playwright/test";
import type { AgentWithLatest, Message } from "../../server/src/contract.ts";
import { expect, type TestServer } from "./fixtures.ts";

/** Reads `read` until `done` holds, and resolves to what it read last. */
export async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`Gave up waiting. Last read: ${JSON.stringify(value, null, 2).slice(0, 2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export const json = async <T>(server: TestServer, path: string, init?: RequestInit): Promise<T> => (await server.api(path, init)).json() as Promise<T>;

/** The agents as the server has them. */
export const agents = (server: TestServer) => json<AgentWithLatest[]>(server, "/agents");

/** One agent as the server has it. */
export const agentOf = async (server: TestServer, id: string) => (await agents(server)).find((agent) => agent.id === id)!;

/** A chat's newest page as the server has it, or everything after `after`. */
export const messagesOf = (server: TestServer, agentId: string, after?: string) => json<Message[]>(server, `/agents/${agentId}/messages${after ? `?after=${after}` : ""}`);

/** Every message of a chat, oldest first, paging back from the newest. */
export async function wholeChat(server: TestServer, agentId: string): Promise<Message[]> {
  let all = await messagesOf(server, agentId);
  for (;;) {
    if (all.length === 0) return all;
    const page = await json<Message[]>(server, `/agents/${agentId}/messages?before=${all[0].id}`);
    if (page.length === 0) return all;
    all = [...page, ...all];
  }
}

/** An agent's id from its name. */
export async function agentId(server: TestServer, name: string): Promise<string> {
  const { agents } = await server.control<{ agents: { id: string; name: string }[] }>("state");
  const found = agents.find((agent) => agent.name === name);
  if (!found) throw new Error(`There is no agent called ${name}.`);
  return found.id;
}

/** Adds an agent as another device does, and waits for the window to list it. */
export async function addAgent(page: Page, server: TestServer, name: string, provider: "claude" | "codex" = "claude"): Promise<string> {
  const made = await server.control<{ id: string }>("agents", { name, provider });
  await expect(page.getByTestId(`agent-${made.id}`)).toBeVisible();
  return made.id;
}

/** Opens an agent's chat from the sidebar, and resolves to the agent's id once the chat shows its name. */
export async function openChat(page: Page, server: TestServer, name: string): Promise<string> {
  const id = await agentId(server, name);
  await page.getByTestId(`agent-${id}`).click();
  await expect(page.getByTestId("chat-name")).toHaveText(name);
  return id;
}

export const field = (page: Page) => page.getByTestId("message-field");
export const timeline = (page: Page) => page.getByTestId("timeline");
export const mine = (page: Page) => page.getByTestId("message-mine");
export const theirs = (page: Page) => page.getByTestId("message-theirs");
export const notices = (page: Page) => page.getByTestId("notice");
export const toast = (page: Page, title: string) => page.getByTestId("toast").filter({ hasText: title });

/** Types a message in the field and sends it with Enter. */
export async function sendFromApp(page: Page, text: string): Promise<void> {
  await field(page).fill(text);
  await field(page).press("Enter");
}

/** A message the agent said, by its words. */
export const said = (page: Page, words: string | RegExp) => theirs(page).filter({ hasText: words });

/** Waits until the agent has finished working, as the server says. */
export const idle = (server: TestServer, agentId: string) => until(() => agentOf(server, agentId), (agent) => !agent.working && agent.waiting_on === null);

/** How far the messages are from their end, in pixels. */
export const fromEnd = (page: Page) => timeline(page).evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);

/** Waits until the messages are scrolled to their end. */
export const expectAtEnd = (page: Page) => expect.poll(() => fromEnd(page), { message: "the chat is at its newest message" }).toBeLessThanOrEqual(2);

/** Whether the Jump to latest button is offered. It is always in the page, and hidden by `aria-hidden` and its opacity. */
export const jumpOffered = (page: Page) => page.getByTestId("jump-to-latest").evaluate((button) => button.getAttribute("aria-hidden") === "false" && getComputedStyle(button).opacity !== "0");

/** The process id of the server listening on `port`, for the tests that freeze or end it as a crash would. */
export function serverPid(port: number): number {
  return Number(execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]).toString().trim().split("\n")[0]);
}

/** A rectangle's edges, as the page measures it. */
export type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
export const box = (locator: Locator): Promise<Box> =>
  locator.evaluate((element) => {
    const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
    return { left, right, top, bottom, width, height };
  });

/** A PNG of `width` by `height` in one colour, for a file a person picks. */
export { png } from "./scripted/files.ts";

/** Builds a File-like payload for `setInputFiles`. */
export const payload = (name: string, buffer: Buffer | Uint8Array, mimeType = "application/octet-stream") => ({ name, mimeType, buffer: Buffer.from(buffer) });
