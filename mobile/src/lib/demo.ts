// A computer inside the app, for Apple's review. The reviewer has no computer
// of ours to pair with, so their phone pairs with this one: it answers the
// calls the app makes to a paired computer, with made-up agents whose replies
// are written here. Nothing it is sent leaves the phone, and it starts over
// when the app does. A phone reaches it only through a pairing link whose
// host is `DEMO_HOST`, which the review notes give. Nothing in the app leads
// to it.

import { Image } from "react-native";
import {
  CONTRACT_HEADER,
  CONTRACT_VERSION,
  type About,
  type Agent,
  type AgentWithLatest,
  type Avatar,
  type Found,
  type Message,
  type Paired,
  type Schedule,
  type Sender,
  type Status,
  type StreamEvent,
  type Usage,
} from "@server/contract";

/** The host of the demo computer in a pairing link. No computer on a network answers to it. */
export const DEMO_HOST = "demo";
const ORIGIN = `https://${DEMO_HOST}`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// How long an agent takes to read a message, and then to reply.
const READS_MS = 700;
const REPLIES_MS = 2800;

// The starter avatars, which a computer serves from its own folder.
const SHEETS: Record<string, number> = {
  cog: require("../../../avatars/cog/spritesheet.png"),
  ember: require("../../../avatars/ember/spritesheet.png"),
  hop: require("../../../avatars/hop/spritesheet.png"),
  mochi: require("../../../avatars/mochi/spritesheet.png"),
  morel: require("../../../avatars/morel/spritesheet.png"),
  moss: require("../../../avatars/moss/spritesheet.png"),
  skye: require("../../../avatars/skye/spritesheet.png"),
  wisp: require("../../../avatars/wisp/spritesheet.png"),
};
const AVATARS: Avatar[] = (
  [
    ["cog", "Cog", "A boxy gold robot with a red antenna light.", "#9B6D0A"],
    ["ember", "Ember", "A warm orange drop with rosy cheeks.", "#D14200"],
    ["hop", "Hop", "A lime frog with eyes on top and a wide grin.", "#59812B"],
    ["mochi", "Mochi", "A round pink slime with a little yellow bow.", "#E31775"],
    ["morel", "Morel", "A small mushroom with a spotted red cap.", "#946D1E"],
    ["moss", "Moss", "A green cat with pointed ears and pink cheeks.", "#26855E"],
    ["skye", "Skye", "A chubby blue bird with an orange beak and a tuft on top.", "#286BF5"],
    ["wisp", "Wisp", "A friendly purple ghost with a wavy hem.", "#845CE5"],
  ] as const
).map(([id, displayName, description, color]) => ({ id, displayName, description, spritesheetPath: "spritesheet.png", color }));

/** Where an avatar's spritesheet is on the phone, in the app's own files. */
export function demoSheet(avatarId: string): string {
  return Image.resolveAssetSource(SHEETS[avatarId] ?? SHEETS.moss)?.uri ?? "";
}

/** An agent as it is made up: its page, and its chat so far as who said what and how long ago. */
type Cast = {
  name: string;
  avatar: string;
  instructions: string;
  memories?: About["memories"];
  jobs?: [what: string, schedule: Schedule][];
  chat: [sender: Sender, body: string, ago: number][];
};
const CAST: Cast[] = [
  {
    name: "Scout",
    avatar: "moss",
    instructions: "You find things for Alex: flats, flights, a table for Friday. Compare what is on offer, and text Alex only the ones worth a look.",
    memories: [{ name: "The flat Alex wants", description: "What Alex and Sam need in a flat", body: "Brunswick or close to it. Under $650 a week. Two bedrooms. A garden is a bonus." }],
    chat: [
      ["person", "Find me a flat in Brunswick under $650 a week. A garden would be nice.", 55 * MINUTE],
      ["agent", "Found three. The one on Albert St has a garden and a second bedroom for $620. Want me to book an inspection for Saturday?", 12 * MINUTE],
    ],
  },
  {
    name: "Wedding",
    avatar: "skye",
    instructions: "You help Alex and Sam plan their wedding. Keep track of the vendors, what each has quoted and what still waits on an answer.",
    chat: [
      ["person", "Has the photographer come back yet?", 2 * HOUR],
      ["agent", "The photographer sent her quote. $3,400 for the day, travel included.", 105 * MINUTE],
    ],
  },
  {
    name: "Morning brief",
    avatar: "cog",
    instructions: "You brief Alex every morning at 8, in two or three short sentences: the weather, what is on today, and anything urgent.",
    jobs: [
      ["Weather, today's calendar, and anything urgent in the wedding inbox.", { type: "daily", time: "08:00" }],
      ["Check the Sydney to Melbourne fare for 4 December. Stay silent unless it is under $900.", { type: "every", minutes: 60 }],
    ],
    chat: [["agent", "17° and clear. Cake tasting at 11, and the celebrant wants a call back.", 4 * HOUR]],
  },
  {
    name: "Budget",
    avatar: "mochi",
    instructions: "You keep Alex and Sam's weekly budget. Say where the week stands in one line, and name the biggest category.",
    chat: [
      ["person", "How did we do this week?", 26 * HOUR + MINUTE],
      ["agent", "$1,140 this week, $90 under. Groceries were the big one.", 26 * HOUR],
    ],
  },
];
// What every agent here replies, in turn. None of them does any work.
const REPLIES = [
  "This is the demo computer, so I can't do real work. On your own computer I'd do what you asked, and text you back when it was done.",
  "Still the demo. Your message reached me as it would reach an agent on your Mac, and this reply came back the same way.",
];
// What the agents used on each of the last seven days, the oldest first, in US dollars.
const DAYS = [1.5, 1.8, 1.7, 1.3, 3.5, 2.4, 1.8];
const TOKENS_A_DOLLAR = 600_000;

let agents: Agent[] = [];
let chats: Record<string, Message[]> = {};
let abouts: Record<string, About> = {};
const working = new Set<string>();
// The phone's event stream, while it listens.
const hearing = new Set<(event: StreamEvent) => void>();
let made = 0;
// How many messages the person has sent.
let taken = 0;

/** When a job next runs: a daily one at its time of day, another its minutes from now. */
function nextRun(schedule: Schedule, now: number): number {
  if (schedule.type === "once") return schedule.at;
  if (schedule.type === "every") return now + schedule.minutes * MINUTE;
  const [hours, minutes] = schedule.time.split(":").map(Number);
  const today = new Date(now).setHours(hours, minutes, 0, 0);
  return today > now ? today : today + DAY;
}

function message(agentId: string, sender: Sender, body: string, at: number, status: Status = "done"): Message {
  return {
    id: `demo-${++made}`,
    agent_id: agentId,
    sender,
    body,
    attachments: [],
    status,
    seen_at: sender === "person" && status === "done" ? at : null,
    reply_to: null,
    job_id: null,
    interim: false,
    ask: null,
    question: null,
    peer_id: null,
    created_at: at,
  };
}

function addAgent(name: string, avatarId: string, at: number): Agent {
  const agent: Agent = {
    id: `demo-agent-${++made}`,
    person_id: "demo",
    name,
    avatar_id: avatarId,
    provider: "claude",
    model: "opus",
    effort: "medium",
    muted: false,
    hidden: false,
    color: null,
    session_id: null,
    read_at: at,
    created_at: at,
  };
  agents.push(agent);
  chats[agent.id] = [];
  abouts[agent.id] = { instructions: `# ${name}\n\nYou are ${name}, one of Alex's agents.`, memories: [], jobs: [] };
  return agent;
}

/** Sets the computer up as new: the cast, with their chats ending a while ago. */
function start(): void {
  const now = Date.now();
  agents = [];
  chats = {};
  abouts = {};
  working.clear();
  made = 0;
  taken = 0;
  for (const { name, avatar, instructions, memories = [], jobs = [], chat } of CAST) {
    const agent = addAgent(name, avatar, now);
    chats[agent.id] = chat.map(([sender, body, ago]) => message(agent.id, sender, body, now - ago));
    abouts[agent.id] = {
      instructions: `# ${name}\n\n${instructions}`,
      memories,
      jobs: jobs.map(([what, schedule], index) => ({ id: `job-${index}`, agent_id: agent.id, what, schedule, next_at: nextRun(schedule, now), created_at: now - 9 * DAY })),
    };
  }
}
start();

function shown(agent: Agent): AgentWithLatest {
  const chat = chats[agent.id];
  return {
    ...agent,
    latest: chat.at(-1) ?? null,
    working: working.has(agent.id),
    unread: chat.filter((each) => each.sender === "agent" && each.created_at > agent.read_at).length,
    waiting_on: null,
  };
}

function tell(agent: Agent, said: Message | null): void {
  hearing.forEach((hear) => hear({ message: said, agent: shown(agent) }));
}

/** Takes a message from the person, which its agent reads and then replies to. */
function take(agent: Agent, body: string): Message {
  const sent = message(agent.id, "person", body, Date.now(), "queued");
  const reply = REPLIES[taken++ % REPLIES.length];
  chats[agent.id].push(sent);
  working.add(agent.id);
  tell(agent, sent);
  // An agent deleted meanwhile, or one of a computer since set up as new, says nothing.
  const still = () => agents.includes(agent);
  setTimeout(() => {
    if (!still()) return;
    Object.assign(sent, { status: "running", seen_at: Date.now() });
    tell(agent, sent);
  }, READS_MS);
  setTimeout(() => {
    if (!still()) return;
    sent.status = "done";
    working.delete(agent.id);
    tell(agent, sent);
    const replied = message(agent.id, "agent", reply, Date.now());
    chats[agent.id].push(replied);
    tell(agent, replied);
  }, REPLIES_MS);
  return sent;
}

function usage(): Usage {
  const now = new Date();
  const two = (value: number) => String(value).padStart(2, "0");
  const days = DAYS.map((cost, index) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (DAYS.length - 1 - index));
    return { day: `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`, cost, tokens: cost * TOKENS_A_DOLLAR };
  });
  const total = DAYS.reduce((sum, cost) => sum + cost, 0);
  // The cast share what the days used, the first of them most.
  const shares = [0.45, 0.28, 0.15, 0.12];
  const used = agents.slice(0, shares.length).map((agent, index) => {
    const cost = Math.round(total * shares[index] * 100) / 100;
    return { agent_id: agent.id, kind: abouts[agent.id].jobs.length ? ("job" as const) : ("reply" as const), turns: 7, cost, tokens: cost * TOKENS_A_DOLLAR };
  });
  const limits = [
    { name: "5-hour limit", used: 0.32, resets_at: now.getTime() + 3 * HOUR, at: now.getTime() },
    { name: "Weekly limit", used: 0.41, resets_at: now.getTime() + 4 * DAY, at: now.getTime() },
  ];
  return { used, days, accounts: [{ provider: "claude", apiKey: false, limits }] };
}

function found(text: string): Found[] {
  const wanted = text.toLowerCase();
  return agents
    .flatMap((agent) => chats[agent.id].map((each) => ({ id: each.id, agent_id: agent.id, agent: agent.name, sender: each.sender, body: each.body, created_at: each.created_at })))
    .filter((each) => each.body.toLowerCase().includes(wanted))
    .sort((a, b) => b.created_at - a.created_at);
}

const answer = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { [CONTRACT_HEADER]: String(CONTRACT_VERSION) } });
const refuse = () => answer({ error: "The demo computer doesn't do that." }, 400);

/** The event stream: what the computer says as it happens, until the phone stops listening. */
function events(signal: AbortSignal | undefined): Response {
  const said: string[] = [];
  let wake = () => {};
  const hear = (event: StreamEvent) => {
    said.push(`data: ${JSON.stringify(event)}\n\n`);
    wake();
  };
  hearing.add(hear);
  signal?.addEventListener("abort", () => {
    hearing.delete(hear);
    wake();
  });
  const encoder = new TextEncoder();
  const read = async () => {
    while (said.length === 0) {
      if (signal?.aborted) throw new Error("The phone stopped listening.");
      await new Promise<void>((resolve) => (wake = resolve));
    }
    return { done: false, value: encoder.encode(said.shift()) };
  };
  // The parts of a streamed answer that the app reads.
  const stream = { status: 200, ok: true, headers: new Headers({ [CONTRACT_HEADER]: String(CONTRACT_VERSION) }), body: { getReader: () => ({ read }), cancel: async () => void hearing.delete(hear) } };
  return stream as unknown as Response;
}

/** Whether an address is the demo computer's. */
export function isDemo(url: string): boolean {
  return url.startsWith(`${ORIGIN}/`);
}

/** Answers a call to the demo computer, as a computer the phone has paired with answers it. */
export async function demoFetch(url: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
  const { pathname, searchParams } = new URL(url);
  const [, agentId, rest = ""] = /^\/agents\/([^/]+)(\/.*)?$/.exec(pathname) ?? [];
  const agent = agents.find((each) => each.id === agentId);
  if (agentId && !agent) return answer({ error: "That agent is gone." }, 404);
  const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, never>) : init.body;
  switch (`${init.method ?? "GET"} ${agent ? `/agents/:id${rest.replace(/^\/jobs\/.+/, "/jobs/:job")}` : pathname}`) {
    case "POST /pair": {
      start();
      // The phone keeps a notification key for every computer. This one sends no notifications.
      const paired: Paired = { key: "demo", notificationKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", machine: "Demo computer" };
      return answer(paired, 201);
    }
    case "GET /events":
      return events(init.signal);
    case "GET /agents":
      return answer(agents.map(shown));
    case "GET /avatars":
      return answer(AVATARS);
    case "GET /usage":
      return answer(usage());
    case "GET /search":
      return answer(found(searchParams.get("text") ?? ""));
    case "PUT /push-token":
    case "DELETE /device":
      return answer({});
    case "POST /agents": {
      const { name, avatarId } = body as { name: string; avatarId: string };
      const added = addAgent(name, avatarId, Date.now());
      tell(added, null);
      return answer(added, 201);
    }
    case "GET /agents/:id/messages":
      // A chat here is shorter than a page, so nothing comes before it.
      return answer(searchParams.has("before") ? [] : chats[agent!.id]);
    case "POST /agents/:id/messages":
      return answer(take(agent!, String((body as FormData).getAll("body")[0] ?? "")), 201);
    case "POST /agents/:id/read":
      agent!.read_at = Date.now();
      return answer(shown(agent!));
    case "GET /agents/:id/about":
      return answer(abouts[agent!.id]);
    case "PATCH /agents/:id": {
      const { avatarId, ...changes } = body as Partial<Agent> & { avatarId?: string };
      Object.assign(agent!, changes, avatarId ? { avatar_id: avatarId } : {});
      return answer(shown(agent!));
    }
    case "DELETE /agents/:id":
      agents = agents.filter((each) => each !== agent);
      hearing.forEach((hear) => hear({ deleted: agent!.id }));
      return answer({});
    case "DELETE /agents/:id/jobs/:job":
      abouts[agent!.id].jobs = abouts[agent!.id].jobs.filter((job) => `/jobs/${job.id}` !== rest);
      return answer({});
    default:
      return refuse();
  }
}
