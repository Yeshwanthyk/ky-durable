# Skills

Source: `src/skills.ts` (the `skill_view` and `skill_manage` tools, the library and its versions); `src/sockets.ts`
sends `skills` frames and takes `skill-change` and `skill-history` commands.

| Feature | Scenario | What it checks |
| --- | --- | --- |
| The agent writes a skill and it shows in the list | `skills` | a `skills` frame carries it after `tool skill_manage {"action":"create",…}` |
| The user edits a skill | `skills` | a `skill-change` patch shows in the next `skills` frame |
| Every chat shares the library | `skills` | a side chat's `skill_view` reads the user's edit |
| Each version is kept with who made it | `skills` | `skill-history` lists versions by `agent` and by `user` |

Not driven here: the background review after a busy turn (it needs five tool calls and a forked model reply; the
worker test `skills.test.ts` covers it), and the Skills panel (`verify-ky-web`).
