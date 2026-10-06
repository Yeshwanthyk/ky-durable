# Features the CLI harness drives

Each file lists the features of one area, the scenario that drives each, and how to drive it by hand on a running stack.
Run a whole area with `pnpm harness <scenario...>`.

| Area | File | Scenarios |
| --- | --- | --- |
| Chat | [chat.md](chat.md) | `chat`, `side-chat-report` |
| Machine tasks | [machines.md](machines.md) | `machine-run`, `steps`, `follow-up`, `steer-folded`, `stop`, `screenshot`, `reconnect`, `reconnect-outage`, `trap-*` |
| Skills | [skills.md](skills.md) | `skills` |
| Automations | [automations.md](automations.md) | `automation-run`, `automation-machine` |
