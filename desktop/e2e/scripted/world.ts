// A Sidebots server whose agents are scripted, assembled as server/src/main.ts
// assembles the real one: the store, the connections, the queue and the API,
// with no relay and no tunnel. The providers' turns are script.ts. The
// makers of the connections are answered here, so a sign-in finishes with no
// Google or Notion. The test controls are served under `/__test/`, which
// only this harness has.

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONTRACT_HEADER, CONTRACT_VERSION, PROVIDERS, type Provider } from "../../../server/src/contract.ts";
import { createConnections } from "../../../server/src/connections.ts";
import { createQueue } from "../../../server/src/runner.ts";
import { createApi } from "../../../server/src/api.ts";
import { openStore, type Person, type Store } from "../../../server/src/store.ts";
import { ASK_KINDS, createClock, createScript, type Action, type AskKind } from "./script.ts";
import { seed } from "./seed.ts";
import { PAGES, budget, picture, type Made } from "./files.ts";

const SERVER = join(import.meta.dirname, "..", "..", "..", "server");
const AVATARS = join(SERVER, "..", "avatars");
/** The client ids main.ts signs in with, so the sign-in addresses read as the real ones. */
const CLIENTS = { google: "161867342001-s22m1k5cbkf1vg7s9qhsb66cqhs12ehh.apps.googleusercontent.com", notion: "https://sidebots.app/oauth-client.json" };
/** The person every world has, and the API key their Codex runs on. */
export const PERSON = "Tester";
const CODEX_KEY = "sk-test-sidebots-e2e";

/** What `run` is given: the data folder, the port, which world to start in, and how long a plain reply takes. */
export type WorldOptions = { home: string; port: number; world: "seeded" | "empty" | "nobody"; pause: number };

/** The server's own `serve`, from its own dependencies, since the desktop app has none of the server's. */
type Serve = (options: { fetch: (request: Request) => Response | Promise<Response>; hostname: string; port: number }, listening: () => void) => Server;
async function serveOf(): Promise<Serve> {
  const found = createRequire(join(SERVER, "package.json")).resolve("@hono/node-server");
  return ((await import(pathToFileURL(found).href)) as { serve: Serve }).serve;
}

/**
 * Answers what the connections ask Google and Notion: any code is swapped for
 * tokens that allow everything, for an account named after the maker.
 */
async function makers(url: string | URL | Request): Promise<Response> {
  const address = String(url instanceof Request ? url.url : url);
  const google = { email: "tester@example.com" };
  const idToken = `e30.${Buffer.from(JSON.stringify(google)).toString("base64url")}.signature`;
  if (address === "https://oauth2.googleapis.com/token") {
    const scope = ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly"].join(" ");
    return Response.json({ access_token: "test-google-access", expires_in: 3600, refresh_token: "test-google-refresh", scope, id_token: idToken });
  }
  if (address === "https://mcp.notion.com/token") return Response.json({ access_token: "test-notion-access", expires_in: 3600, refresh_token: "test-notion-refresh", scope: "default", workspace_name: "Tester's Notion" });
  return Response.json({ error: { message: "The test harness answers only sign-ins." } }, { status: 404 });
}

/** Tester, on both providers: Claude Code on a plan, Codex on an API key. */
function addTester(store: Store, home: string): Person {
  const folders = Object.fromEntries((Object.keys(PROVIDERS) as Provider[]).map((provider) => [provider, join(home, "providers", provider)]));
  for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });
  const person = store.addPerson({ name: PERSON, provider: "claude", configDir: folders.claude });
  store.addAccount(person.id, "codex", folders.codex);
  store.setApiKey(person.id, "codex", CODEX_KEY);
  return person;
}

/** Starts the scripted server, and resolves once it is listening. */
export async function run({ home, port, world, pause: firstPause }: WorldOptions): Promise<void> {
  const store = openStore(home);
  store.installStarterAvatars(AVATARS);
  // The address phones reach the computer at, which a real server gets from the relay. A phone on this computer reaches it here.
  if (!store.machine()) store.setMachine({ privateKey: "", address: `127.0.0.1:${port}` });
  // A home is filled once. Started again on the same home, the server carries on with what is there.
  const fresh = store.people().length === 0;
  const person = fresh && world !== "nobody" ? addTester(store, home) : store.personByName(PERSON);
  const seeded = fresh && world === "seeded" && person ? seed(store, person) : undefined;

  let pause = firstPause;
  const actions = new Map<string, Action>();
  const clock = createClock();
  const connections = createConnections(store, CLIENTS, makers);
  const queue = createQueue(store, createScript(store, { pause: () => pause, actions, clock }), connections, clock.now);
  for (const agentId of store.requeueInterrupted()) void queue.kick(agentId);
  queue.startClock();
  const api = createApi(store, queue, connections, "Test Mac", false);

  // What the controls have the server do: answer with another contract version, refuse everything for a while, refuse the event stream for a while, hold the requests whose address matches a pattern.
  let contract: number | null = null;
  let outageUntil = 0;
  let noEventsUntil = 0;
  let holding: RegExp | null = null;
  const waiting = new Set<() => void>();
  let answeredAfterHold = 0;
  const streams = new Set<() => void>();
  const holds = new Map<string, () => void>();

  const refuse = () => {
    const headers = new Headers({ [CONTRACT_HEADER]: String(contract ?? CONTRACT_VERSION) });
    return Response.json({ error: "Sidebots is out of reach for the moment." }, { status: 503, headers });
  };
  /** Ends every open event stream, as when the connection to the computer drops. */
  const dropStreams = () => [...streams].forEach((end) => end());

  /** An event stream that the controls can end. */
  function endable(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let ended = false;
    let end = () => undefined as void;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        end = () => {
          if (ended) return;
          ended = true;
          streams.delete(end);
          void reader.cancel().catch(() => undefined);
          controller.close();
        };
        streams.add(end);
      },
      async pull(controller) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (ended) return;
        if (done || !value) end();
        else controller.enqueue(value);
      },
      cancel() {
        ended = true;
        streams.delete(end);
        return reader.cancel();
      },
    });
  }

  /** The agent a control names, by its id or its name. */
  const agentNamed = (named: unknown) => {
    const all = person ? store.agentsFor(person.id) : [];
    return all.find((agent) => agent.id === named) ?? all.find((agent) => agent.name.toLowerCase() === String(named).toLowerCase());
  };
  const said = (words: string, status = 400) => Response.json({ error: words }, { status });

  /** Sends a message as the person, as a phone does, and starts the agent's turn. */
  const fromPerson = (agentId: string, body: string) => {
    const message = store.addMessage(agentId, "person", body, "queued");
    void queue.kick(agentId);
    return message;
  };

  /** The test controls. Each takes JSON and answers JSON. */
  async function control(request: Request, path: string): Promise<Response> {
    const body = (request.method === "POST" ? await request.json().catch(() => ({})) : {}) as Record<string, unknown>;
    if (path === "state") {
      return Response.json({ home, port, person: person?.name ?? null, pause, contract, outage: outageUntil > Date.now(), held: { waiting: waiting.size, answered: answeredAfterHold }, agents: person ? store.agentsFor(person.id).map(({ id, name }) => ({ id, name })) : [] });
    }
    if (path === "pause") {
      pause = Number(body.ms);
      return Response.json({ pause });
    }
    if (path === "contract") {
      contract = body.version === "older" ? CONTRACT_VERSION - 1 : body.version === "newer" ? CONTRACT_VERSION + 1 : typeof body.version === "number" ? body.version : null;
      return Response.json({ contract: contract ?? CONTRACT_VERSION });
    }
    if (path === "outage") {
      const ms = body.ms === undefined ? 24 * 60 * 60_000 : Number(body.ms);
      outageUntil = Date.now() + ms;
      if (ms > 0) dropStreams();
      return Response.json({ until: ms > 0 ? outageUntil : null });
    }
    if (path === "hold-requests") {
      holding = typeof body.match === "string" ? new RegExp(body.match) : null;
      if (holding === null) {
        waiting.forEach((go) => go());
        waiting.clear();
      }
      return Response.json({ match: holding?.source ?? null });
    }
    if (path === "drop-events") {
      noEventsUntil = Date.now() + Number(body.ms ?? 0);
      dropStreams();
      return Response.json({ until: noEventsUntil });
    }
    if (path === "address") {
      store.setMachine({ ...store.machine()!, address: typeof body.address === "string" ? body.address : undefined });
      return Response.json({ address: store.machine()?.address ?? null });
    }
    if (!person) return said("Nobody is set up on this server.", 409);
    if (path === "agents") {
      const provider = (body.provider ?? "claude") as Provider;
      if (typeof body.name !== "string" || !Object.hasOwn(PROVIDERS, provider)) return said("An agent needs a name, and a provider of claude or codex.");
      return Response.json(store.createAgent(person, body.name, typeof body.avatar === "string" ? body.avatar : "cog", provider), { status: 201 });
    }
    const agent = agentNamed(body.agent);
    if (!agent) return said(`No agent called ${String(body.agent)}.`, 404);
    if (path === "hold") {
      const held = new Promise<void>((resolve) => holds.set(agent.id, resolve));
      actions.set(agent.id, { hold: held });
      const message = fromPerson(agent.id, typeof body.message === "string" ? body.message : "Can you pull together this month's receipts?");
      return Response.json(message, { status: 201 });
    }
    if (path === "release") {
      const release = holds.get(agent.id);
      holds.delete(agent.id);
      release?.();
      return Response.json({ released: Boolean(release) });
    }
    if (path === "ask") {
      const kind = (ASK_KINDS.includes(body.kind as AskKind) ? body.kind : "command") as AskKind;
      actions.set(agent.id, { ask: kind });
      if (body.job === true) {
        // A job's run asks, with no message of the person's.
        const job = store.addJob(agent.id, "Tidy up the week's files before the weekend.", { type: "once", at: Date.now() - 1 }, Date.now() - 1);
        void queue.kick(agent.id);
        return Response.json(job, { status: 201 });
      }
      const words = { command: "Clear out the old invoices in Downloads", file: "Save the tax notes to my Documents", page: "Check the council's page for the Christmas bin dates", tool: "Email Hughes and ask them to come this week" }[kind];
      return Response.json(fromPerson(agent.id, typeof body.message === "string" ? body.message : words), { status: 201 });
    }
    if (path === "deliver") {
      // A message the agent sends by itself, as a job's run sends one.
      const kinds: Record<string, () => Made> = { image: () => picture(0), page: PAGES.short, csv: budget };
      const files = (Array.isArray(body.files) ? body.files : []).flatMap((kind) => (kinds[String(kind)] ? [kinds[String(kind)]()] : []));
      const jobId = store.jobs(agent.id)[0]?.id;
      const text = typeof body.text === "string" ? body.text : "Reminder: the car insurance renews on the 3rd. Want me to look for a better quote?";
      return Response.json(store.addMessage(agent.id, "agent", text, "done", { files, ...(jobId ? { jobId } : {}) }), { status: 201 });
    }
    if (path === "run-job") {
      const job = store.jobs(agent.id)[0];
      if (!job) return said(`${agent.name} has no jobs.`, 404);
      store.setJobNext(job.id, Date.now() - 1);
      void queue.kick(agent.id);
      return Response.json(job);
    }
    return said(`There is no control called ${path}.`, 404);
  }

  async function fetch(request: Request): Promise<Response> {
    const { pathname, search } = new URL(request.url);
    if (pathname.startsWith("/__test/")) return control(request, pathname.slice("/__test/".length));
    if (outageUntil > Date.now() || (pathname === "/events" && noEventsUntil > Date.now())) return refuse();
    const held = holding?.test(`${pathname}${search}`) ?? false;
    if (held) await new Promise<void>((go) => waiting.add(go));
    const answer = await api.fetch(request);
    if (held) answeredAfterHold++;
    if (contract === null && pathname !== "/events") return answer;
    const headers = new Headers(answer.headers);
    if (contract !== null) headers.set(CONTRACT_HEADER, String(contract));
    const body = pathname === "/events" && answer.body ? endable(answer.body) : answer.body;
    return new Response(body, { status: answer.status, statusText: answer.statusText, headers });
  }

  const serve = await serveOf();
  await new Promise<void>((resolve) => serve({ fetch, hostname: "127.0.0.1", port }, resolve));
  seeded?.start(queue, actions);
  const what = world === "nobody" && fresh ? "nobody set up" : seeded ? "the seeded world" : fresh ? `${PERSON}, with no agents` : "what the home already held";
  console.log(`Scripted Sidebots is listening on http://127.0.0.1:${port}, with ${what}, and data in ${home}`);
}
