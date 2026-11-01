import type { JsonValue } from "@earendil-works/pi-ai";
import type { Reply } from "../../test/fakes/ai";

/**
 * Turns the local stack's fake model plays as a real model would, so `pnpm seed` (test/stack/seed.ts) fills
 * every page with something that reads like use: a user's own words in, markdown, cards and real tool calls
 * out. Each prompt is matched whole; its steps answer one round each, the first before any tool result, the
 * next after the first result, and so on, ending on text. The chat's title is `title`.
 */

type Turn = { readonly title?: string; readonly steps: readonly Reply[] };

const call = (tool: string, args: Record<string, JsonValue>, say?: string): Reply => (say === undefined ? { tool, args } : { tool, args, say });

const text = (body: string): Reply => ({ text: body });

/** A `ui` card's arguments, checked as JSON where they're written. */
const card = (args: Record<string, JsonValue>): Record<string, JsonValue> => args;

const BRIEFING = card({
  id: "today",
  title: "Sunday, Nov 1",
  subtitle: "Calendar · Inbox · Weather",
  icon: "google-calendar",
  blocks: [
    { type: "stats", items: [{ value: 3, label: "meetings" }, { value: 12, label: "unread" }, { value: "14°", label: "Lisbon, clear", tone: "success" }] },
    {
      type: "list",
      items: [
        { title: "Coffee with Maya", meta: "9:30 AM · Fábrica" },
        { title: "Design review: composer", meta: "1:00 PM · 45 min" },
        { title: "Call the plumber back", meta: "Before 5 PM" }
      ]
    },
    { type: "status", text: "Your flight to SFO on Thursday is on time.", tone: "info" }
  ]
});

const PRS = card({
  title: "Your PRs this week",
  subtitle: "Oct 26 – Nov 1 · GitHub",
  icon: "github",
  blocks: [
    { type: "stats", items: [{ value: 23, label: "opened" }, { value: 19, label: "merged", tone: "success" }, { value: 2, label: "in review" }, { value: "1.4d", label: "median to merge" }] },
    {
      type: "chart",
      kind: "bar",
      stacked: true,
      label: "Merged per day",
      x: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      series: [
        { name: "ky", values: [3, 4, 2, 5, 3, 0, 1] },
        { name: "scotty", values: [0, 1, 0, 0, 0, 0, 0] }
      ]
    },
    {
      type: "table",
      columns: ["PR", "Title", "Merged"],
      rows: [
        ["#194", "Each chat follows the main slot", "Oct 31"],
        ["#193", "A backup caps each part row by row", "Oct 30"],
        ["#192", "Owned table gets the profile column", "Oct 29"]
      ]
    }
  ]
});

const TRIP = card({
  id: "lisbon",
  title: "Lisbon, Mar 13–16",
  subtitle: "Held until Friday noon",
  blocks: [
    { type: "status", text: "Flights and the flat are held; nothing is paid yet.", tone: "info" },
    {
      type: "list",
      items: [
        { title: "TAP 236 · SFO → LIS", meta: "Thu 6:40 PM" },
        { title: "Flat in Alfama, 2 bedrooms", meta: "3 nights · €410" },
        { title: "Dinner at Taberna da Rua das Flores", meta: "Fri 8:30 PM" },
        { title: "TAP 237 · LIS → SFO", meta: "Mon 11:15 AM" }
      ]
    },
    { type: "choice", label: "Book them?", options: [{ label: "Book all" }, { label: "Just the flights" }, { label: "Not yet" }] }
  ]
});

const QUOTES = card({
  title: "Kitchen quotes",
  subtitle: "Three contractors · cabinets, counters, labour",
  blocks: [
    {
      type: "table",
      columns: ["Contractor", "Total", "Weeks", "Warranty"],
      rows: [
        ["Oak & Iron", "$38,400", "6", "5 years"],
        ["Northside Build", "$31,900", "9", "2 years"],
        ["Hearth Co.", "$34,750", "7", "10 years"]
      ]
    },
    { type: "chart", kind: "bar", label: "Total by contractor, $k", x: ["Oak & Iron", "Northside", "Hearth"], series: [{ name: "total", values: [38.4, 31.9, 34.75] }] }
  ]
});

const QUARTERLY = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
body{margin:0;font:16px/1.5 system-ui;background:#f7f5f0;color:#1d1d1f}main{max-width:640px;margin:48px auto;padding:0 24px}
h1{font-size:32px;margin:0 0 8px}p{color:#555}.row{display:flex;gap:16px;margin:32px 0}.stat{flex:1;background:#fff;border-radius:14px;padding:16px}
.stat b{display:block;font-size:28px}</style></head><body><main><h1>Q3 at a glance</h1><p>Revenue up, churn down, one big launch.</p>
<div class="row"><div class="stat"><b>$1.2M</b>Revenue</div><div class="stat"><b>2.1%</b>Churn</div><div class="stat"><b>48</b>NPS</div></div></main></body></html>`;

const PACKING = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
body{margin:0;font:16px/1.6 system-ui;background:#eef3f8;color:#111}main{max-width:520px;margin:40px auto;padding:0 20px}li{margin:6px 0}
</style></head><body><main><h1>Lisbon packing list</h1><ul><li>Light jacket, it's 14° at night</li><li>Walking shoes for the hills</li>
<li>EU plug adapter</li><li>Kai's warm jacket (size 4T)</li></ul></main></body></html>`;

const DEPLOY = `Here's the short version.

## How a change ships

1. **Merge to \`main\`.** CI runs typecheck, lint and the unit suite.
2. **The deploy workflow** builds the release and runs \`ky deploy\` with the owner's settings.
3. **The doctor** checks the live Worker: the release line names \`main\`'s commit and nothing is marked ✗.

| Step | Takes | Rolls back with |
| --- | --- | --- |
| CI | ~4 min | — |
| Deploy | ~2 min | \`gh workflow run deploy.yml -f sha=…\` |
| Doctor | ~20 s | — |

\`\`\`sh
gh workflow run deploy.yml --ref main
\`\`\`

Never run \`wrangler deploy\` from the repo: it drops the config ky computes.`;

const TURNS = {
  "Morning! What's on today?": {
    steps: [
      call("ui", BRIEFING, "Pulling your calendar, inbox and the weather."),
      text("Three things today. **Coffee with Maya** is the only one before noon, and the plumber wants a call back before 5. Want me to draft that reply?")
    ]
  },
  "How did my PRs do this week?": {
    steps: [call("ui", PRS), text("A good week: **19 merged**, mostly in ky, with Thursday the busiest day. Two are still waiting on review.")]
  },
  "Set up my usual routines": {
    steps: [
      call("automation", { action: "create", title: "Morning briefing", prompt: "Brief me on today's calendar, inbox and weather.", cron: "0 8 * * 1-5", createdBy: "user" }),
      call("automation", { action: "create", title: "Inbox digest", prompt: "Sum up what came in since this morning.", cron: "0 17 * * *", createdBy: "user" }),
      call("automation", { action: "create", title: "Weekly review", prompt: "Review the week: what shipped, what slipped.", cron: "0 16 * * 5", createdBy: "user" }),
      call("automation", { action: "create", title: "Water the plants", prompt: "Remind me to water the plants.", cron: "0 19 * * 0,3", createdBy: "user" }),
      text("Four routines are set:\n\n- **Morning briefing**, weekdays at 8:00\n- **Inbox digest**, daily at 17:00\n- **Weekly review**, Fridays at 16:00\n- **Water the plants**, Sundays and Wednesdays at 19:00")
    ]
  },
  "Remember that Kai's jacket size is 4T": {
    steps: [call("memory_note", { text: "Kai's jacket size is 4T." }), text("Noted. I'll use **4T** when we shop for Kai.")]
  },
  "Have the Mac run the test suite and fix anything flaky": {
    steps: [
      call("machine", { action: "run", machine: "webmac", prompt: "[delay=5000] [tools=Bash:pnpm test,Edit:src/ui/Sidebar.tsx,Bash:pnpm test] [diff] Run the test suite and fix anything flaky" }, "Sending it to your Mac."),
      text("The Mac is on it. It'll show up in **Activity**, and I'll tell you what it changed.")
    ]
  },
  "Watch the staging deploy and tell me if it breaks": {
    steps: [
      call("machine", { action: "run", machine: "webmac", prompt: "[delay=3600000] [tools=Bash:gh run watch] Watch the staging deploy and report if it breaks" }),
      text("Watching it. It stays in **Now** until the deploy finishes.")
    ]
  },
  "Rebuild the search index on the Mac": {
    steps: [call("machine", { action: "run", machine: "webmac", prompt: "[delay=2000] [fail] Rebuild the search index" }), text("Started the rebuild on your Mac.")]
  },
  "Find three flats in Lisbon for March, and check the trains from Porto": {
    steps: [
      call("subagent", { action: "spawn", name: "flats", message: "Find three flats in Alfama for Mar 13–16 under €150 a night." }),
      call("subagent", { action: "spawn", name: "trains", message: "Check the trains from Porto to Lisbon on Mar 13." }),
      text("Two helpers are looking: one for **flats in Alfama**, one for **trains from Porto**. Both show in Activity.")
    ]
  },
  "How does a change get deployed?": { steps: [text(DEPLOY)] },
  "Give @builder an orange avatar": {
    steps: [
      call("avatar", { action: "set", for: "builder", spec: { name: "Bolt", body: { w: 112, h: 104, corner: 32, color: "#ff7a3d" }, eyes: { count: 1, size: 26 }, top: { kind: "antenna", color: "#2b7fff" }, cheeks: false, feet: true } }),
      text("@builder has a new look.")
    ]
  },
  "Plan a long weekend in Lisbon in March": {
    title: "Lisbon in March",
    steps: [call("ui", TRIP, "Here's what I'd hold."), text("Everything's held until **Friday noon**. The flat is in Alfama, a short walk from the tram.")]
  },
  "Make a packing list I can open on my phone": {
    steps: [call("site", { action: "publish", title: "Lisbon packing list", html: PACKING }), text("It's a page now. Open it from **Artifacts** on your phone.")]
  },
  "Save how I order groceries as a skill": {
    title: "Groceries",
    steps: [
      call("skill_manage", {
        action: "create",
        name: "groceries",
        description: "Order the weekly groceries from the shared list",
        body: "## Steps\n1. Open the shared list in Notes.\n2. Add oat milk, eggs and bananas if they're missing.\n3. Order for Saturday morning delivery.\n\n## Needs\n- login: Are you signed in to the grocer in ky's browser? (yes | no)"
      }),
      text("Saved as **groceries**. Say *order groceries* any time.")
    ]
  },
  "And a skill for planning the week's dinners": {
    steps: [
      call("skill_manage", { action: "create", name: "dinners", description: "Pick five dinners for the week, one with fish", body: "## Steps\n1. Pick five dinners, one with fish.\n2. Skip anything with mushrooms.\n3. Add what's missing to the shared list." }),
      call("skill_manage", { action: "create", name: "sunday-reset", description: "Tidy, plan and stock up on Sundays", body: "## Steps\n1. Clear the inbox to zero.\n2. Plan the week's dinners.\n3. Order groceries." }),
      text("Added **dinners** and **sunday-reset**, which runs both.")
    ]
  },
  "Publish the Q3 numbers as a page": {
    title: "Q3 report",
    steps: [call("site", { action: "publish", title: "Q3 at a glance", html: QUARTERLY }), text("Published **Q3 at a glance**. It's in Artifacts.")]
  },
  "Brief me on today's calendar, inbox and weather.": {
    steps: [call("ui", BRIEFING), text("Three meetings, a quiet inbox and a clear 14°. Coffee with Maya is first.")]
  },
  "Sum up what came in since this morning.": {
    steps: [text("**12 new**, 2 that need you:\n\n- Maya moved coffee to 9:30\n- The plumber can come Tuesday; reply to confirm\n\nThe rest are receipts and newsletters.")]
  },
  "Find three flats in Alfama for Mar 13–16 under €150 a night.": {
    steps: [
      text("Three in Alfama, cheapest first:\n\n1. **Casa do Largo**, 1 bedroom, €118 a night, by the Sé\n2. **Miradouro flat**, 2 bedrooms, €136 a night, a terrace over the river\n3. **Rua dos Remédios loft**, €149 a night, 5 minutes from the tram")
    ]
  },
  "Check the trains from Porto to Lisbon on Mar 13.": {
    steps: [text("Alfa Pendular every hour from Campanhã; the **9:52** gets in at 12:41. €31 in Turística, €44 in Conforto.")]
  },
  "Compare these three kitchen quotes": {
    title: "Kitchen renovation",
    steps: [call("ui", QUOTES), text("**Hearth Co.** is the pick: mid-priced, done in 7 weeks, and the only one with a 10-year warranty. Northside is cheapest, but takes 9 weeks with a 2-year warranty.")]
  }
} satisfies Record<string, Turn>;

/** What ky tells the user when a background result lands in the chat, by who sent it and what it says. */
const NOTICES: ReadonlyArray<readonly [RegExp, (body: string) => string]> = [
  [/^\[subagent flats [^\]]*\]\s*/, () => "The flats are in: **three in Alfama**, from €118 a night. The Miradouro flat has a terrace over the river; want me to hold it?"],
  [/^\[subagent trains [^\]]*\]\s*/, () => "Trains from Porto run hourly; the **9:52** gets you to Lisbon at 12:41 for €31."],
  [/^\[machine [^\]]*(?:Run the test suite|Fix the flaky tests)[^\]]*finished[^\]]*\]\s*/, () => "Your Mac fixed the flaky test: the sidebar test waited on a timer instead of the list. **2 files** changed and the suite is green; the changes are below."],
  [/^\[machine [^\]]*[Ss]earch index[^\]]*failed[^\]]*\]\s*/, () => "The search index rebuild **failed** on your Mac: the indexer ran out of disk. Want me to clear the build cache and try again?"]
];

const TITLES: ReadonlyArray<readonly [string, string]> = [
  ["Run the test suite", "Fix the flaky tests"],
  ["Rebuild the search index", "Rebuild the search index"],
  ["Watch the staging deploy", "Watch the staging deploy"],
  ["Find three flats in Alfama", "Flats in Alfama"],
  ["trains from Porto to Lisbon", "Trains from Porto"],
  ["Three meetings, a quiet inbox", "3 meetings, clear 14°"],
  ["12 new", "12 new, 2 need you"]
];

/** The seeded turn a prompt starts, if any. */
const ENTRIES: ReadonlyArray<readonly [string, Turn]> = Object.entries(TURNS);

const turnOf = (prompt: string): Turn | undefined => {
  const asked = prompt.trim();

  return ENTRIES.find(([key]) => key === asked)?.[1] ?? ENTRIES.find(([key]) => asked.endsWith(key))?.[1];
};

/** The step a seeded turn takes now: `done` tool results in. Undefined for any prompt not seeded here. */
export function seededReply(prompt: string, done: number): Reply | undefined {
  const notice = NOTICES.find(([pattern]) => pattern.test(prompt));

  if (notice) return done === 0 ? text(notice[1](prompt.replace(notice[0], "").trim())) : undefined;
  const turn = turnOf(prompt);

  return turn ? (turn.steps[Math.min(done, turn.steps.length - 1)] ?? undefined) : undefined;
}

/** A seeded chat's title, from its first line. */
export function seededTitle(text: string): string | undefined {
  const first = text.split("\n")[0] ?? "";
  const turn = ENTRIES.find(([prompt]) => first.includes(prompt))?.[1];

  return turn?.title ?? TITLES.find(([part]) => text.includes(part))?.[1];
}
