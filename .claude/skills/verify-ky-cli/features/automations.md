# Automations

Source: `src/automations/automations.ts` (the `ky_automations` table, the Scheduler callback, the `automation` tool);
runs are cloud subagents (`src/skills/subagents.ts`) or machine tasks (`src/machines/machines.ts`) with task id `a-<id>-<slot>`
and source `automation:<id>`. Crons are UTC. Both scenarios ask through the faux model with
`tool automation {...}` on the main chat, and the stack's real alarm fires the run.

| Feature | Scenario | What it checks |
| --- | --- | --- |
| Run now on the cloud reports to the main chat | `automation-run` | `create` then `run` gives one task `a-<id>-<slot>` with source `automation:<id>` that ends done, and `[automation "Harness digest" result: tell the user] echo: …` reaches the main chat |
| A machine automation runs once on the real runner | `automation-machine` | on machine `auto`, the run is one task on that machine that ends done, fake claude ran it once, and its report (naming the task) reaches the main chat |

By hand on a running stack, in the browser or with the harness client, send the main chat:

```text
tool automation {"action":"create","title":"Digest","prompt":"digest the news","cron":"0 9 * * *"}
tool automation {"action":"run","id":"<id from the answer>"}
tool automation {"action":"list","all":true}
```

Not driven here, because they need control of the Durable Object's alarm or eviction, which only the worker
tests have (`src/tests/automations.test.ts`): a slot delivered twice, eviction, re-booking on start, skipping
a slot while the last run works, pause/resume/update/archive/delete, one-offs ending done, and reports to a side chat.
