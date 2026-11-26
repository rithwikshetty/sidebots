// The scripted provider: what the harness's agents do in place of Claude Code
// and Codex. It reads the person's message and acts it out through the turn
// Sidebots' runner hands every provider, so each message, ask, file and
// exchange in the chat is made by the server's own code. The commands it
// understands are listed in e2e/server.ts.

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { claude, question as claudeQuestion } from "../../../server/src/claude.ts";
import { codex, question as codexQuestion } from "../../../server/src/codex.ts";
import { CONNECTIONS, type Connection, type Limit, type Message, type Provider, type Question } from "../../../server/src/contract.ts";
import { toolQuestion, type Answer, type Driver, type Drivers, type Offer, type Prompt, type RunTurn, type Turn } from "../../../server/src/runner.ts";
import type { Store } from "../../../server/src/store.ts";
import { PAGES, budget, invoice, packingList, picture, tickets, type Made } from "./files.ts";

/** What the script asks of the person, by the word that names it. */
export type AskKind = "command" | "file" | "page" | "tool";
export const ASK_KINDS: AskKind[] = ["command", "file", "page", "tool"];

/**
 * What a test control has an agent do on its next turn, in place of what its
 * message says: hold until released, or raise an ask.
 */
export type Action = { hold: Promise<void> } | { ask: AskKind };

/**
 * The queue's clock. The runner allows an update only a minute into a turn,
 * and then one every few minutes, so for the moment an update is sent the
 * clock reads a few minutes later than it is, a little more each time.
 * Everything else reads the real time.
 */
export function createClock() {
  let ahead = 0;
  let updating = false;
  return {
    now: () => Date.now() + (updating ? ahead : 0),
    /** Runs `send` with the clock far enough ahead that the runner takes the update. */
    later<T>(send: () => T): T {
      ahead += 4 * 60_000;
      updating = true;
      try {
        return send();
      } finally {
        updating = false;
      }
    },
  };
}
export type Clock = ReturnType<typeof createClock>;

/** What another agent is sent by `/agent-ask`, which has it ask the person before it acts. */
export const TIDY_REQUEST = "Could you clear out the old invoices folder in Downloads? The tax return is filed, so nothing in it is needed any more.";

/** The work `/suggest` offers the person, the one that matters most first. */
export const SUGGESTIONS: Offer[] = [
  { title: "Book the plumber for Thursday", why: "Hughes & Son have a slot on Thursday morning.", what: "Book Hughes & Son for Thursday morning to fix the dripping kitchen tap, and add it to the calendar." },
  { title: "Compare home insurance quotes", why: "The home insurance renews on Friday at £40 more.", what: "Get three quotes for the same cover as the current home insurance, and set out the price and excess of each." },
  { title: "Move the dentist to next week", why: "The dentist at 2 clashes with the school pick-up.", what: "Ask the dentist's surgery for a slot next week after 4, and move the appointment once they confirm." },
];

/** Thrown inside a turn once it is stopped, so it ends at once with no reply. */
const STOPPED = Symbol("stopped");

/** Waits `ms`, and throws STOPPED when the turn is stopped first. */
function waiter(stop: AbortSignal) {
  return async (ms: number) => {
    await new Promise<void>((resolve) => {
      if (stop.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        stop.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      stop.addEventListener("abort", done);
    });
    if (stop.aborted) throw STOPPED;
  };
}

/** A number picked from the text, the same every time, for choosing among replies. */
const pick = (words: string, count: number) => [...words].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7) % count;

/** A short friendly reply to a plain message, as a capable person texts. */
function friendly(words: string, person: string): string {
  const said = words.toLowerCase();
  if (/^(hi|hey|hello|morning|good morning)\b/.test(said)) return `Hi ${person}! What can I help with today?`;
  if (/\b(thanks|thank you|cheers)\b/.test(said)) return "Any time.";
  if (/\b(budget|spend|spent|money|cost|afford)\b/.test(said)) return "I've had a look. You're about £140 under budget for the month so far, mostly thanks to fewer takeaways.";
  if (/\b(flight|flights|trip|travel|hotel|train)\b/.test(said)) return "Found a couple of options. The 08:40 is cheapest at £96 return, and the 17:15 gets you in for dinner. Want me to hold one?";
  if (/\b(remind|reminder)\b/.test(said)) return "Okay, I'll remind you.";
  if (/\b(code|bug|test|tests|error|deploy)\b/.test(said)) return "Found it: the date was read as UTC, so anything after 11pm landed on the next day. I've fixed it and the tests pass.";
  if (/\b(weather|rain|umbrella)\b/.test(said)) return "Dry and bright tomorrow, 14° at midday. Showers move in on Sunday afternoon.";
  return [
    "Got it. I've made a note of that.",
    "Sure, that's done.",
    "Okay! I'll keep that in mind.",
    "Done. Anything else?",
    "Good idea. I've added it to the list.",
    `On it, ${person}. I'll let you know how it goes.`,
  ][pick(words, 6)];
}

/** What an agent answers when another agent asks it something. */
function peerAnswer(words: string): string {
  const said = words.toLowerCase();
  if (/\b(budget|afford|spend|money|left)\b/.test(said)) return "There's £410 left in Home for November, so that fits with £70 to spare. December is already tight because of the flights.";
  if (/\b(train|flight|travel|trip)\b/.test(said)) return "The 09:12 from Paddington gets in at 10:41, and there's a 17:30 back. Off-peak returns are £38 if booked by Thursday.";
  if (/\b(calendar|free|busy|when)\b/.test(said)) return "Saturday morning is free. The afternoon has the dentist at 2 and nothing after 4.";
  return "Here's what I have: nothing on that yet, but I've noted it and will pick it up if it comes up again.";
}

/** The long reply `/long` sends, with every kind of markdown the chat draws. */
const LONG = `## Moving the budget off the spreadsheet

Here's the plan for turning the **monthly budget** into a small script, so it updates *by itself* each time a statement comes in.

### What it does

1. Reads the bank's CSV export from \`~/Downloads\`
2. Sorts each line into a category
   - groceries, home, transport
   - anything it can't place goes to *Other* for you to check
3. Writes the totals to \`budget.json\` and sends you the month so far

### Where things stand

| Category | Budget | Spent | Left |
| --- | ---: | ---: | ---: |
| Groceries | £380 | £241.60 | £138.40 |
| Home | £450 | £376.40 | £73.60 |
| Eating out | £150 | £162.35 | **−£12.35** |

### The parts

The categories live in one small TypeScript file:

\`\`\`ts
type Rule = { match: RegExp; category: string };

export const RULES: Rule[] = [
  { match: /tesco|sainsbury|lidl/i, category: "Groceries" },
  { match: /tfl|trainline/i, category: "Transport" },
];
\`\`\`

The statement is read with a few lines of Python:

\`\`\`python
import csv

with open("statement.csv") as f:
    rows = [row for row in csv.DictReader(f) if float(row["Amount"]) < 0]
print(f"{len(rows)} payments this month")
\`\`\`

And it runs each morning from a one-line cron entry:

\`\`\`bash
0 7 * * * cd ~/budget && node update.ts >> update.log 2>&1
\`\`\`

> Eating out is the one to watch: it went over by £12 last month too.

The bank's export format is described [on their help page](https://www.example.com/help/exports). Say the word and I'll set it up, or ~~wait until January~~ start with this month.`;

/** The words a provider fails with, as its own program puts them, for `/fail`. */
function failureWords(provider: Provider, kind: string): string {
  const resets = new Date(Date.now() + 2 * 60 * 60_000);
  const hour = resets.getHours() % 12 || 12;
  const half = resets.getHours() < 12 ? "am" : "pm";
  const at = `${hour}:${String(resets.getMinutes()).padStart(2, "0")} ${half.toUpperCase()}`;
  if (provider === "claude") {
    if (kind === "signed-out") return "Not logged in · Please run /login";
    if (kind === "key") return "Invalid API key · Fix external API key";
    if (kind === "overloaded") return 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    return `Claude AI usage limit reached · You've hit your limit · resets ${hour}${half} (Europe/London)`;
  }
  if (kind === "signed-out") return "Not logged in";
  if (kind === "key") return "Incorrect API key provided: sk-proj-****. You can find your API key at https://platform.openai.com/account/api-keys.";
  if (kind === "overloaded") return "stream disconnected before completion: Our servers are currently overloaded. Please try again later.";
  return `You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at ${at}.`;
}

/** What the agent asks the person before it acts, as its provider's driver would word it. */
export function askFor(kind: AskKind, provider: Provider, home: string): Question {
  if (kind === "command") {
    const command = "find ~/Downloads/Invoices -name '*.pdf' -mtime +365 -delete";
    return provider === "claude"
      ? claudeQuestion("Bash", { command, description: "Delete invoices older than a year from Downloads" }, undefined, "Deletes files outside the agent's folder")
      : codexQuestion({ command, cwd: home, reason: "Deletes files outside the workspace" });
  }
  if (kind === "file") {
    const path = join(homedir(), "Documents", "Taxes", "2026 return notes.md");
    const content = "# 2026 return\n\n- Filed 18 November\n- Refund due: £212\n- Keep receipts until 2032\n";
    return provider === "claude"
      ? claudeQuestion("Write", { file_path: path, content }, undefined, "Writes a file outside the agent's folder")
      : codexQuestion({ changes: [{ path, kind: { type: "add" }, diff: content.split("\n").map((line) => `+${line}`).join("\n") }], reason: "Writes outside the workspace" });
  }
  if (kind === "page") {
    return claudeQuestion("WebFetch", { url: "https://www.lambeth.gov.uk/bins-recycling/collection-days", prompt: "When are the bins collected over Christmas?" }, undefined, "Fetches a page from a site not yet allowed");
  }
  return { ...toolQuestion("Gmail", "send_email", { to: "bookings@hughesandson.co.uk", subject: "Dripping kitchen tap", body: "Hi, could you come and look at a dripping kitchen tap this week? Any morning works." }), why: "Sends an email as you" };
}

/** What the agent says once the person has answered an ask, from the words the runner gave it. */
function afterAsk(kind: AskKind, answer: Answer): string {
  const done = { command: "cleared out 14 invoices older than a year", file: "saved the notes to Documents/Taxes", page: "checked the council's page: bins go out on the 27th instead of the 25th", tool: "emailed Hughes & Son about the tap" }[kind];
  if (answer.allowed) return `You said yes, so I ${done}.`;
  if (/didn't answer/.test(answer.words)) return "I didn't hear back, so I left that undone. Ask again whenever you're ready.";
  if (/sent a message instead/.test(answer.words)) return "You sent another message, so I left that and read yours.";
  return "You said no, so I left it alone.";
}

/** Where the limits of the person's plan stand at `now`: one comfortable, one nearly used up, one over, and one barely touched. */
export function planLimits(now: number): Limit[] {
  const hours = (count: number) => now + count * 60 * 60_000;
  return [
    { name: "5-hour limit", used: 0.38, resets_at: hours(2.5), at: now },
    { name: "Weekly limit", used: 0.93, resets_at: hours(3 * 24 + 4), at: now },
    { name: "Opus limit", used: 1.06, resets_at: hours(5 * 24 + 1), at: now },
    { name: "Fable limit", used: 0.12, resets_at: hours(6 * 24), at: now },
  ];
}

/** A file's name as the person sent it: the store puts eight letters and a dash before it. */
const sentName = (path: string) => basename(path).replace(/^[0-9a-f]{8}-/, "");

/** The `/help` reply. */
const HELP = `I'm a scripted agent for trying Sidebots. I understand:

- plain text: a short reply
- \`/long\`: a long markdown reply
- \`/slow <seconds>\`: work that long, with an update halfway
- \`/fail [limit|signed-out|key|overloaded]\`: fail as the provider would
- \`/ask command|file|page|tool|twice\`: ask before acting
- \`/connect gmail|calendar|notion\`: ask for a connection
- \`/suggest\`: offer three pieces of work
- \`/page [tall|hostile]\`, \`/image\`, \`/images <n>\`, \`/files\`, \`/mixed\`: send files
- \`/agent <name> <question>\`, \`/agent-ask <name>\`: talk to another agent
- \`/job\`, \`/update\`, \`/silent\`, \`/echo-files\``;

/**
 * The scripted drivers, one for each provider. `pause` is how long a plain
 * reply takes, `actions` holds what the test controls have an agent do on its
 * next turn, and `clock` is the queue's.
 */
export function createScript(store: Store, { pause, actions, clock }: { pause: () => number; actions: Map<string, Action>; clock: Clock }): Drivers {
  /** Writes files into the agent's folder for `send_files`, and answers their paths there. */
  const write = (cwd: string, files: Made[]) => {
    const folder = join(cwd, "made", randomUUID().slice(0, 8));
    mkdirSync(folder, { recursive: true });
    return files.map((file) => {
      writeFileSync(join(folder, file.name), file.bytes);
      return join("made", basename(folder), file.name);
    });
  };

  /**
   * Acts on one message of the turn's and answers the reply, or throws for a
   * turn that fails. `wait` throws once the turn is stopped.
   */
  async function act(turn: Turn, prompt: Prompt, wait: (ms: number) => Promise<void>): Promise<string> {
    const agentId = basename(turn.cwd);
    const agent = store.agent(agentId)!;
    const person = store.person(agent.person_id)!.name;
    const message: Message | undefined = store.message(agentId, prompt.id);
    /** What a test control has this agent do now, which it does once. */
    const takeAction = () => {
      const action = actions.get(agentId);
      actions.delete(agentId);
      return action;
    };

    // A turn with no message of its own: the memory save before a fresh start, or a run of a job.
    if (!message) {
      if (prompt.text.startsWith("This session is about to be replaced")) return "Saved.";
      // The run of work the person started from a suggestion works until it is stopped, so where it stands can be seen.
      const started = /started a piece of work you suggested: "(.*)"\./.exec(prompt.text)?.[1];
      if (started !== undefined) {
        await wait(24 * 60 * 60_000);
        return `Done: ${started}.`;
      }
      await wait(pause());
      const action = takeAction();
      if (action && "hold" in action) {
        await Promise.race([action.hold, wait(24 * 60 * 60_000)]);
        return "SILENT";
      }
      if (action && "ask" in action) return afterAsk(action.ask, await turn.ask(askFor(action.ask, agent.provider, turn.cwd), turn.stop.signal));
      const what = /What you saved for it:\n\n([\s\S]*?)\n\nDo it now\./.exec(prompt.text)?.[1] ?? "";
      if (/umbrella|weather|forecast/i.test(what)) return "Rain from about 8 tomorrow morning, so take an umbrella.";
      if (/parcel|delivery/i.test(what)) return "Your parcel from Habitat is out for delivery, due between 1 and 3 today.";
      return `Reminder: ${what.replace(/^remind \w+ to /i, "").replace(/\.$/, "")}.`;
    }

    await wait(pause() / 3);
    turn.seen([prompt.id]);

    // What another agent said to this one: something it asks, or its answer to what this one asked.
    if (message.peer_id === agentId) {
      const from = store.agent(message.agent_id)!;
      await wait(pause());
      if (message.reply_to) return `Heard back from ${from.name}: ${message.body}`;
      if (message.body === TIDY_REQUEST) {
        const answer = await turn.ask(askFor("command", agent.provider, turn.cwd), turn.stop.signal);
        return answer.allowed ? "Done: I cleared out 14 invoices older than a year." : `${person} didn't want that done, so I left the folder as it was.`;
      }
      return peerAnswer(message.body);
    }

    const action = takeAction();
    if (action && "hold" in action) await Promise.race([action.hold, wait(24 * 60 * 60_000)]);
    if (action && "ask" in action) {
      await wait(pause());
      return afterAsk(action.ask, await turn.ask(askFor(action.ask, agent.provider, turn.cwd), turn.stop.signal));
    }

    const words = message.body.trim();
    const [command = "", ...rest] = words.split(/\s+/);
    const argument = rest.join(" ");
    const send = (files: Made[]) => turn.sendFiles(write(turn.cwd, files));
    if (!command.startsWith("/")) {
      await wait(pause());
      const files = message.attachments.length;
      if (!words) return `Thanks, I've got the ${files === 1 ? "file" : `${files} files`}.`;
      return friendly(words, person);
    }

    switch (command.toLowerCase()) {
      case "/help":
        return HELP;
      case "/long":
        await wait(pause() * 2);
        return LONG;
      case "/slow": {
        const seconds = Math.max(1, Number(argument) || 10);
        await wait((seconds * 1000) / 2);
        if (turn.sendUpdate) clock.later(() => turn.sendUpdate!(`Halfway there. I've read through the statements and I'm sorting the last ${Math.ceil(seconds / 2)} seconds' worth.`));
        await wait((seconds * 1000) / 2);
        return `Done. That took ${seconds} seconds: everything is sorted and filed.`;
      }
      case "/fail":
        await wait(pause());
        throw new Error(failureWords(agent.provider, argument || "limit"));
      case "/ask": {
        if (argument === "twice") {
          await wait(pause());
          const first = await turn.ask(askFor("command", agent.provider, turn.cwd), turn.stop.signal);
          await wait(pause() / 2);
          const second = await turn.ask(askFor("tool", agent.provider, turn.cwd), turn.stop.signal);
          return `${afterAsk("command", first)} Then: ${afterAsk("tool", second).replace(/^./, (letter) => letter.toLowerCase())}`;
        }
        const kind = ASK_KINDS.includes(argument as AskKind) ? (argument as AskKind) : "command";
        await wait(pause());
        return afterAsk(kind, await turn.ask(askFor(kind, agent.provider, turn.cwd), turn.stop.signal));
      }
      case "/connect": {
        const app = argument.toLowerCase() as Connection;
        if (!Object.hasOwn(CONNECTIONS, app)) return `I can connect ${Object.keys(CONNECTIONS).join(", ")}. Which one?`;
        await wait(pause() / 2);
        const said = await turn.connect(app);
        const { name } = CONNECTIONS[app];
        if (/ is connected, as /.test(said)) return `${name} is connected. Ask me again and I'll take a look.`;
        if (/already connected/.test(said)) return `${name} was already connected, so I'm all set.`;
        return `Okay, I won't connect ${name} for now.`;
      }
      case "/suggest":
        await wait(pause());
        for (const offer of SUGGESTIONS) turn.suggest(offer);
        return "Here's your week. Hughes & Son can come on Thursday, the home insurance renews on Friday, and the dentist clashes with the school pick-up.";
      case "/page": {
        await wait(pause());
        if (argument === "hostile") {
          send([PAGES.hostile()]);
          return "Here's an odd page.";
        }
        const tall = argument === "tall";
        send([tall ? PAGES.tall() : PAGES.short()]);
        return tall ? "Here are six flats in Brunswick. The Albert St one has the garden and is closest to the station." : "Here's a plan for the Lisbon weekend. Book Pena Palace soon, it sells out.";
      }
      case "/image":
        await wait(pause());
        send([picture(0)]);
        return "Here's the view from the ferry last night.";
      case "/images": {
        const count = Math.min(12, Math.max(1, Number(argument) || 3));
        await wait(pause());
        send(Array.from({ length: count }, (_, index) => picture(index)));
        return `Here ${count === 1 ? "is one picture" : `are ${count} pictures`} from the trip.`;
      }
      case "/files":
        await wait(pause());
        send([invoice(), budget(), packingList(), tickets()]);
        return "Here's the plumber's invoice, this month's budget, the packing list and the tickets.";
      case "/mixed":
        await wait(pause());
        send([picture(2), PAGES.chart(), budget()]);
        return "Groceries are up £30 on October. The chart and the budget are attached, and here's the stall where most of it went.";
      case "/agent":
      case "/agent-ask": {
        const names = store
          .agentsFor(agent.person_id)
          .filter((each) => each.id !== agent.id)
          .map((each) => each.name);
        const lower = argument.toLowerCase();
        const name = names.filter((each) => lower === each.toLowerCase() || lower.startsWith(`${each.toLowerCase()} `)).sort((a, b) => b.length - a.length)[0];
        if (!name) return names.length ? `I couldn't find an agent called "${argument}". Your others: ${names.join(", ")}.` : "You have no other agents to ask.";
        const asked = command.toLowerCase() === "/agent-ask" ? TIDY_REQUEST : argument.slice(name.length).trim() || `${person} asked me to check in. What are you working on for them this week?`;
        await wait(pause() / 2);
        const said = turn.askAgent(name, asked);
        return said.startsWith("Sent to") ? `I've asked ${name}. I'll tell you what they say.` : said;
      }
      case "/job": {
        await wait(pause());
        const said = turn.scheduleJob({ what: `Look at tomorrow morning's forecast and tell ${person} whether to take an umbrella. Stay silent when it will be dry.`, daily_at: "07:30" });
        return said.startsWith("Saved job") ? "Done. Every morning at 7:30 I'll check the forecast and tell you if you need an umbrella." : said;
      }
      case "/update": {
        const update = (words: string) => turn.sendUpdate && clock.later(() => turn.sendUpdate!(words));
        await wait(pause());
        update("Found 23 flights for the weekend. Checking which ones have bags included.");
        await wait(pause());
        update("Down to four. Now comparing the hotels near each airport.");
        await wait(pause());
        return "The best pair is the 07:05 out and the 18:20 back on TAP, £214 with bags, and Casa do Largo in Alfama at £96 a night.";
      }
      case "/silent":
        await wait(pause());
        return "";
      case "/echo-files": {
        await wait(pause() / 2);
        if (message.attachments.length === 0) return "You didn't send me any files with that message.";
        const lines = message.attachments.map((path) => `- ${sentName(path)}, ${statSync(join(turn.cwd, path)).size.toLocaleString("en")} bytes`);
        return `You sent me ${message.attachments.length === 1 ? "1 file" : `${message.attachments.length} files`}:\n\n${lines.join("\n")}`;
      }
      default:
        await wait(pause());
        return `I don't know ${command}. Send /help to see what I understand.`;
    }
  }

  /**
   * A turn, run as a provider runs one: the first message and any the person
   * sends while it runs, each read and then answered. A stopped turn ends at
   * once and names its session, which the next turn carries on.
   */
  const runTurn: RunTurn = async (turn) => {
    const sessionId = turn.sessionId ?? `scripted-${randomUUID()}`;
    const wait = waiter(turn.stop.signal);
    const inbox: Prompt[] = [turn.prompt];
    const take = () => {
      if (!turn.stop.signal.aborted && turn.followUps) inbox.push(...turn.followUps.take());
    };
    take();
    const stopListening = turn.followUps?.onArrival(take);
    let words = 0;
    try {
      while (inbox.length) {
        const prompt = inbox.shift()!;
        const reply = await act(turn, prompt, wait);
        words += prompt.text.length + reply.length;
        turn.replied(reply, [prompt.id]);
      }
    } catch (failure) {
      if (failure !== STOPPED) throw failure;
    } finally {
      stopListening?.();
    }
    // Made-up but steady numbers for what the turn used, so Usage has something to show.
    const tokens = 2_000 + words * 4;
    return { sessionId, contextTokens: 8_000 + words * 4, cost: turn.spent.cost + tokens * 0.000004, tokens: turn.spent.tokens + tokens };
  };

  const limits: Driver["limits"] = async () => planLimits(Date.now());

  // The real drivers word the failures. Nothing is installed, so nothing is forgotten, and Codex's limits are never asked for, since its login is an API key.
  return {
    claude: { ...claude, runTurn, forget: () => undefined, limits },
    codex: { ...codex, runTurn, forget: () => undefined, limits: async () => null },
  };
}

