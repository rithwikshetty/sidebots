// The api owns the HTTP routes and works out which paired phone is asking, and whose it is.

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { COLOR, CONTRACT_HEADER, CONTRACT_VERSION, MESSAGE_BYTES, PROVIDERS } from "./contract.ts";
import type { Effort, Model, Paired, PushToken, StreamEvent } from "./contract.ts";
import type { AgentChanges, Device, Person, Store } from "./store.ts";
import type { Queue } from "./runner.ts";

const KEEPALIVE_MS = 25_000;
// An Apple device token as the phone reports it: hex, 32 bytes today, with room for Apple to lengthen it.
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/;
// An app's bundle identifier, as Apple allows it.
const BUNDLE_ID = /^[A-Za-z0-9.-]{1,155}$/;
const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
};

/** What a request's `Authorization` header carries under a scheme, as in `Bearer <key>`. */
function credential(header: string | undefined, scheme: string): string | undefined {
  return header?.startsWith(`${scheme} `) ? header.slice(scheme.length + 1) : undefined;
}

/** `machine` is the name of the machine the server runs on, which a phone shows once it has paired. */
export function createApi(store: Store, queue: Queue, machine: string) {
  const app = new Hono<{ Variables: { person: Person; device: Device } }>();

  /** Every answer says which version of the contract the server speaks, so the app can tell which side to update. */
  app.use(async (c, next) => {
    c.header(CONTRACT_HEADER, String(CONTRACT_VERSION));
    await next();
  });

  /**
   * Pairs a phone that brings a code made by `pair`. It is the one route a
   * phone can call without a key. An app on another version of the contract
   * is refused before the code is used, so the code still works once one side
   * is updated. An app that sends no version counts as older.
   */
  app.post("/pair", async (c) => {
    if (Number(c.req.header(CONTRACT_HEADER)) !== CONTRACT_VERSION) {
      return c.json({ error: "This app and Sidebots on this computer speak different versions. Update the older one." }, 409);
    }
    const code = credential(c.req.header("Authorization"), "Pairing");
    const { name } = await c.req.json<{ name?: string }>();
    const keys = code && store.pair(code, name?.trim() || "Phone");
    if (!keys) return c.json({ error: "That code has been used or has run out. Make a new one on the computer." }, 401);
    const paired: Paired = { ...keys, machine };
    return c.json(paired, 201);
  });

  app.use(async (c, next) => {
    const key = credential(c.req.header("Authorization"), "Bearer");
    const device = key ? store.deviceByKey(key) : undefined;
    if (!device) return c.json({ error: "This phone isn't paired with this computer." }, 401);
    c.set("device", device);
    c.set("person", store.person(device.person_id)!);
    await next();
  });

  /** The agent, if it belongs to the person asking. */
  const ownAgent = (person: Person, id: string) => {
    const agent = store.agent(id);
    return agent && agent.person_id === person.id ? agent : undefined;
  };

  app.get("/agents", (c) => c.json(store.agentsFor(c.var.person.id)));

  app.post("/agents", async (c) => {
    const { name, avatarId } = await c.req.json<{ name?: string; avatarId?: string }>();
    if (!name?.trim() || !avatarId?.trim()) return c.json({ error: "An agent needs a name and an avatar." }, 400);
    return c.json(store.createAgent(c.var.person, name.trim(), avatarId.trim()), 201);
  });

  /** Changes any of an agent's name, avatar, model, effort and colour, and whether it is muted or hidden. A colour of null takes the avatar's. */
  app.patch("/agents/:id", async (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    const { name, avatarId, model, effort, muted, hidden, color } = await c.req.json<{
      name?: string;
      avatarId?: string;
      model?: string;
      effort?: string;
      muted?: boolean;
      hidden?: boolean;
      color?: string | null;
    }>();
    const changes: AgentChanges = {};
    if (name !== undefined) {
      if (!name.trim()) return c.json({ error: "An agent needs a name." }, 400);
      changes.name = name.trim();
    }
    if (avatarId !== undefined) {
      if (!store.avatarSheet(avatarId)) return c.json({ error: "No such avatar." }, 400);
      changes.avatar_id = avatarId;
    }
    if (model !== undefined) {
      if (!Object.hasOwn(PROVIDERS[agent.provider].models, model)) return c.json({ error: "No such model." }, 400);
      changes.model = model as Model;
    }
    if (effort !== undefined) {
      if (!Object.hasOwn(PROVIDERS[agent.provider].efforts, effort)) return c.json({ error: "No such effort." }, 400);
      changes.effort = effort as Effort;
    }
    if (typeof muted === "boolean") changes.muted = muted;
    if (typeof hidden === "boolean") changes.hidden = hidden;
    if (color !== undefined) {
      if (color !== null && (typeof color !== "string" || !COLOR.test(color))) return c.json({ error: "A colour is #RRGGBB, or null for the avatar's." }, 400);
      changes.color = color === null ? null : color.toUpperCase();
    }
    store.updateAgent(agent, changes);
    return c.json(store.agentWithLatest(agent.id));
  });

  /** Removes an agent with everything it had. A turn it is running is stopped first. */
  app.delete("/agents/:id", async (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    await queue.remove(agent);
    store.deleteAgent(agent);
    return c.json({});
  });

  app.get("/agents/:id/about", (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    return c.json(store.about(agent));
  });

  app.delete("/agents/:id/jobs/:job", (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent || !store.removeJob(agent.id, c.req.param("job"))) return c.json({ error: "No such job." }, 404);
    return c.json({});
  });

  app.get("/agents/:id/messages", (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    return c.json(store.messages(agent.id, { after: c.req.query("after"), before: c.req.query("before") }));
  });

  /**
   * A message arrives as a form, with `body` for the text, `files` for anything
   * sent with it, and `replyTo` for the message it answers. Text alone can come as JSON.
   */
  app.post("/agents/:id/messages", bodyLimit({ maxSize: MESSAGE_BYTES }), async (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    const json = c.req.header("Content-Type")?.startsWith("application/json");
    const form = json ? await c.req.json<Record<string, unknown>>() : await c.req.parseBody({ all: true });
    const body = typeof form.body === "string" ? form.body.trim() : "";
    const files = [form.files].flat().filter((file) => file instanceof File);
    if (!body && files.length === 0) return c.json({ error: "A message needs some text or a file." }, 400);
    const uploads = await Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
    const replyTo = typeof form.replyTo === "string" ? store.message(agent.id, form.replyTo)?.id : undefined;
    const message = store.addMessage(agent.id, "person", body, "queued", { files: uploads, replyTo });
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

  /** The person's answer to an ask: whether the agent may do what it asked about. Answers with the ask as it now stands. */
  app.post("/agents/:id/asks/:message", async (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    const { allow } = await c.req.json<{ allow?: boolean }>();
    if (typeof allow !== "boolean") return c.json({ error: "An answer is yes or no." }, 400);
    if (!queue.answer(agent.id, c.req.param("message"), allow)) return c.json({ error: "The agent is no longer waiting for an answer to that." }, 409);
    return c.json(store.message(agent.id, c.req.param("message")));
  });

  /** The messages that contain `text`, in any of the person's chats. */
  app.get("/search", (c) => {
    const text = c.req.query("text")?.trim();
    return c.json(text ? store.searchMessages(c.var.person.id, text) : []);
  });

  /** The phone says where Apple delivers its notifications, once it allows them. */
  app.put("/push-token", async (c) => {
    const { token, environment, app } = await c.req.json<Partial<PushToken>>();
    if (!token || !DEVICE_TOKEN.test(token) || (environment !== "sandbox" && environment !== "production") || (app !== undefined && !BUNDLE_ID.test(app))) {
      return c.json({ error: "A push token comes with its push service, and the app it is for when the app says." }, 400);
    }
    const push: PushToken = app === undefined ? { token, environment } : { token, environment, app };
    store.setPushToken(c.var.device.id, push);
    return c.json(push);
  });

  /** The phone unpairs itself. The computer forgets it, with its keys and where its notifications go, and refuses it from its next request. */
  app.delete("/device", (c) => {
    store.removeDevice(c.var.device.id);
    return c.json({});
  });

  app.get("/avatars", (c) => c.json(store.avatars()));

  app.get("/avatars/:id/spritesheet", (c) => {
    const path = store.avatarSheet(c.req.param("id"));
    if (!path) return c.json({ error: "No such avatar." }, 404);
    return c.body(readFileSync(path), 200, { "Content-Type": "image/png", "Cache-Control": "max-age=3600" });
  });

  /**
   * New messages and status changes for the person's agents, each with its
   * agent as the home screen shows it, and the agents the person adds and
   * deletes, so every phone of theirs keeps up.
   */
  app.get("/events", (c) => {
    const person = c.var.person;
    return streamSSE(c, async (stream) => {
      const send = (name: string, event: StreamEvent) => void stream.writeSSE({ event: name, data: JSON.stringify(event) });
      const stop = store.onChange((change) => {
        if ("agent" in change) {
          if (change.agent.person_id !== person.id) return;
          if (change.deleted) return send("deleted", { deleted: change.agent.id });
          return send("agent", { message: null, agent: store.agentWithLatest(change.agent.id)! });
        }
        const agent = store.agentWithLatest(change.message.agent_id);
        if (agent?.person_id === person.id) send("message", { message: change.message, agent });
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
