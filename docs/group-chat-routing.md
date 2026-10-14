# Specialists in chat: @-mentions and group chats

The user can talk to specialists directly in the main chat or a side chat. A message that starts with `@id` goes to
that specialist. In a group chat (a chat with specialists as members), a message with no `@` goes to the members it
is relevant to. Each specialist posts its own reply, under its name and blob. ky doesn't paraphrase it.
The code is in `src/peers/group.ts`. This note covers why it is shaped the way it is.

## What others do

- **AutoGen GroupChat / SelectorGroupChat.** A manager picks the next speaker each round: an LLM pick (`auto`),
  `round_robin`, `random`, or a custom function. `max_round` (default 10) is the hard stop, and returning `None`
  ends the chat. AutoGen 0.4's selector won't pick the same speaker twice in a row by default. Lesson: the
  speaker-selection step is where you control who talks. Every multi-turn design also needs a hard round cap,
  because agents answering agents will otherwise go on.
- **LangGraph supervisor.** A supervisor routes to workers, and workers hand control back. Loops show up when the
  supervisor never converges or two agents keep handing off to each other. `recursion_limit` (default 25) turns
  a runaway into an exception. People who run these in production add an iteration counter, a timeout, and
  detection of repeated routing on top. Lesson: a cap is a backstop, not the design. Make the loop impossible
  instead.
- **CrewAI hierarchical.** Only the manager should delegate (`allow_delegation=False` on workers). Workers that can
  delegate end up in "delegation ping-pong". `max_iter` and `max_execution_time` cap each agent. Lesson: give
  delegation to one party.
- **Slack / Discord bots.** The standard rule is `if message.author.bot: return`: bots ignore bot messages. A bot
  that answers messages will otherwise answer itself, or another bot, forever. Good bots respond only when invoked
  explicitly (a prefix or an @-mention), and fail silently on things not for them, so two bots can't set each other
  off. Lesson: only human messages trigger anything.

Sources: [AG2 GroupChat](https://docs.ag2.ai/latest/docs/api-reference/autogen/GroupChat/),
[AutoGen SelectorGroupChat](https://microsoft.github.io/autogen/dev//user-guide/agentchat-user-guide/selector-group-chat.html),
[AutoGen 0.2 conversation patterns](https://microsoft.github.io/autogen/0.2/docs/tutorial/conversation-patterns/),
[Preventing infinite loops in multi-agent LangGraph](https://www.c-sharpcorner.com/article/preventing-infinite-loops-in-enterprise-multi-agent-langgraph-systems2/),
[LangGraph cycles](https://rajatpandit.com/ai-engineering/optimizing-langgraph-cycles/),
[CrewAI hierarchical process](https://docs.crewai.com/en/learn/hierarchical-process),
[CrewAI delegation ping-pong](https://azguards.com/technical/the-delegation-ping-pong-breaking-infinite-handoff-loops-in-crewai-hierarchical-topologies/),
[discord.py: bots ignore bots](https://github.com/Rapptz/discord.py/issues/6579),
[Discord bot best practices](https://github.com/Lord-Ptolemy/discord-bot-best-practices).

## The rules ky follows

1. **Only user messages are routed.** Routing happens in one place: `PiSessionSockets.#submit`, on a message a
   user's socket sent to the main chat or a side chat. Nothing else calls `GroupDesk.submit`: not a reply, not a
   report, not ky. This is the "bots ignore bots" rule, enforced by where the code sits rather than by a flag.
2. **Replies start nothing.** The user's message to specialists and each specialist's reply are *passive* entries
   (`Conversation.submit({ type: "write" })`). pi-durable appends them without starting a run. ky reads them on
   its next turn as context, marked `[for @a, @b]` and `[@a replied to the user]`, and its prompt says they were
   answered already. While ky is busy they queue for the next boundary, so they never land between a tool call
   and its result.
3. **No agent-to-agent.** Each specialist answers in its seat for that chat, a conversation of its own
   (`ky_specialist_seats`). The seat has no `subagent` tool: the extension is removed. The specialist hook also
   blocks it, in case it ever comes back. So a specialist in a chat cannot ask, consult or start another agent.
   This is CrewAI's "workers don't delegate".
4. **Hard cap: 3 responders per user message** (`RESPONDER_CAP`). More than 3 leading `@id`s is refused with a
   message. The router's answer is filtered to the chat's members, deduplicated, and cut to 3. Its prompt says most
   messages need one or none.
5. **Cheap routing, and ky when none fit.** One request to the background model (the titles model): the members'
   ids and descriptions, the last few messages, and the message. It answers with ids or `none`. If the call fails or
   picks no one, the message goes to ky as usual. A chat with no members, or a message with a leading `@`, is never
   routed.
6. **Independent, parallel answers.** Every responder gets the same snapshot of the chat, taken before any of them
   starts. Each runs in its own seat, at the same time, and none sees another's in-flight reply. There is one round
   per user message. A specialist replies only to the user, never to another specialist's reply.
7. **A budget per reply.** Each reply has `REPLY_TIMEOUT_MS` (4 minutes). After that its seat is stopped, and the
   chat shows that it ran out of time. Each reply is a task in Activity, where Stop works too. A stopped or failed
   reply is posted as a short note, so the chat never waits forever.
8. **Dedupe.** A message is decided once, by the operation id the client sends with it (and resends after a
   reconnect): `ky_group_messages` keeps the first decision, so a resend is never routed again. Every write after
   that carries a request id: the user's entry, each seat's submission, and each reply. pi-durable takes each
   request id once, so a resend, or a start cut short and started again, posts once.

## Known gaps

- If ky is mid-run when a group message arrives, the message and the replies are placed at ky's next boundary, so
  they can show inside ky's running turn rather than after it.
- A seat sees the last 8 messages of the chat, cut to 3,000 characters. It doesn't see older history unless it
  answered there before (its seat remembers its own exchanges in that chat).
- Routing reads descriptions only, not briefs. A vague description makes for a vague pick.
