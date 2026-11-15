// The api owns the HTTP routes and works out which person is asking.

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { Device, MessageEvent } from "./contract.ts";
import type { Person, Store } from "./store.ts";
import type { Queue } from "./runner.ts";

// `tailscale serve` adds the sender's Tailscale login to every request.
const LOGIN_HEADER = "Tailscale-User-Login";
const KEEPALIVE_MS = 25_000;
// Room for ten full-size photos in one message, the most the app sends.
const MESSAGE_BYTES = 200 * 1024 * 1024;
// An Apple device token as the iPhone reports it: hex, 32 bytes today, with room for Apple to lengthen it.
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/;
const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
};

export function createApi(store: Store, queue: Queue) {
  const app = new Hono<{ Variables: { person: Person } }>();

  app.use(async (c, next) => {
    const login = c.req.header(LOGIN_HEADER);
    const person = login ? store.personByLogin(login) : undefined;
    if (!person) return c.json({ error: "This Tailscale login isn't set up on this Simon server." }, 403);
    c.set("person", person);
    await next();
  });

  /** The agent, if it belongs to the person asking. */
  const ownAgent = (person: Person, id: string) => {
    const agent = store.agent(id);
    return agent && agent.person_id === person.id ? agent : undefined;
  };

  app.get("/agents", (c) => c.json(store.agentsFor(c.var.person.id)));

  app.post("/agents", async (c) => {
    const { name, petId } = await c.req.json<{ name?: string; petId?: string }>();
    if (!name?.trim() || !petId?.trim()) return c.json({ error: "An agent needs a name and a pet." }, 400);
    return c.json(store.createAgent(c.var.person, name.trim(), petId.trim()), 201);
  });

  app.get("/agents/:id/messages", (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    return c.json(store.messages(agent.id, c.req.query("after")));
  });

  /** A message arrives as a form, with `body` for the text and `files` for anything sent with it. Text alone can come as JSON. */
  app.post("/agents/:id/messages", bodyLimit({ maxSize: MESSAGE_BYTES }), async (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    const json = c.req.header("Content-Type")?.startsWith("application/json");
    const form = json ? await c.req.json<Record<string, unknown>>() : await c.req.parseBody({ all: true });
    const body = typeof form.body === "string" ? form.body.trim() : "";
    const files = [form.files].flat().filter((file) => file instanceof File);
    if (!body && files.length === 0) return c.json({ error: "A message needs some text or a file." }, 400);
    const uploads = await Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
    const message = store.addMessage(agent.id, "person", body, "queued", uploads);
    void queue.kick(agent.id);
    return c.json(message, 201);
  });

  app.get("/agents/:id/attachments/:name", (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    const path = agent && store.attachment(agent.id, c.req.param("name"));
    if (!path) return c.json({ error: "No such file." }, 404);
    const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    return c.body(readFileSync(path), 200, { "Content-Type": type, "Cache-Control": "private, max-age=31536000, immutable" });
  });

  app.post("/agents/:id/read", (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    store.markRead(agent.id);
    return c.json(store.agentWithLatest(agent.id));
  });

  app.post("/agents/:id/fresh-start", (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    return c.json(queue.freshStart(agent.id), 201);
  });

  /** The messages that contain `text`, in any of the person's chats. */
  app.get("/search", (c) => {
    const text = c.req.query("text")?.trim();
    return c.json(text ? store.searchMessages(c.var.person.id, text) : []);
  });

  app.post("/devices", async (c) => {
    const { token, topic, environment } = await c.req.json<Partial<Device>>();
    if (!token || !DEVICE_TOKEN.test(token) || !topic || (environment !== "sandbox" && environment !== "production")) {
      return c.json({ error: "A device needs its token, its app identifier and its push service." }, 400);
    }
    const device: Device = { token, topic, environment };
    store.saveDevice(c.var.person.id, device);
    return c.json(device, 201);
  });

  app.get("/pets", (c) => c.json(store.pets()));

  app.get("/pets/:id/spritesheet", (c) => {
    const path = store.petSheet(c.req.param("id"));
    if (!path) return c.json({ error: "No such pet." }, 404);
    return c.body(readFileSync(path), 200, { "Content-Type": "image/png", "Cache-Control": "max-age=3600" });
  });

  /** New messages and status changes for the person's agents, each with its agent as the home screen shows it. */
  app.get("/events", (c) => {
    const person = c.var.person;
    return streamSSE(c, async (stream) => {
      const stop = store.onMessage((message) => {
        const agent = store.agentWithLatest(message.agent_id);
        if (agent?.person_id !== person.id) return;
        const event: MessageEvent = { message, agent };
        void stream.writeSSE({ event: "message", data: JSON.stringify(event) });
      });
      stream.onAbort(stop);
      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "" });
        await stream.sleep(KEEPALIVE_MS);
      }
      stop();
    });
  });

  return app;
}
