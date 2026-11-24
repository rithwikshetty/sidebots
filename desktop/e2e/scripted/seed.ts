// The world `--seed` fills a fresh home with: Tester's agents and a week of
// their chats, jobs, memories, usage and connections. It goes through the
// store's own functions, with the clock set back to when each thing happened,
// so the data is what a week of real use leaves behind. Everything but the
// time is the same on every run.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECTIONS, PROVIDERS, fenced, type Agent, type Ask, type Effort, type Model, type Provider, type Question, type Schedule, type Selection, type Status, type TurnKind } from "../../../server/src/contract.ts";
import { question as claudeQuestion } from "../../../server/src/claude.ts";
import { nextRun, switchedWords } from "../../../server/src/runner.ts";
import type { Extras, Person, Store } from "../../../server/src/store.ts";
import { PAGES, budget, invoice, packingList, picture, tickets, type Made } from "./files.ts";
import { askFor, planLimits, type Action } from "./script.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Runs `run` with the clock reading `time`, so the store dates what it writes then. */
function at<T>(time: number, run: () => T): T {
  const real = Date.now;
  Date.now = () => time;
  try {
    return run();
  } finally {
    Date.now = real;
  }
}

/** An ask in words, as the runner words one: what it is, its facts, the thing itself as code, and the provider's reason. */
function askWords({ title, what, facts, detail, why }: Question): string {
  const lines = facts.map(([label, value]) => `${label}: ${value}`).join("\n");
  return [`${title}: ${what}`, lines, detail.trim() && fenced(detail), why?.trim() && `> ${why.trim()}`].filter(Boolean).join("\n\n");
}

/** A message of the seed's, which a later one can name once it is written. */
type Ref = { id: string };

/** Numbers that look random and are the same every run. */
function numbers(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Short exchanges of the kind a person has with a general agent over a week, used to fill the long chat. */
const EVERYDAY: [string, string][] = [
  ["Did the parcel from Habitat come?", "Yes, it was left with the neighbour at number 12 this afternoon."],
  ["What time is Sam's party on Saturday?", "Starts at 7, at The Crown on Elm Road. You said you'd bring the cake."],
  ["Order the cake then, chocolate, for 12 people", "Ordered from Gail's: chocolate fudge, serves 12, ready to collect Saturday at 4. £38, paid."],
  ["How much is left on the gym membership?", "Four months. It renews on 1 March at £42 a month unless you cancel by 1 February."],
  ["Remind me to cancel it in January", "I'll remind you on 15 January, which leaves two weeks before the deadline."],
  ["What's a good gift for Dad, under £50?", "He mentioned wanting a better coffee grinder. The Hario Skerton is £45 and gets great reviews. Or there's the cricket history book he looked at, £28."],
  ["The grinder. Can you send it to his address?", 'Ordered, arriving Thursday at his place. I added a gift note: "Happy birthday, Dad".'],
  ["Is the car due an MOT?", "Yes, on 9 December. Kwik Fit on the high street has slots next week for £54.85."],
  ["Book Tuesday morning", "Booked for Tuesday at 9:30. It takes about an hour, so you could wait there or walk to the café."],
  ["What's for dinner this week? Something easy", "- **Mon:** pasta with pesto and peas\n- **Tue:** tray-bake chicken thighs and veg\n- **Wed:** leftovers\n- **Thu:** dal with rice\n- **Fri:** pizza night\n\nThe shopping list is 14 items, about £38."],
  ["Add that to the online shop for tomorrow", "Done. Delivery tomorrow between 6 and 7pm, £39.20 with the delivery fee."],
  ["How did the electricity bill compare to last month?", "£87, up from £71. It's the heating coming on; usage went up about 20%."],
  ["Any way to bring that down?", "Two easy ones: the thermostat is at 21°, and 20° saves roughly 10%. And the tariff ends in January, when a fixed deal would be about £9 a month cheaper."],
  ["Set a reminder for the tariff in January", "Done, 5 January. I'll compare the fixed deals then."],
  ["When's the library book due?", "Friday. You can renew it online twice, so I can do that if you haven't finished it."],
  ["Renew it please", "Renewed until 12 December."],
  ["Is it going to rain tomorrow?", "Light showers until about 11, then dry. Take the small umbrella."],
  ["Did Priya reply about dinner?", "Yes: Thursday works for her, and she'd prefer somewhere near King's Cross."],
  ["Find somewhere near King's Cross for 4 on Thursday", "Dishoom has a table at 7:30, and Caravan at 8. Dishoom doesn't take a card deposit, so it's easier to cancel."],
  ["Dishoom at 7:30", "Booked: Dishoom King's Cross, Thursday 7:30, four people. I've sent Priya the details."],
  ["Good night!", "Night! Nothing urgent for tomorrow morning."],
  ["How many steps did I do this week?", "48,200, about 6,900 a day. Wednesday was the big one at 11,400."],
  ["Can you cancel the magazine subscription?", "Cancelled. The last issue arrives on the 28th and there's no further charge."],
  ["What's the wifi password at Mum's?", "It's on the card you photographed in August: `BlueFinch_2291`."],
  ["Thanks!", "Any time."],
  ["What do I need for the passport renewal?", "A digital photo, your current passport number, and £88.50. It takes about three weeks, so it's fine for March."],
  ["Start the application", "Started and saved as a draft. I need a new photo; the one on file is too old for the form."],
  ["I'll take one tonight", "Great. Send it over and I'll finish the form."],
  ["Is the dentist this week or next?", "Next Tuesday at 10:15, at Smile Studio on Park Road."],
  ["Can I move it to the afternoon?", "They have 2:40 or 4:00 the same day. Want me to move it?"],
  ["4 please", "Moved to Tuesday at 4:00. They'll text a reminder the day before."],
  ["How much have we spent on takeaways this month?", "£96 over 5 orders. That's £24 more than this time last month."],
  ["Ok no more takeaways until payday", "Noted. I'll mention it if you start an order before the 28th."],
  ["What's the plan for Saturday?", "Market in the morning, Sam's party at 7. Collect the cake at 4 on the way home."],
  ["Did the council collect the garden waste?", "Not yet. Collection moved to Thursday this week because of the bank holiday."],
  ["Can you find a cheaper phone plan?", "Your plan is £24 for 30GB and you use about 8GB. Smarty has 15GB for £9 on the same network, no contract. That saves £180 a year."],
  ["Switch me over", "I've ordered the Smarty SIM. When it arrives, text PAC to 65075 and the switch takes a day. Your number stays the same."],
  ["What's the bin day this week?", "Thursday, recycling and general waste."],
  ["Any good films on this weekend?", '"The Long Field" is at the Ritzy, Saturday at 6:15, and reviews are great. Or "Night Ferry" starts streaming on Friday if you\'d rather stay in.'],
  ["Book two for the Long Field on Sunday instead", "Booked two seats for Sunday at 5:30, row F. £26."],
  ["Did Alex pay me back for the concert?", 'Yes, £45 arrived on Tuesday with the note "concert + drinks".'],
  ["What's the balance on the joint account?", "£1,842.16 after this morning's direct debits."],
  ["Please top up the Oyster card", "Topped up £30. Auto top-up is still off; want it on?"],
  ["No, leave it off", "Leaving it off."],
  ["What did I say I'd bring to book club?", "Crisps and the good hummus. It's at Jo's on Wednesday at 7."],
  ["Remind me Wednesday at 5", "I'll remind you Wednesday at 5."],
  ["What's the name of that ramen place Tom liked?", "Koya, on Frith Street. He said the cold udon was the best thing he ate all year."],
];

/** The morning briefs Planner's job sent, one a day. */
const BRIEFS = [
  "Good morning! Today:\n- 10:15 dentist, Park Road\n- 13:00 lunch with Sam\n\nWeather: 12°, dry. Due: the library book.",
  "Good morning! Nothing in the calendar until the 15:00 call with the landlord. 9°, showers until 11.",
  "Good morning! Today:\n- 09:30 MOT at Kwik Fit\n- 19:00 book club at Jo's (crisps and hummus)\n\n11°, bright.",
  "Good morning! A quiet one: no meetings. The Habitat parcel is due between 1 and 3. 13°, cloudy.",
  "Good morning! Today:\n- 12:00 haircut\n- 18:30 drinks for Priya's birthday\n\nBin day: recycling. 10°, windy.",
  "Good morning! Today:\n- 08:45 standup\n- 16:00 timesheet due\n\n8°, frost first thing, so leave a few minutes early.",
];

/** Planner's memories, as the files an agent writes in its memory folder. */
const MEMORIES = [
  { file: "work-hours.md", name: "Work hours", description: "When Tester works and doesn't want to be bothered", body: "Works 9 to 5:30, Monday to Friday. Thursdays are from home.\n\nNo messages between 12 and 1 unless something is urgent." },
  { file: "family.md", name: "Family", description: "Birthdays, and who is who", body: "- Mum: Helen, birthday 2 March\n- Dad: Rob, birthday 28 November, likes coffee and cricket\n- Sister: Priya, birthday 14 December, vegetarian" },
  { file: "commute.md", name: "Commute", description: "How Tester gets to the office", body: "The 07:52 from Brixton on the Victoria line, then a ten-minute walk. Takes about 35 minutes door to door.\n\nOn strike days, the 159 bus is the backup." },
  { file: "morning-brief.md", name: "Morning brief", description: "What goes in the morning brief and what to leave out", body: "Five lines at most. Calendar first, then the weather, then anything due.\n\nLeave out work meetings that repeat every day, and the weather when it's the same as yesterday." },
];

const PLANNER_INSTRUCTIONS = `# Planner

You are Planner, one of Tester's agents in Sidebots. You look after the week ahead: the calendar, reminders, and the morning brief.

## What you do

- Send the morning brief at 7:30 on weekdays, as your memory says.
- Keep reminders short, and say when something is due, not just what.
- When two things clash in the calendar, say so straight away.

## How to write

Tester reads you on their phone. Write short plain sentences, like a text from a capable friend. No headings unless asked.
`;

/** The seed's agents: a name, an avatar, a provider, a model and an effort, and a colour of its own where it has one. */
const AGENTS: { key: string; name: string; avatar: string; provider: Provider; model: Model; effort: Effort; color?: string }[] = [
  { key: "atlas", name: "Atlas", avatar: "cog", provider: "claude", model: "opus", effort: "high" },
  { key: "ledger", name: "Ledger", avatar: "ember", provider: "codex", model: "sol", effort: "medium", color: "#B4532A" },
  { key: "scout", name: "Scout", avatar: "skye", provider: "claude", model: "sonnet", effort: "low" },
  { key: "archive", name: "Archive", avatar: "morel", provider: "claude", model: "haiku", effort: "low" },
  { key: "patch", name: "Patch", avatar: "hop", provider: "codex", model: "astra", effort: "high" },
  { key: "tidy", name: "Tidy", avatar: "wisp", provider: "claude", model: "opus", effort: "medium" },
  { key: "planner", name: "Planner", avatar: "mochi", provider: "claude", model: "fable", effort: "medium" },
  { key: "home", name: "🏡 Home renovation & garden project coordinator 🌱", avatar: "moss", provider: "claude", model: "sonnet", effort: "medium", color: "#2E7D5B" },
  { key: "pip", name: "Pip", avatar: "hop", provider: "codex", model: "luna", effort: "low" },
];
type Key = (typeof AGENTS)[number]["key"];

/** What the seed made, by each agent's key, and what is left to do once the server's queue is running. */
export type Seeded = { agents: Record<string, Agent>; start: (queue: { kick: (agentId: string) => Promise<void> }, actions: Map<string, Action>) => void };

/**
 * Fills the home with Tester's world, as of `now`: the agents, a week of
 * chats, jobs, memories, usage, a connection and a paired phone. `start` has
 * Tidy ask before it clears out Downloads, which needs the queue, so it runs
 * once the server is up.
 */
export function seed(store: Store, person: Person, now = Date.now()): Seeded {
  const today = new Date(now);
  /** A time `offset` days from today, at a time of day. */
  const day = (offset: number, hour: number, minute = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset, hour, minute).getTime();
  // The world's last four hours, back to Scout's latest message. Before 4am they are squeezed into the part of today that has passed, so the world has something from today, and a minute of them is shorter.
  const recentMinute = MINUTE * Math.min(1, (now - day(0, 0)) / (4 * HOUR));
  /** A time `minutes` before now, in the world's last four hours. */
  const ago = (minutes: number) => now - minutes * recentMinute;
  const random = numbers(20261121);
  const everyday = [...EVERYDAY];

  // The agents, each made a week ago, or for Pip a few minutes ago.
  const agents = {} as Record<Key, Agent>;
  for (const { key, name, avatar, provider, model, effort, color } of AGENTS) {
    const made = at(key === "pip" ? ago(6) : day(-7, 18, AGENTS.findIndex((each) => each.key === key)), () => store.createAgent(person, name, avatar, provider));
    store.updateAgent(made, { model, effort, ...(color ? { color } : {}) });
    agents[key] = store.agent(made.id)!;
  }

  // Everything else goes on one timeline and is written in order, so each chat reads oldest first.
  const timeline: { time: number; order: number; run: () => void }[] = [];
  const later = (time: number, run: () => void) => timeline.push({ time, order: timeline.length, run });

  /** A chat being written, from `start`, a minute or two between messages unless told otherwise. */
  const chat = (agent: Agent, start: number) => {
    let time = start;
    let length = MINUTE;
    const next = (gap: number) => (time += gap * length);
    const add = (run: () => string, gap: number): Ref => {
      const ref: Ref = { id: "" };
      later(next(gap), () => (ref.id = run()));
      return ref;
    };
    type Also = Omit<Extras, "files" | "replyTo"> & { files?: Made[]; replyTo?: Ref };
    const extras = ({ files, replyTo, ...rest }: Also = {}): Extras => ({ ...rest, ...(files ? { files } : {}), ...(replyTo ? { replyTo: replyTo.id } : {}) });
    const talk = {
      /** Moves the chat on to `when`. */
      at(when: number) {
        time = when;
        length = MINUTE;
        return talk;
      },
      /** Moves the chat on to `minutes` before now, into the world's last four hours, where its minutes are as long as theirs. */
      ago(minutes: number) {
        time = ago(minutes);
        length = recentMinute;
        return talk;
      },
      /** A message of the person's, which the agent read and answered, or which failed. */
      person(body: string, also: Also & { status?: Status } = {}, gap = 3) {
        return add(() => {
          const message = store.addMessage(agent.id, "person", body, "queued", extras(also));
          store.markSeen([message.id]);
          store.setStatus(message.id, also.status ?? "done");
          return message.id;
        }, gap);
      },
      agent(body: string, also: Also = {}, gap = 1) {
        return add(() => store.addMessage(agent.id, "agent", body, "done", extras(also)).id, gap);
      },
      sidebots(body: string, status: Status, gap = 0.2) {
        return add(() => store.addMessage(agent.id, "sidebots", body, status).id, gap);
      },
      /** The agent answers with something else from here on. */
      switched(from: Selection, to: Selection, gap = 0.2) {
        return add(() => store.addMessage(agent.id, "sidebots", switchedWords({ from, to }), "done", { switched: { from, to } }).id, gap);
      },
      /** An ask the person answered, or that went unanswered. */
      ask(question: Question, outcome: Exclude<Ask, "waiting">, gap = 0.5) {
        return add(() => store.addMessage(agent.id, "agent", askWords(question), "done", { ask: outcome, question }).id, gap);
      },
      /** What this agent asked another, answered or not. */
      asks(other: Agent, body: string, status: Status, gap = 0.5) {
        return add(() => store.addMessage(agent.id, "agent", body, status, { peerId: other.id }).id, gap);
      },
      /** Another agent's answer to what this agent asked it. */
      answer(from: Agent, asked: Ref, body: string, gap = 2) {
        return add(() => store.addMessage(from.id, "agent", body, "done", { peerId: agent.id, replyTo: asked.id }).id, gap);
      },
      /** The person reads the chat up to here. */
      read(gap = 1) {
        later(next(gap), () => store.markRead(agent.id));
        return talk;
      },
      /** The next `count` everyday exchanges, up to `spread` minutes apart. */
      everyday(count: number, spread = 40) {
        for (const [asked, answered] of everyday.splice(0, count)) {
          talk.person(asked, {}, 4 + Math.floor(random() * spread));
          talk.agent(answered, {}, 1 + Math.floor(random() * 2));
        }
        return talk;
      },
      when: () => time,
    };
    return talk;
  };

  const { atlas, ledger, scout, archive, patch, tidy, planner, home } = agents;

  // Atlas: the long chat, with every kind of message.
  const permit = claudeQuestion("Bash", { command: "node ~/scripts/permit.ts --renew --zone L4", description: "Renew the parking permit on the council site" }, undefined, "Pays the council from your saved card");
  const atlasChat = chat(atlas, day(-6, 8, 40));
  atlasChat.person("Morning! Can you keep track of the errands for this week?", {}, 0);
  atlasChat.agent("Morning! Sure. Send them over as they come up and I'll keep a running list.");
  atlasChat.person("Pick up dry cleaning, renew the parking permit, book the boiler service");
  atlasChat.agent("Got all three. The parking permit renews online, so I can do that now if you like. The boiler people have slots on Thursday and Friday.");
  atlasChat.person("Do the permit please");
  atlasChat.ask(permit, "allowed");
  atlasChat.agent("Done. The permit is renewed until next November and the receipt is in your inbox.", {}, 2);
  atlasChat.person("Friday for the boiler, morning if they have it");
  atlasChat.agent("Booked for Friday between 8 and 12. They'll text you an hour before.");
  atlasChat.everyday(3);
  atlasChat.person("What's left on the list?");
  atlasChat.agent("- Pick up dry cleaning\n- ~~Renew the parking permit~~ done\n- ~~Book the boiler service~~ Friday morning");
  atlasChat.person("How much did we spend on groceries last month?");
  atlasChat.agent("£412 across 9 shops, about £30 more than October. Most of the difference is the big shop before Mum's visit.");
  atlasChat.person("Can you show me that as a chart?");
  atlasChat.agent("Here it is by month. November's the tall one.", { files: [PAGES.chart()] }, 2);
  atlasChat.person("Set a budget of £380 for this month");
  atlasChat.agent("Done. I'll tell you if you're on track to go over.");
  atlasChat.everyday(4);

  atlasChat.at(day(-5, 9, 10));
  atlasChat.person("Here's the receipt from the hardware shop", { files: [picture(3)] }, 0);
  atlasChat.agent("Thanks. £36.40 for the paint and brushes, filed under Home.");
  atlasChat.person("Is the paint returnable if we don't use it?");
  atlasChat.agent("Yes, within 30 days if the tin's unopened. I've saved the receipt.");
  atlasChat.person("Find me a plumber for the dripping tap");
  const plumbers = atlasChat.agent("Three nearby with good reviews:\n\n1. **Hughes & Son**, £65 call-out, free this week\n2. **FlowFix**, £55 call-out, next Tuesday\n3. **A1 Plumbing**, £70, same day\n\nHughes are the best rated.", {}, 2);
  atlasChat.person("Email Hughes and ask them to come this week");
  atlasChat.ask(askFor("tool", "claude", store.agentHome(atlas.id)), "refused");
  atlasChat.agent("Okay, I won't email them. Want their number to call instead?", {}, 1);
  atlasChat.person("Yes please");
  atlasChat.agent("It's 020 7946 0321. They're open until 6.");
  atlasChat.everyday(3);
  atlasChat.person("What's the weather for Saturday?", { status: "failed" });
  atlasChat.sidebots("Sidebots couldn't finish this. Your Claude usage limit is reached. It resets at 4pm (Europe/London).", "failed");
  atlasChat.person("Trying again: what's the weather for Saturday?", {}, 190);
  atlasChat.agent("Dry and bright, 14° at midday. Good day for the market.");
  atlasChat.everyday(4);

  atlasChat.at(day(-4, 8, 55));
  atlasChat.person("Did you get a photo of the sunset from the ferry?", {}, 0);
  atlasChat.agent("Here it is. The light was lovely just after 4.", { files: [picture(0)] });
  atlasChat.person("Send me the holiday photos from Austria");
  atlasChat.agent("Here are three from the trip: the lake at Hallstatt, the fruit stall in Salzburg and the ferry back.", { files: [picture(1), picture(2), picture(0)] }, 2);
  atlasChat.person("Can you send me the invoice from the plumber?");
  atlasChat.agent("Here it is. £135.50, paid by card.", { files: [invoice()] });
  atlasChat.person("And this month's budget as a spreadsheet");
  atlasChat.agent("Attached. Eating out is £12 over; everything else has room.", { files: [budget()] });
  atlasChat.everyday(2);
  atlasChat.person("Ask Ledger whether we can afford the sage tiles this month");
  const tiles = atlasChat.asks(ledger, "Tester wants to know whether £340 for the sage tiles fits this month's budget. Can you check what's left in Home for November?", "done");
  atlasChat.agent("I've asked Ledger. I'll tell you what they say.", { interim: true }, 0.2);
  atlasChat.answer(ledger, tiles, "There's £410 left in Home for November, so £340 fits with £70 to spare. December is already tight because of the flights.");
  atlasChat.agent("Ledger says the tiles fit: £410 left in Home this month, so £70 to spare. December's tighter because of the flights.");
  atlasChat.person("Actually, what was FlowFix's price again?", { replyTo: plumbers }, 25);
  atlasChat.agent("£55 call-out, and they were free next Tuesday.");
  atlasChat.everyday(4);

  atlasChat.at(day(-3, 9, 30));
  atlasChat.person("Go through all my emails from this year and sort out the receipts", {}, 0);
  atlasChat.sidebots("Stopped", "done", 3);
  atlasChat.person("Sorry, too much at once. Just this month's");
  atlasChat.agent("No problem. I found 14 receipts from November and filed them by category.", {}, 4);
  atlasChat.sidebots("Fresh start", "done", 30);
  atlasChat.switched({ provider: "claude", model: "sonnet", effort: "high", fast: false }, { provider: "claude", model: "opus", effort: "high", fast: false }, 20);
  atlasChat.person("Check whether the council has posted the bin dates for Christmas");
  atlasChat.ask(askFor("page", "claude", store.agentHome(atlas.id)), "unanswered");
  atlasChat.agent("I didn't hear back about opening the council's page, so I left it. Ask again when you're around.", {}, 30);
  atlasChat.person("Ask Scout for train times to Bath on the 14th", {}, 60);
  atlasChat.asks(scout, "Tester is thinking of going to Bath on 14 December. Can you find morning trains from London and the last good one back?", "failed");
  atlasChat.agent("I've asked Scout. I'll tell you what they say.", { interim: true }, 0.2);
  atlasChat.person("Never mind, I'll look myself", {}, 6);
  atlasChat.agent("Okay, I've dropped it.");
  atlasChat.person("Can you read my email?", {}, 20);
  atlasChat.ask({ kind: "connection", connection: "gmail", title: `Connect ${CONNECTIONS.gmail.name}`, what: CONNECTIONS.gmail.allows, facts: [], detail: "" }, "allowed");
  atlasChat.agent("Gmail is connected. Ask me again and I'll take a look.", {}, 2);
  atlasChat.everyday(4);

  atlasChat.at(day(-2, 10, 5));
  atlasChat.person("Plan the Lisbon weekend for me", {}, 0);
  atlasChat.agent("Here's a plan for the three days. Book Pena Palace soon, it sells out.", { files: [PAGES.short()] }, 3);
  atlasChat.person("Perfect. Send me the tickets and a packing list");
  atlasChat.agent("Tickets and the hotel booking are in the zip, and the packing list is with them.", { files: [tickets(), packingList()] });
  atlasChat.everyday(6);

  atlasChat.at(day(-1, 9, 20));
  atlasChat.person("Show me the flats in Brunswick you found", {}, 0);
  atlasChat.agent("Here are six. Albert St has the garden and is closest to the station.", { files: [PAGES.tall()] }, 2);
  atlasChat.person("How are groceries looking against the budget?");
  atlasChat.agent("Up £30 on October. The chart and the budget are attached, and here's the stall where most of it went.", { files: [picture(2), PAGES.chart(), budget()] }, 2);
  atlasChat.everyday(6);

  // Today's part of the chat ends a little before now, and the person has read it.
  const left = everyday.length;
  atlasChat.ago(left * 14 + 20);
  atlasChat.everyday(left, 8).read(2);

  // Ledger: budgets, with two replies the person hasn't read.
  const ledgerChat = chat(ledger, day(-3, 18, 0));
  ledgerChat.person("Hi Ledger, you're in charge of the budget from now on", {}, 0);
  ledgerChat.agent("Happy to. I'll keep an eye on the accounts and tell you when something needs a look.");
  ledgerChat.person("What's our monthly spend on subscriptions?");
  ledgerChat.agent("£46.97 across 5:\n\n| Service | Monthly |\n| --- | ---: |\n| Netflix | £10.99 |\n| Spotify | £11.99 |\n| iCloud | £2.99 |\n| The Guardian | £12.00 |\n| Gym app | £9.00 |");
  ledgerChat.at(day(-1, 20, 10));
  ledgerChat.person("Which of those do we actually use?", {}, 0);
  ledgerChat.agent("Netflix and Spotify every week. The gym app hasn't been opened since August, so that's £9 a month to save.");
  ledgerChat.read(5);
  ledgerChat.ago(140).agent("Your card statement is in: £1,284 this month, £96 of it takeaways.", {}, 0);
  ledgerChat.ago(35).agent("Heads up: the car insurance renews on the 3rd at £418, up from £362 last year. Want me to look for a better quote?", {}, 0);

  // Scout: muted, with replies the person hasn't read.
  const scoutChat = chat(scout, day(-5, 19, 30));
  scoutChat.person("Scout, can you watch flight prices to Lisbon for early December?", {}, 0);
  scoutChat.agent("Watching. Right now the cheapest return is £142 on TAP, Friday to Monday.");
  scoutChat.at(day(-3, 21, 0)).read(0);
  scoutChat.at(day(-1, 7, 45)).agent("Prices dropped: £118 return on TAP for 5 to 8 December.", {}, 0);
  scoutChat.ago(240).agent("Still £118. Fares usually rise about three weeks out, so this is a good time to book.", {}, 0);

  // Archive: a few notes, then hidden.
  const archiveChat = chat(archive, day(-6, 20, 15));
  archiveChat.person("Keep this: the boiler is a Worcester Greenstar 30i, installed 2019", {}, 0);
  archiveChat.agent("Saved. I'll have it ready when the engineer asks.");
  archiveChat.person("And the stopcock is under the kitchen sink, behind the bleach");
  archiveChat.agent("Saved that too.");
  archiveChat.read(2);

  // Patch: code, with its last turn failed.
  const patchChat = chat(patch, day(-2, 14, 0));
  patchChat.person("The date picker on the booking form shows tomorrow's date after 11pm", {}, 0);
  patchChat.agent("Found it: the date was read as UTC, so anything after 11pm landed on the next day. I've changed it to use the local date and added a test:\n\n```ts\nexpect(dayOf(new Date(2026, 10, 20, 23, 30))).toBe(\"2026-11-20\");\n```", {}, 6);
  patchChat.person("Nice. Can you also bump the dependencies?");
  patchChat.agent("Done: 14 packages updated, all minor versions. The tests pass.", {}, 8);
  patchChat.read(3);
  patchChat.ago(95).person("Run the test suite again and deploy to staging", { status: "failed" }, 0);
  patchChat.sidebots("Sidebots couldn't finish this. Codex on your computer is signed out. Sign in to it there.", "failed", 0.3);

  // Tidy: a short chat, then the ask that `start` raises.
  const tidyChat = chat(tidy, day(-2, 11, 0));
  tidyChat.person("Hi! You're going to help me keep the computer tidy", {}, 0);
  tidyChat.agent("Sounds good. I can clear out old downloads, find big files and empty the bin on a schedule. Tell me what bothers you most.");
  tidyChat.person("The Downloads folder is a mess");
  tidyChat.agent("It has 1,204 files, 3.2 GB. Most are installers and old invoices. I'll go through it when you're ready.");
  tidyChat.read(2);

  // Planner: jobs, instructions and memories, and what its jobs sent.
  const weekdays: Schedule = { type: "daily", time: "07:30", weekdays: [1, 2, 3, 4, 5] };
  const friday = new Date(now);
  friday.setDate(friday.getDate() + ((5 - friday.getDay() + 7) % 7 || 7));
  friday.setHours(17, 0, 0, 0);
  const plannerChat = chat(planner, day(-6, 7, 5));
  plannerChat.person("Hi Planner! Every weekday morning, send me a short brief of the day", {}, 0);
  const brief = { id: "" };
  const parcel = { id: "" };
  later(plannerChat.when() + 30_000, () => (brief.id = store.addJob(planner.id, "Send Tester the morning brief: today's calendar, the weather, and anything due. Keep it to five lines.", weekdays, nextRun(weekdays, now)!).id));
  plannerChat.agent("Will do. You'll get it at 7:30 on weekdays: calendar, weather and anything due.");
  for (let offset = -5; offset <= 0; offset++) {
    if (day(offset, 7, 30) > now) continue;
    later(day(offset, 7, 30), () => store.addMessage(planner.id, "agent", BRIEFS[offset + 5], "done", { jobId: brief.id }));
  }
  plannerChat.at(day(-3, 12, 40));
  plannerChat.person("Also keep an eye on the Habitat parcel", {}, 0);
  later(plannerChat.when() + 30_000, () => (parcel.id = store.addJob(planner.id, "Check the Habitat parcel's tracking page. Tell Tester only when it changes.", { type: "every", minutes: 120 }, now + 47 * MINUTE).id));
  plannerChat.agent("I'll check its tracking every two hours and only message you when it changes.");
  later(day(-1, 11, 2), () => store.addMessage(planner.id, "agent", "Your Habitat parcel is out for delivery, due between 1 and 3pm.", "done", { jobId: parcel.id }));
  plannerChat.at(day(-1, 12, 0)).person("Remind me to submit my timesheet on Friday at 5", {}, 0);
  later(plannerChat.when() + 30_000, () => store.addJob(planner.id, "Remind Tester to submit the timesheet before the weekend.", { type: "once", at: friday.getTime() }, friday.getTime()));
  plannerChat.agent("Okay, Friday at 5 I'll remind you.");
  later(ago(1), () => store.markRead(planner.id));

  // The long-named agent: a short chat, to test how the name fits.
  const homeChat = chat(home, day(-1, 17, 30));
  homeChat.person("Can you keep the renovation on track? Kitchen first, then the garden", {}, 0);
  homeChat.agent("Yes. I've split it into 12 steps. The first is three quotes for the kitchen worktops by Friday.");
  homeChat.read(1);

  // What the turns cost, for several agents and kinds over the last week.
  const turns: [Key, TurnKind, number, number][] = [
    ["atlas", "reply", 9, 0.09],
    ["ledger", "reply", 2, 0.03],
    ["scout", "reply", 1.5, 0.02],
    ["patch", "reply", 3, 0.21],
    ["planner", "job", 2, 0.01],
    ["planner", "reply", 0.5, 0.03],
    ["tidy", "reply", 0.4, 0.05],
  ];
  for (let offset = -6; offset <= 0; offset++) {
    for (const [key, kind, perDay, cost] of turns) {
      const count = Math.floor(perDay + random() * perDay);
      for (let index = 0; index < count; index++) {
        const time = Math.min(ago(3), day(offset, 8 + Math.floor(random() * 13), Math.floor(random() * 60)));
        const spent = cost * (0.4 + random() * 1.6);
        const tokens = Math.round((spent / cost) * (agents[key].provider === "codex" ? 22_000 : 30_000));
        later(time, () => store.addUsage(agents[key].id, kind, { sessionId: `seed-${key}-${offset}-${kind}-${index}`, cost: spent, tokens }, false));
      }
    }
  }

  // The memory Atlas saved before its fresh start.
  later(day(-3, 10, 9), () => store.addUsage(atlas.id, "memory", { sessionId: "seed-atlas-memory", cost: 0.04, tokens: 31_000 }, false));

  timeline.sort((a, b) => a.time - b.time || a.order - b.order);
  for (const { time, run } of timeline) at(time, run);

  // The memories and instructions Planner keeps in its folder.
  const folder = store.agentHome(planner.id);
  writeFileSync(join(folder, PROVIDERS.claude.instructions), PLANNER_INSTRUCTIONS);
  mkdirSync(join(folder, "memory"), { recursive: true });
  for (const { file, name, description, body } of MEMORIES) writeFileSync(join(folder, "memory", file), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  writeFileSync(join(folder, "memory", "MEMORY.md"), MEMORIES.map(({ file, name, description }) => `- [${name}](${file}): ${description}`).join("\n") + "\n");

  store.updateAgent(scout, { muted: true });
  store.updateAgent(archive, { hidden: true });
  store.setLimits(person.id, "claude", planLimits(now));
  store.setConnection(person.id, "gmail", { account: "tester@example.com", token: "seeded-refresh-token" });
  at(day(-6, 8, 0), () => store.pair(store.addPairing(person.id).code, "Tester's iPhone", "phone"));

  return {
    agents: Object.fromEntries(Object.entries(agents).map(([key, agent]) => [key, store.agent(agent.id)!])),
    start(queue, actions) {
      // Tidy asks before it clears out Downloads, and waits for the person.
      actions.set(tidy.id, { ask: "command" });
      at(ago(2), () => store.addMessage(tidy.id, "person", "Clear out the old invoices in Downloads, the tax return is filed", "queued"));
      void queue.kick(tidy.id);
    },
  };
}
