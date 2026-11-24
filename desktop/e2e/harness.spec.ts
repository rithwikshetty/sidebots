// Tests of the harness itself, with no app: the scripted server answers each
// command as server.ts says, the seed makes the world seed.ts describes, and
// the test controls do what they say. Each drives the server over HTTP as a
// phone of Tester's would.

import { CONTRACT_VERSION, type About, type AgentWithLatest, type Connected, type Message, type Usage } from "../../server/src/contract.ts";
import { expect, test, type TestServer } from "./fixtures.ts";

/** Reads `read` until `done` holds, and resolves to what it read last. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`Gave up waiting. Last read: ${JSON.stringify(value, null, 2).slice(0, 2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const json = async <T>(server: TestServer, path: string, init?: RequestInit): Promise<T> => (await server.api(path, init)).json() as Promise<T>;
const chat = (server: TestServer, agentId: string, after?: string) => json<Message[]>(server, `/agents/${agentId}/messages${after ? `?after=${after}` : ""}`);
const agents = (server: TestServer) => json<AgentWithLatest[]>(server, "/agents");

/** Adds an agent as the phone does. */
async function newAgent(server: TestServer, name: string, provider: "claude" | "codex" = "claude"): Promise<AgentWithLatest> {
  return json(server, "/agents", { method: "POST", body: JSON.stringify({ name, avatarId: "cog", provider }) });
}

/** A reply to the person: the agent's, not an update, an ask, or something between agents. */
const isReply = (message: Message) => message.sender === "agent" && !message.interim && message.ask === null && message.peer_id === null;

/** Sends a message, and resolves to it and what came after it once the agent has replied and stopped working. */
async function exchange(server: TestServer, agentId: string, body: string, files?: File[]) {
  const sent = await server.say(agentId, body, files);
  const after = await until(
    () => chat(server, agentId, sent.id),
    (messages) => messages.some(isReply) || messages.some((message) => message.sender === "sidebots" && message.status === "failed"),
  );
  await until(() => agents(server), (all) => !all.find((agent) => agent.id === agentId)!.working);
  return { sent: (await chat(server, agentId)).find((message) => message.id === sent.id)!, after: await chat(server, agentId, sent.id) };
}

/** Waits for the agent's ask, and resolves to it. */
const waitingAsk = (server: TestServer, agentId: string, after?: string) =>
  until(
    () => chat(server, agentId, after),
    (messages) => messages.some((message) => message.ask === "waiting"),
  ).then((messages) => messages.find((message) => message.ask === "waiting")!);

const answerAsk = (server: TestServer, agentId: string, ask: Message, allow: boolean) => server.api(`/agents/${agentId}/asks/${ask.id}`, { method: "POST", body: JSON.stringify({ allow }) });

/** A file's bytes, as the phone reads one. */
async function attachment(server: TestServer, agentId: string, path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await server.api(`/agents/${agentId}/${path}`)).arrayBuffer());
}

/** A PNG's width and height, from its header. */
const pngSize = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

/** Opens the event stream, and reads its events as they come. */
async function stream(server: TestServer) {
  const answer = await server.api("/events");
  const reader = answer.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const events: { event: string; data: string }[] = [];
  const ended = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      text += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = text.indexOf("\n\n")) >= 0) {
        const block = text.slice(0, end);
        text = text.slice(end + 2);
        const field = (name: string) => [...block.matchAll(/^(\w+): ?(.*)$/gm)].find((match) => match[1] === name)?.[2] ?? "";
        events.push({ event: field("event"), data: field("data") });
      }
    }
  })();
  return { status: answer.status, events, ended, close: () => reader.cancel().catch(() => undefined) };
}

test.describe("the scripted agents", () => {
  test("a plain message is read first, then answered", async ({ server }) => {
    const atlas = await newAgent(server, "Atlas");
    const { sent, after } = await exchange(server, atlas.id, "Can you check the budget for this month?");
    const reply = after.find(isReply)!;
    expect(sent.status).toBe("done");
    expect(sent.seen_at).not.toBeNull();
    expect(sent.seen_at!).toBeLessThan(reply.created_at);
    expect(reply.body).toContain("under budget");
  });

  test("/long answers in every kind of markdown", async ({ server }) => {
    const atlas = await newAgent(server, "Atlas");
    const reply = (await exchange(server, atlas.id, "/long")).after.find(isReply)!;
    for (const mark of ["## ", "### ", "1. ", "   - ", "| --- |", "`budget.json`", "```ts", "```python", "```bash", "](https://", "> ", "**", "*by itself*", "~~"]) expect(reply.body).toContain(mark);
  });

  test("/slow works for its seconds with an update halfway, and Stop ends it", async ({ server }) => {
    const atlas = await newAgent(server, "Atlas");
    const { after } = await exchange(server, atlas.id, "/slow 2");
    const update = after.find((message) => message.interim)!;
    const reply = after.find(isReply)!;
    expect(update.body).toContain("Halfway there");
    expect(update.created_at).toBeLessThan(reply.created_at);
    expect(reply.body).toContain("2 seconds");

    const long = await server.say(atlas.id, "/slow 30");
    await until(() => agents(server), (all) => all.find((agent) => agent.id === atlas.id)!.working);
    await until(() => chat(server, atlas.id), (messages) => messages.find((message) => message.id === long.id)!.seen_at !== null);
    await server.api(`/agents/${atlas.id}/stop`, { method: "POST" });
    const stopped = await until(() => chat(server, atlas.id, long.id), (messages) => messages.some((message) => message.sender === "sidebots"));
    expect(stopped.map((message) => message.body)).toEqual(["Stopped"]);
    await until(() => agents(server), (all) => !all.find((agent) => agent.id === atlas.id)!.working);
  });

  test("/fail fails as each provider words its failures", async ({ server }) => {
    const atlas = await newAgent(server, "Atlas");
    const patch = await newAgent(server, "Patch", "codex");
    const claude = await exchange(server, atlas.id, "/fail");
    expect(claude.sent.status).toBe("failed");
    expect(claude.after.at(-1)).toMatchObject({ sender: "sidebots", status: "failed" });
    expect(claude.after.at(-1)!.body).toMatch(/^Sidebots couldn't finish this\. Your Claude usage limit is reached\. It resets at \d+(am|pm) \(Europe\/London\)\.$/);
    const codex = await exchange(server, patch.id, "/fail signed-out");
    expect(codex.after.at(-1)!.body).toBe("Sidebots couldn't finish this. Codex on your computer is signed out. Sign in to it there.");
    expect((await exchange(server, patch.id, "/fail key")).after.at(-1)!.body).toBe("Sidebots couldn't finish this. OpenAI refused your API key. Save a new one on your computer.");
  });

  test("/ask asks before acting, and says what the person chose", async ({ server }) => {
    const atlas = await newAgent(server, "Atlas");
    for (const [kind, allow, said] of [
      ["command", true, "You said yes, so I cleared out"],
      ["file", false, "You said no"],
      ["page", true, "checked the council's page"],
      ["tool", false, "You said no"],
    ] as const) {
      const sent = await server.say(atlas.id, `/ask ${kind}`);
      const ask = await waitingAsk(server, atlas.id, sent.id);
      expect(ask.question!.kind).toBe(kind);
      expect(ask.question!.title).toBeTruthy();
      expect(ask.question!.what).toBeTruthy();
      expect(ask.question!.detail).toBeTruthy();
      expect(ask.question!.why).toBeTruthy();
      if (kind !== "command") expect(ask.question!.facts.length).toBeGreaterThan(0);
      expect((await answerAsk(server, atlas.id, ask, allow)).status).toBe(200);
      const after = await until(() => chat(server, atlas.id, sent.id), (messages) => messages.some(isReply));
      expect(after.find((message) => message.id === ask.id)!.ask).toBe(allow ? "allowed" : "refused");
      expect(after.find(isReply)!.body).toContain(said);
    }

    const twice = await server.say(atlas.id, "/ask twice");
    const first = await waitingAsk(server, atlas.id, twice.id);
    await answerAsk(server, atlas.id, first, true);
    const second = await waitingAsk(server, atlas.id, first.id);
    expect(second.question!.kind).toBe("tool");
    await answerAsk(server, atlas.id, second, false);
    const reply = (await until(() => chat(server, atlas.id, twice.id), (messages) => messages.some(isReply))).find(isReply)!;
    expect(reply.body).toContain("You said yes");
    expect(reply.body).toContain("you said no");
  });

  test("/connect asks for a connection, and a sign-in makes it", async ({ server }) => {
    const atlas = await newAgent(server, "Atlas");
    const sent = await server.say(atlas.id, "/connect gmail");
    const ask = await waitingAsk(server, atlas.id, sent.id);
    expect(ask.question).toMatchObject({ kind: "connection", connection: "gmail", title: "Connect Gmail" });
    const { url, redirect } = await json<{ url: string; redirect: string }>(server, "/connections/gmail/sign-in", { method: "POST" });
    const state = new URL(url).searchParams.get("state");
    const made = await json<Connected>(server, "/connections/gmail", { method: "PUT", body: JSON.stringify({ url: `${redirect}?state=${state}&code=test` }) });
    expect(made.account).toBe("tester@example.com");
    const reply = (await until(() => chat(server, atlas.id, sent.id), (messages) => messages.some(isReply))).find(isReply)!;
    expect(reply.body).toBe("Gmail is connected. Ask me again and I'll take a look.");

    const notion = await server.say(atlas.id, "/connect notion");
    await answerAsk(server, atlas.id, await waitingAsk(server, atlas.id, notion.id), false);
    const refused = (await until(() => chat(server, atlas.id, notion.id), (messages) => messages.some(isReply))).find(isReply)!;
    expect(refused.body).toBe("Okay, I won't connect Notion for now.");
    const listed = await json<Connected[]>(server, "/connections");
    expect(Object.fromEntries(listed.map((each) => [each.connection, each.account]))).toEqual({ gmail: "tester@example.com", calendar: null, notion: null });
  });

  test("/page, /image, /images, /files and /mixed send files the phone can read", async ({ server }) => {
    const atlas = await newAgent(server, "Atlas");
    const sent = async (body: string) => (await exchange(server, atlas.id, body)).after.find(isReply)!;

    const page = await sent("/page");
    expect(page.attachments).toEqual([expect.stringMatching(/^attachments\/[0-9a-f]{8}-Lisbon-weekend\.html$/)]);
    const html = new TextDecoder().decode(await attachment(server, atlas.id, page.attachments[0]));
    // The page is given the chat's background and text colour, and picks out the rest with the other variables.
    for (const variable of ["var(--ink2)", "var(--line)", "var(--field)", "var(--tint)"]) expect(html).toContain(variable);
    expect(html).toContain('href="https://');
    const tall = await sent("/page tall");
    const cards = new TextDecoder().decode(await attachment(server, atlas.id, tall.attachments[0]));
    expect(cards.match(/class="card/g)).toHaveLength(6);

    const image = await sent("/image");
    const bytes = await attachment(server, atlas.id, image.attachments[0]);
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(pngSize(bytes)).toEqual({ width: 1200, height: 800 });
    const images = await sent("/images 3");
    const shapes = await Promise.all(images.attachments.map(async (path) => pngSize(await attachment(server, atlas.id, path))));
    expect(new Set(shapes.map(({ width, height }) => (width / height).toFixed(2))).size).toBe(3);

    const files = await sent("/files");
    expect(files.attachments.map((path) => path.split(".").pop())).toEqual(["pdf", "csv", "txt", "zip"]);
    expect(new TextDecoder().decode((await attachment(server, atlas.id, files.attachments[0])).slice(0, 5))).toBe("%PDF-");
    expect(new TextDecoder().decode((await attachment(server, atlas.id, files.attachments[3])).slice(0, 2))).toBe("PK");

    const mixed = await sent("/mixed");
    expect(mixed.attachments.map((path) => path.split(".").pop())).toEqual(["png", "html", "csv"]);
    expect(mixed.body).toBeTruthy();
  });

  test("/agent asks another agent and passes on its answer, and /agent-ask has the other agent ask the person", async ({ server }) => {
    const atlas = await newAgent(server, "Atlas");
    const ledger = await newAgent(server, "Ledger", "codex");
    const sent = await server.say(atlas.id, "/agent Ledger can we afford £340 for the tiles this month?");
    const after = await until(() => chat(server, atlas.id, sent.id), (messages) => messages.some(isReply));
    const asked = after.find((message) => message.agent_id === atlas.id && message.peer_id === ledger.id)!;
    expect(asked).toMatchObject({ body: "can we afford £340 for the tiles this month?", status: "done" });
    expect(after.find((message) => message.interim)!.body).toBe("I've asked Ledger. I'll tell you what they say.");
    expect(after.find((message) => message.agent_id === ledger.id && message.reply_to === asked.id)!.body).toContain("£410 left in Home");
    expect(after.find(isReply)!.body).toMatch(/^Heard back from Ledger: There's £410/);

    const tidy = await server.say(atlas.id, "/agent-ask Ledger");
    const ask = await waitingAsk(server, atlas.id, tidy.id);
    expect(ask).toMatchObject({ agent_id: ledger.id, peer_id: atlas.id });
    await answerAsk(server, ledger.id, ask, true);
    const done = await until(() => chat(server, atlas.id, tidy.id), (messages) => messages.some(isReply));
    expect(done.find(isReply)!.body).toBe("Heard back from Ledger: Done: I cleared out 14 invoices older than a year.");
  });

  test("/job, /update, /silent and /echo-files", async ({ server }) => {
    const atlas = await newAgent(server, "Atlas");
    expect((await exchange(server, atlas.id, "/job")).after.find(isReply)!.body).toContain("7:30");
    const { jobs } = await json<About>(server, `/agents/${atlas.id}/about`);
    expect(jobs).toEqual([expect.objectContaining({ schedule: { type: "daily", time: "07:30" } })]);

    const update = (await exchange(server, atlas.id, "/update")).after;
    expect(update.filter((message) => message.interim).map((message) => message.body)).toEqual([
      "Found 23 flights for the weekend. Checking which ones have bags included.",
      "Down to four. Now comparing the hotels near each airport.",
    ]);
    expect(update.at(-1)!.interim).toBe(false);

    const silent = await exchange(server, atlas.id, "/silent");
    expect(silent.sent.status).toBe("done");
    expect(silent.after.find(isReply)!.body).toBe("");

    const echo = await exchange(server, atlas.id, "/echo-files", [new File(["hello"], "notes.txt"), new File([new Uint8Array(2048)], "photo of the tap.png")]);
    expect(echo.after.find(isReply)!.body).toBe("You sent me 2 files:\n\n- notes.txt, 5 bytes\n- photo-of-the-tap.png, 2,048 bytes");
  });
});

test.describe("the seeded world", () => {
  test.use({ world: "seeded" });

  test("has Tester's agents, each in the state it is there for", async ({ server }) => {
    const all = await agents(server);
    const named = (name: string) => all.find((agent) => agent.name === name)!;
    expect(all.map((agent) => agent.name).sort()).toEqual(["Archive", "Atlas", "Ledger", "Patch", "Pip", "Planner", "Scout", "Tidy", "🏡 Home renovation & garden project coordinator 🌱"].sort());
    expect(new Set(all.map((agent) => agent.avatar_id)).size).toBeGreaterThanOrEqual(7);
    expect(new Set(all.map((agent) => agent.model)).size).toBeGreaterThanOrEqual(5);
    expect(named("Ledger")).toMatchObject({ unread: 2, muted: false, color: "#B4532A" });
    expect(named("Scout")).toMatchObject({ unread: 2, muted: true });
    expect(named("Archive")).toMatchObject({ hidden: true });
    expect(named("Patch").latest).toMatchObject({ sender: "sidebots", status: "failed" });
    expect(named("Pip").latest).toBeNull();
    expect(named("Atlas").unread).toBe(0);
    const tidy = await waitingAsk(server, named("Tidy").id);
    expect(tidy.question!.kind).toBe("command");
    expect((await agents(server)).find((agent) => agent.name === "Tidy")!.working).toBe(true);

    const planner = await json<About>(server, `/agents/${named("Planner").id}/about`);
    expect(planner.jobs.map((job) => job.schedule.type).sort()).toEqual(["daily", "every", "once"]);
    expect(planner.memories.map((memory) => memory.name).sort()).toEqual(["Commute", "Family", "Morning brief", "Work hours"]);
    expect(planner.instructions).toContain("You look after the week ahead");
  });

  test("gives Atlas a long chat with every kind of message, over several days", async ({ server }) => {
    const atlas = (await agents(server)).find((agent) => agent.name === "Atlas")!;
    // The chat in pages, as the phone reads it, oldest first.
    let page = await chat(server, atlas.id);
    let messages = page;
    while (page.length === 50) {
      page = await json<Message[]>(server, `/agents/${atlas.id}/messages?before=${page[0].id}`);
      messages = [...page, ...messages];
    }
    expect(messages.length).toBeGreaterThanOrEqual(130);
    expect(messages.map((message) => message.created_at)).toEqual([...messages.map((message) => message.created_at)].sort((a, b) => a - b));
    const days = new Set(messages.map((message) => new Date(message.created_at).toDateString()));
    expect(days.size).toBeGreaterThanOrEqual(6);
    expect(days.has(new Date().toDateString())).toBe(true);
    expect(days.has(new Date(Date.now() - 24 * 60 * 60_000).toDateString())).toBe(true);

    const ends = (path: string) => path.split(".").pop();
    const sent = messages.filter((message) => message.attachments.length);
    expect(sent.some((message) => message.sender === "person" && ends(message.attachments[0]) === "png")).toBe(true);
    expect(sent.some((message) => message.sender === "agent" && message.attachments.length === 1 && ends(message.attachments[0]) === "png")).toBe(true);
    expect(sent.some((message) => message.attachments.filter((path) => ends(path) === "png").length >= 3)).toBe(true);
    for (const kind of ["html", "pdf", "csv", "zip", "txt"]) expect(sent.some((message) => message.attachments.some((path) => ends(path) === kind))).toBe(true);
    expect(messages.some((message) => /^## |\*\*|^- /m.test(message.body) && message.sender === "agent")).toBe(true);
    expect(messages.some((message) => message.reply_to && message.peer_id === null)).toBe(true);
    expect(messages.some((message) => message.sender === "person" && message.status === "failed")).toBe(true);
    expect(messages.some((message) => message.sender === "sidebots" && message.status === "failed")).toBe(true);
    expect(messages.filter((message) => message.sender === "sidebots" && message.status === "done").map((message) => message.body)).toEqual(["Stopped", "Fresh start", "Switched from Claude Sonnet 5.5 to Claude Opus 5.5"]);
    expect(new Set(messages.filter((message) => message.ask).map((message) => message.ask))).toEqual(new Set(["allowed", "refused", "unanswered"]));
    expect(messages.some((message) => message.question?.kind === "connection")).toBe(true);
    const asked = messages.filter((message) => message.agent_id === atlas.id && message.peer_id && !message.ask);
    expect(asked.map((message) => message.status).sort()).toEqual(["done", "failed"]);
    expect(messages.some((message) => message.reply_to === asked.find((each) => each.status === "done")!.id)).toBe(true);
  });

  test("has a week of usage, the plan's limits, a connection and a phone", async ({ server }) => {
    const usage = await json<Usage>(server, "/usage");
    expect(new Set(usage.used.map((used) => used.agent_id)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(usage.used.map((used) => used.kind))).toEqual(new Set(["reply", "job", "memory"]));
    expect(usage.days).toHaveLength(7);
    expect(usage.days.every((day) => day.cost > 0)).toBe(true);
    const claude = usage.accounts.find((account) => account.provider === "claude")!;
    expect(claude.apiKey).toBe(false);
    expect(claude.limits.some((limit) => limit.used! > 0.9 && limit.used! < 1)).toBe(true);
    expect(claude.limits.some((limit) => limit.used! > 1)).toBe(true);
    expect(usage.accounts.find((account) => account.provider === "codex")).toMatchObject({ apiKey: true, limits: [] });

    const connections = await json<Connected[]>(server, "/connections");
    expect(Object.fromEntries(connections.map((each) => [each.connection, each.account]))).toEqual({ gmail: "tester@example.com", calendar: null, notion: null });
    const devices = JSON.parse(await server.cli("devices", "--json")) as { name: string; kind: string }[];
    expect(devices).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Tester's iPhone", kind: "phone" })]));
  });
});

test.describe("the test controls", () => {
  test("hold keeps an agent working until released", async ({ server }) => {
    const atlas = await newAgent(server, "Atlas");
    const held = await server.control<Message>("hold", { agent: "Atlas" });
    await until(() => chat(server, atlas.id), (messages) => messages.find((message) => message.id === held.id)!.seen_at !== null);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect((await agents(server))[0].working).toBe(true);
    expect((await chat(server, atlas.id, held.id)).length).toBe(0);
    expect(await server.control("release", { agent: atlas.id })).toEqual({ released: true });
    await until(() => chat(server, atlas.id, held.id), (messages) => messages.some(isReply));
    await until(() => agents(server), (all) => !all[0].working);
  });

  test("ask raises an ask, on a message or on a job's run", async ({ server }) => {
    const atlas = await newAgent(server, "Atlas");
    const ask = await waitingAsk(server, atlas.id, (await server.control<Message>("ask", { agent: "Atlas", kind: "file" })).id);
    expect(ask.question!.kind).toBe("file");
    await answerAsk(server, atlas.id, ask, true);
    await until(() => agents(server), (all) => !all[0].working);
    const before = (await chat(server, atlas.id)).at(-1)!.id;
    await server.control("ask", { agent: "Atlas", kind: "page", job: true });
    const fromJob = await waitingAsk(server, atlas.id, before);
    expect(fromJob.job_id).not.toBeNull();
    expect(fromJob.question!.kind).toBe("page");
  });

  test("deliver sends a message from the agent by itself, and run-job runs a job", async ({ server }) => {
    const atlas = await newAgent(server, "Atlas");
    const delivered = await server.control<Message>("deliver", { agent: "Atlas", text: "The parcel has arrived.", files: ["image"] });
    expect(delivered).toMatchObject({ sender: "agent", body: "The parcel has arrived.", status: "done" });
    expect(delivered.attachments).toHaveLength(1);
    expect((await agents(server))[0].unread).toBe(1);

    await exchange(server, atlas.id, "/job");
    const before = (await chat(server, atlas.id)).at(-1)!.id;
    await server.control("run-job", { agent: atlas.id });
    const ran = await until(() => chat(server, atlas.id, before), (messages) => messages.some((message) => message.job_id !== null));
    expect(ran.find((message) => message.job_id)!.body).toBe("Rain from about 8 tomorrow morning, so take an umbrella.");
  });

  test("agents adds an agent as another device does, which the event stream tells", async ({ server }) => {
    const events = await stream(server);
    const added = await server.control<{ id: string }>("agents", { name: "From the phone", avatar: "skye", provider: "codex" });
    await until(async () => events.events, (all) => all.some((each) => each.event === "agent" && each.data.includes(added.id)));
    expect((await agents(server)).map((agent) => agent.name)).toEqual(["From the phone"]);
    await events.close();
  });

  test("outage, drop-events and contract put the server out of reach and on other versions", async ({ server }) => {
    // The phone pairs before the server goes out of reach.
    expect((await server.api("/agents")).status).toBe(200);
    await server.control("outage", { ms: 60_000 });
    const refused = await server.api("/agents");
    expect(refused.status).toBe(503);
    expect(refused.headers.get("Sidebots-Contract")).toBe(String(CONTRACT_VERSION));
    await server.control("outage", { ms: 0 });
    expect((await server.api("/agents")).status).toBe(200);

    const events = await stream(server);
    expect(events.status).toBe(200);
    await server.control("drop-events", { ms: 60_000 });
    await events.ended;
    expect((await server.api("/events")).status).toBe(503);
    await server.control("drop-events", { ms: 0 });
    const again = await stream(server);
    expect(again.status).toBe(200);
    await again.close();

    for (const [version, header] of [["older", CONTRACT_VERSION - 1], ["newer", CONTRACT_VERSION + 1], [null, CONTRACT_VERSION]] as const) {
      await server.control("contract", { version });
      expect((await server.api("/agents")).headers.get("Sidebots-Contract")).toBe(String(header));
    }
  });

  test("the server's own commands work against the home and the port, and address takes the phones' address away", async ({ server }) => {
    const status = JSON.parse(await server.cli("status", "--json")) as { running: boolean; address: string | null; people: { name: string; accounts: { provider: string; sign_in: string }[] }[] };
    expect(status).toMatchObject({ running: true, address: `127.0.0.1:${server.port}` });
    expect(status.people).toEqual([{ name: "Tester", accounts: [expect.objectContaining({ provider: "claude", sign_in: "login" }), expect.objectContaining({ provider: "codex", sign_in: "api-key" })] }]);
    expect(JSON.parse(await server.cli("pair", "Tester", "--json")).link).toContain(`host=127.0.0.1%3A${server.port}`);
    await server.control("address", { address: null });
    expect(JSON.parse(await server.cli("status", "--json")).address).toBeNull();
    await server.restart();
    expect(JSON.parse(await server.cli("status", "--json")).running).toBe(true);
  });
});

test.describe("a server with nobody set up", () => {
  test.use({ world: "nobody" });

  test("lists nobody", async ({ server }) => {
    expect(JSON.parse(await server.cli("status", "--json"))).toMatchObject({ running: true, people: [] });
  });
});
