# Skills

Source: `src/skills/skills.ts` (the `skill_view` and `skill_manage` tools, the library and its versions, the background
review); `src/dreaming/dreaming.ts` (the nightly dream); `src/sockets.ts` sends `skills` frames and takes `skill-change` and
`skill-history` commands.

| Feature | Scenario | What it checks |
| --- | --- | --- |
| The agent writes a skill and it shows in the list | `skills` | a `skills` frame carries it after `tool skill_manage {"action":"create",…}` |
| The user edits a skill | `skills` | a `skill-change` patch shows in the next `skills` frame |
| Every chat shares the library | `skills` | a side chat's `skill_view` reads the user's edit |
| Each version is kept with who made it | `skills` | `skill-history` lists versions by `agent` and by `user` |

| A busy turn is reviewed for skills in the background | `skill-review` | after `POST /test/review-after?n=1`, a turn with one tool call adds a `skills` task row titled `Skill review` that ends `done` |
| A dream reads what happened and shows one Activity row | `dreaming` | after a `memory_note`, `POST /test/dream` adds a `dreaming` row titled `Dreaming`, `done`, whose summary starts `echo: [dream]` |
| A dream with nothing new does nothing | `dreaming` | a second `POST /test/dream` adds no row |

By hand on a running stack:

```sh
curl -fsS -X POST -H 'Authorization: Bearer ky-stack-token' 'http://127.0.0.1:8790/test/review-after?n=1'
curl -fsS -X POST -H 'Authorization: Bearer ky-stack-token' 'http://127.0.0.1:8790/test/dream'
```

`/test/review-after` lasts until the stack restarts; send `n=5` to put back the default. `/test/dream` answers once
the dream ends.

Not driven here, but covered by the worker test `skills.test.ts`: the review and the dream wake with memory, the tools
each may call, the 04:00 UTC booking, and the dream's own changes left out of the next digest. The Skills panel is
`verify-ky-web`'s.
