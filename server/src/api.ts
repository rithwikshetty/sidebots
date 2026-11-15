// The api owns the HTTP routes and works out which person is asking.

import { Hono } from "hono";
import type { Person, Store } from "./store.ts";
import type { Queue } from "./runner.ts";

// `tailscale serve` adds the sender's Tailscale login to every request.
const LOGIN_HEADER = "Tailscale-User-Login";

export function createApi(store: Store, queue: Queue) {
  const app = new Hono<{ Variables: { person: Person } }>();

  app.use(async (c, next) => {
    const login = c.req.header(LOGIN_HEADER);
    const person = login ? store.personByLogin(login) : undefined;
    if (!person) return c.json({ error: "This Tailscale login isn't set up on this Julius server." }, 403);
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

  app.post("/agents/:id/messages", async (c) => {
    const agent = ownAgent(c.var.person, c.req.param("id"));
    if (!agent) return c.json({ error: "No such agent." }, 404);
    const { body } = await c.req.json<{ body?: string }>();
    if (!body?.trim()) return c.json({ error: "A message needs some text." }, 400);
    const message = store.addMessage(agent.id, "person", body.trim(), "queued");
    void queue.kick(agent.id);
    return c.json(message, 201);
  });

  return app;
}
