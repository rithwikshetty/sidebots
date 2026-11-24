// The api owns the HTTP routes and works out which paired device is asking, and whose it is.

import { createReadStream, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { COLOR, CONNECTIONS, CONTRACT_HEADER, CONTRACT_VERSION, KEEPALIVE_MS, MESSAGE_BYTES, PROVIDERS, effortMoved } from "./contract.ts";
import type { Connection, Effort, Model, Paired, Provider, PushToken, StreamEvent } from "./contract.ts";
import type { Connections } from "./connections.ts";
import type { AgentChanges, Device, Person, Store } from "./store.ts";
import type { Queue } from "./runner.ts";

// A token of Apple's as the phone reports it, in hex: 32 bytes for a phone today and 128 for a Live Activity, with room for Apple to lengthen either.
const DEVICE_TOKEN = /^[0-9a-f]{64,512}$/;
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

/** Where Apple delivers to a phone, as the phone sent it, or nothing when it isn't one. */
function pushToken({ token, environment, app }: Partial<PushToken>): PushToken | undefined {
  if (!token || !DEVICE_TOKEN.test(token) || (environment !== "sandbox" && environment !== "production") || (app !== undefined && !BUNDLE_ID.test(app))) return undefined;
  return app === undefined ? { token, environment } : { token, environment, app };
}
const NOT_A_PUSH_TOKEN = "A push token comes with its push service, and the app it is for when the app says.";

/** What a request's `Authorization` header carries under a scheme, as in `Bearer <key>`. */
function credential(header: string | undefined, scheme: string): string | undefined {
  return header?.startsWith(`${scheme} `) ? header.slice(scheme.length + 1) : undefined;
}

/**
 * `machine` is the name of the machine the server runs on, which a phone shows
 * once it has paired. `pushes` says whether the server sends through a relay,
 * without which it can't end a Live Activity.
 */
export function createApi(store: Store, queue: Queue, connections: Connections, machine: string, pushes: boolean) {
  const app = new Hono<{ Variables: { person: Person; device: Device } }>();

  /** Every answer says which version of the contract the server speaks, so the app can tell which side to update. */
  app.use(async (c, next) => {
    c.header(CONTRACT_HEADER, String(CONTRACT_VERSION));
    await next();
  });

  /**
   * Pairs a device that brings a code made by `pair`. It is the one route a
   * device can call without a key. An app on another version of the contract
   * is refused before the code is used, so the code still works once one side
   * is updated. An app that sends no version counts as older. `kind` says
   * whether the device is a phone or the desktop app, and one that names none
   * is a phone. `replaces` is the hash of the key of a pairing the device had
   * and lost, which this one takes the place of.
   */
  app.post("/pair", async (c) => {
    if (Number(c.req.header(CONTRACT_HEADER)) !== CONTRACT_VERSION) {
      return c.json({ error: "This app and Sidebots on this computer speak different versions. Update the older one." }, 409);
    }
    const code = credential(c.req.header("Authorization"), "Pairing");
    const { name, kind = "phone", replaces } = await c.req.json<{ name?: string; kind?: string; replaces?: string }>();
    if (kind !== "phone" && kind !== "desktop") return c.json({ error: "A device is a phone or a desktop." }, 400);
    const keys = code && store.pair(code, name?.trim() || (kind === "phone" ? "Phone" : "Desktop"), kind, replaces);
    if (!keys) return c.json({ error: "That code has been used or has run out. Make a new one on the computer." }, 401);
    const paired: Paired = { ...keys, machine };
    return c.json(paired, 201);
  });

  app.use(async (c, next) => {
    const key = credential(c.req.header("Authorization"), "Bearer");
    const device = key ? store.deviceByKey(key) : undefined;
    if (!device) return c.json({ error: "This device isn't paired with this computer." }, 401);
    c.set("device", device);
    c.set("person", store.person(device.person_id)!);
    await next();
  });

  /** The agent, if it belongs to the person asking. */
  const ownAgent = (person: Person, id: string) => {
    const agent = store.agent(id);
    return agent && agent.person_id === person.id ? agent : undefined;
  };

  /**
   * The cheapest thing to ask the server: it answers a paired device with
   * nothing. An answer says the server is up and which version of the
   * contract it speaks, and whether it is a refusal says whether the server
   * knows the key that asked.
   */
  app.get("/status", (c) => c.body(null, 204));

  app.get("/agents", (c) => c.json(store.agentsFor(c.var.person.id)));

  /** Adds an agent, on one of the providers the person has set up: the one named, or the first they set up. */
  app.post("/agents", async (c) => {
    const { name, avatarId, provider } = await c.req.json<{ name?: string; avatarId?: string; provider?: string }>();
    if (!name?.trim() || !avatarId?.trim()) return c.json({ error: "An agent needs a name and an avatar." }, 400);
    const account = store.accounts(c.var.person.id).find((each) => provider === undefined || each.provider === provider);
    if (!account) return c.json({ error: `${Object.hasOwn(PROVIDERS, provider!) ? PROVIDERS[provider as Provider].name : "That"} isn't set up on your computer.` }, 400);
    return c.json(store.createAgent(c.var.person, name.trim(), avatarId.trim(), account.provider), 201);
  });

  /**
   * Changes any of an agent's name, avatar and colour, what it answers with,
   * and whether it is muted or hidden. A colour of null takes the avatar's.
   * What it answers with is its provider, which is one the person has set
   * up, one of the provider's models, an effort, and whether it answers in
   * fast mode, and takes effect from the agent's next turn. An agent moved
   * to another provider without a model named starts on the one a new agent
   * starts on there, and keeps its effort when the provider has it.
   */
  app.patch("/agents/:id", async (c) => {
    const { name, avatarId, provider, model, effort, fast, muted, hidden, color } = await c.req.json<{
      name?: string;
      avatarId?: string;
      provider?: string;
      model?: string;
      effort?: string;
      fast?: boolean;
      muted?: boolean;
      hidden?: boolean;
      color?: string | null;
    }>();
    // The agent as it is once the body is in, so a change that came in meanwhile is checked against.
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    const changes: AgentChanges = {};
    if (name !== undefined) {
      if (!name.trim()) return c.json({ error: "An agent needs a name." }, 400);
      changes.name = name.trim();
    }
    if (avatarId !== undefined) {
      if (!store.avatarSheet(avatarId)) return c.json({ error: "No such avatar." }, 400);
      changes.avatar_id = avatarId;
    }
    if (provider !== undefined && provider !== agent.provider) {
      if (!Object.hasOwn(PROVIDERS, provider) || !store.account(c.var.person.id, provider as Provider)) return c.json({ error: "That isn't set up on your computer." }, 400);
      changes.provider = provider as Provider;
      changes.model = PROVIDERS[changes.provider].model;
      changes.effort = effortMoved(changes.provider, agent.effort);
    }
    const offered = PROVIDERS[changes.provider ?? agent.provider];
    if (model !== undefined) {
      if (!Object.hasOwn(offered.models, model)) return c.json({ error: "No such model." }, 400);
      changes.model = model as Model;
    }
    if (effort !== undefined) {
      if (!Object.hasOwn(offered.efforts, effort)) return c.json({ error: "No such effort." }, 400);
      changes.effort = effort as Effort;
    }
    if (typeof fast === "boolean") changes.fast = fast;
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
    return c.json(store.messages(agent.id, { after: c.req.query("after"), before: c.req.query("before"), through: c.req.query("through") }));
  });

  /**
   * A message arrives as a form, with `body` for the text, `files` for anything
   * sent with it, and `replyTo` for the message it answers. Text alone can come as JSON.
   * A browser writes each line break in a form's text as CRLF, and the text
   * is kept with plain newlines whichever app sent it.
   */
  app.post("/agents/:id/messages", bodyLimit({ maxSize: MESSAGE_BYTES }), async (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    const json = c.req.header("Content-Type")?.startsWith("application/json");
    const form = json ? await c.req.json<Record<string, unknown>>() : await c.req.parseBody({ all: true });
    const body = typeof form.body === "string" ? form.body.replaceAll("\r\n", "\n").trim() : "";
    const files = [form.files].flat().filter((file) => file instanceof File);
    if (!body && files.length === 0) return c.json({ error: "A message needs some text or a file." }, 400);
    const uploads = await Promise.all(files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })));
    const replyTo = typeof form.replyTo === "string" ? store.message(agent.id, form.replyTo)?.id : undefined;
    const message = store.addMessage(agent.id, "person", body, "queued", { files: uploads, replyTo });
    void queue.kick(agent.id);
    return c.json(message, 201);
  });

  /**
   * Sends again a message the agent never answered: one whose turn failed, or
   * was stopped before the agent read it. It waits its turn as it was sent,
   * with its files and the message it answers.
   */
  app.post("/agents/:id/messages/:message/resend", (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    const message = agent && store.message(agent.id, c.req.param("message"));
    if (!agent || message?.sender !== "person" || message.status !== "failed") return c.json({ error: "No such message to send again." }, 404);
    store.setStatus(message.id, "queued");
    void queue.kick(agent.id);
    return c.json({});
  });

  /**
   * A file in an agent's `attachments/` folder, sent as it is read, a piece at
   * a time, so the server holds only what is on its way to the app however
   * large the file is. Asked with HEAD, it answers only with the file's type
   * and size, so an app can say how big a file is without fetching it.
   */
  app.get("/agents/:id/attachments/:name", (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    const path = agent && store.attachment(agent.id, c.req.param("name"));
    if (!path) return c.json({ error: "No such file." }, 404);
    const headers = { "Content-Type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream", "Content-Length": String(statSync(path).size), "Cache-Control": "private, max-age=31536000, immutable" };
    return c.req.method === "HEAD" ? c.body(null, 200, headers) : c.body(Readable.toWeb(createReadStream(path)) as ReadableStream, 200, headers);
  });

  app.post("/agents/:id/read", (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    return c.json(store.markRead(agent.id));
  });

  app.post("/agents/:id/fresh-start", (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    return c.json(queue.freshStart(agent.id), 201);
  });

  /** Stops the turn the agent is running. The chat says so once the turn has ended. */
  app.post("/agents/:id/stop", (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    queue.stop(agent.id);
    return c.json({});
  });

  /** The person's answer to an ask: whether the agent may do what it asked about. Answers with the ask as it now stands. An ask for a connection takes only a no here, since making the connection is its yes. */
  app.post("/agents/:id/asks/:message", async (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    const { allow } = await c.req.json<{ allow?: boolean }>();
    if (typeof allow !== "boolean") return c.json({ error: "An answer is yes or no." }, 400);
    if (!queue.answer(agent.id, c.req.param("message"), allow)) return c.json({ error: "The agent is no longer waiting for an answer to that." }, 409);
    return c.json(store.message(agent.id, c.req.param("message")));
  });

  /** The connection a request names, when Sidebots has one by that id. */
  const connectionNamed = (id: string) => (Object.hasOwn(CONNECTIONS, id) ? (id as Connection) : undefined);
  const said = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

  /** The apps the person's agents can use as them, each with the account it is connected as. */
  app.get("/connections", (c) => c.json(connections.list(c.var.person.id)));

  /** Starts the person's sign-in to a connection, and answers where the phone opens it. */
  app.post("/connections/:id/sign-in", (c) => {
    const connection = connectionNamed(c.req.param("id"));
    if (!connection) return c.json({ error: "No such connection." }, 404);
    try {
      return c.json(connections.signIn(c.var.person.id, connection), 201);
    } catch (failure) {
      return c.json({ error: said(failure) }, 501);
    }
  });

  /**
   * Makes a connection from `url`, the address its sign-in's page ended on in
   * the phone, and answers with it as it now stands. The person's agents that
   * wait for the connection go on.
   */
  app.put("/connections/:id", async (c) => {
    const connection = connectionNamed(c.req.param("id"));
    if (!connection) return c.json({ error: "No such connection." }, 404);
    const { url } = await c.req.json<{ url?: string }>();
    if (typeof url !== "string") return c.json({ error: "A connection is made from the address its sign-in ended on." }, 400);
    try {
      const connected = await connections.finish(c.var.person.id, connection, url);
      queue.connected(c.var.person.id, connection);
      return c.json(connected);
    } catch (failure) {
      return c.json({ error: said(failure) }, 400);
    }
  });

  /** Forgets a connection, so none of the person's agents can use it. */
  app.delete("/connections/:id", (c) => {
    const connection = connectionNamed(c.req.param("id"));
    if (!connection) return c.json({ error: "No such connection." }, 404);
    connections.remove(c.var.person.id, connection);
    return c.json({});
  });

  /** The messages that contain `text`, in any of the person's chats. */
  app.get("/search", (c) => {
    const text = c.req.query("text")?.trim();
    return c.json(text ? store.searchMessages(c.var.person.id, text) : []);
  });

  /** Where the person's plan or API credit goes, with the plan's limits as its provider says they stand now. */
  app.get("/usage", async (c) => {
    return c.json(store.usage(c.var.person.id, await queue.askLimits(c.var.person.id)));
  });

  /** The phone says where Apple delivers its notifications, once it allows them. */
  app.put("/push-token", async (c) => {
    const push = pushToken(await c.req.json<Partial<PushToken>>());
    if (!push) return c.json({ error: NOT_A_PUSH_TOKEN }, 400);
    store.setPushToken(c.var.device.id, push);
    return c.json(push);
  });

  /**
   * The phone says where Apple delivers to the Live Activity it shows for a
   * working agent, so the server can end the activity when the work does. A
   * token the server could never use is refused, and the phone ends the
   * activity itself: when the agent has no work left, and when the server
   * sends nothing to Apple.
   */
  app.put("/agents/:id/activity-token", async (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    const push = pushToken(await c.req.json<Partial<PushToken>>());
    if (!push) return c.json({ error: NOT_A_PUSH_TOKEN }, 400);
    if (!pushes) return c.json({ error: "This computer sends nothing to Apple, so it can't end a Live Activity." }, 501);
    if (!store.agentWithLatest(agent.id)!.working) return c.json({ error: "The agent isn't working." }, 409);
    store.setActivityToken(c.var.device.id, agent.id, push);
    return c.json(push);
  });

  /** The device unpairs itself. The computer forgets it, with its keys and where its notifications go, and refuses it from its next request. */
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
   * agent as the home screen shows it, and the agents the person adds, changes
   * and deletes, so every device of theirs keeps up.
   */
  app.get("/events", (c) => {
    const person = c.var.person;
    return streamSSE(c, async (stream) => {
      const send = (name: string, event: StreamEvent) => void stream.writeSSE({ event: name, data: JSON.stringify(event) });
      const stop = store.onChange((change) => {
        if ("agent" in change) {
          if (change.agent.person_id !== person.id) return;
          if (change.deleted) return send("deleted", { deleted: change.agent.id });
          return send("agent", { message: null, agent: change.agent });
        }
        // A message between two agents is in both their chats, and changes how both stand.
        for (const agent of change.agents) {
          if (agent.person_id === person.id) send("message", { message: change.message, agent });
        }
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
