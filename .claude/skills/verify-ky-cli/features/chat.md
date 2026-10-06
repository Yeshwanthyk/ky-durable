# Chat

| Feature | Scenario | What it checks |
| --- | --- | --- |
| A turn streams the answer | `chat` | `echo: <prompt>` reaches the socket; hello lists the tools |
| A side chat hears its own task's report | `side-chat-report` | the report lands in the side chat, not the main one |

By hand: submit any text; the faux model answers `echo: <text>`. `tool NAME JSON` calls a tool (`src/tests/stack.ts`).
