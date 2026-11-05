---- MODULE Chats ----
\* Chats that message each other. Models the chats tool's sends (src/chats/tool.ts: `call`, `steer`, `create`, with
\* `notify`), the notice its onYield hook sends back (src/chats/tool.ts: `tellWaiting`), the harness's queue and
\* request-id dedupe (pi-durable `submit` with `whenBusy: "steer"`), and `startedByUser` (src/history/wiring.ts).
\* `ui` is the chart variable: each chat's node on chart.viz.
EXTENDS Naturals, FiniteSets
CONSTANTS Chats, Main, Kid, MaxUser, MaxSends, Break
\* MaxSends bounds the sends of all chats together; MaxUser the user's messages, written in the main chat or Reading.
\* Break is "none" for the code. Every other value is a broken variant, one per property, that the check must catch:
\*   "notifyAnyTurn"  notify accepted in a turn the user did not start (the userStarted check on notify dropped)
\*   "sendAnyTurn"    a send to a chat this one did not open accepted in any turn (NotTheUsersTurn dropped)
\*   "freshNoticeId"  the notice's request id is not derived from the send's, so a rerun hook sends it again
\*   "noTakenCheck"   the hook tells the sender on any answer, before the other chat took the message in

VARIABLES
  ui,        \* chat -> chart node: quiet, or the kind of the newest message placed in its running turn
  depth,     \* chat -> hops from a user's message to the newest message placed in it (0: the user's own)
  inbox,     \* chat -> messages submitted but not yet placed (harness queue, whenBusy: "steer")
  placed,    \* chat -> request ids placed in it (pi_submissions status 'placed'; what `taken` reads)
  submitted, \* chat -> request ids ever submitted to it (the harness dedupes a repeated requestId)
  waits,     \* ky_chat_waits rows: [id: the send's request id, target, sender, depth: the send's hops]
  noticed,   \* send request id -> notices actually submitted for it
  sends,     \* sends made by all chats; numbers each send's request id (`chat-steer:<from>:<task>`)
  users,     \* user messages so far
  answering, \* chat -> its run yielded a final answer and onYield is running (before the harness commits it)
  early      \* a notice went out before the other chat took the message in

vars == <<ui, depth, inbox, placed, submitted, waits, noticed, sends, users, answering, early>>

\* ky_chats.opened_by: Kid was opened by Main (chats create); the main chat and Reading by nobody.
OpenedBy(c) == IF c = Kid THEN Main ELSE "none"

SendIds == {<<"steer", c, k>> : c \in Chats, k \in 0..(MaxSends - 1)}

Writers == Chats \ {Kid}

Init == /\ ui = [c \in Chats |-> "quiet"]
        /\ depth = [c \in Chats |-> 0]
        /\ inbox = [c \in Chats |-> {}]
        /\ placed = [c \in Chats |-> {}]
        /\ submitted = [c \in Chats |-> {}]
        /\ waits = {}
        /\ noticed = [id \in SendIds |-> 0]
        /\ sends = 0
        /\ users = 0
        /\ answering = [c \in Chats |-> FALSE]
        /\ early = FALSE

\* startedByUser: the newest pi.user entry placed in the chat is the user's own (a UUID request id).
Authority(c) == ui[c] = "yours"

\* The user writes in a chat: a UUID request id, depth 0.
Write(c) == /\ users < MaxUser /\ c \in Writers
            /\ inbox' = [inbox EXCEPT ![c] = @ \cup {[id |-> <<"user", users>>, kind |-> "yours", depth |-> 0]}]
            /\ submitted' = [submitted EXCEPT ![c] = @ \cup {<<"user", users>>}]
            /\ users' = users + 1
            /\ UNCHANGED <<ui, depth, placed, waits, noticed, sends, answering, early>>

\* A boundary places every queued message in one commit; which one is newest is left open. Start: a quiet chat's
\* queue starts its next run. Join: a running chat takes the queue at its next request (not while yielding, when the
\* queue instead starts the next run after Answer).
Place(c, newest) == /\ placed' = [placed EXCEPT ![c] = @ \cup {m.id : m \in inbox[c]}]
                    /\ depth' = [depth EXCEPT ![c] = newest.depth]
                    /\ ui' = [ui EXCEPT ![c] = newest.kind]
                    /\ inbox' = [inbox EXCEPT ![c] = {}]
                    /\ UNCHANGED <<submitted, waits, noticed, sends, users, answering, early>>

Start(c) == /\ ui[c] = "quiet"
            /\ \E m \in inbox[c] : Place(c, m)

Join(c) == /\ ui[c] # "quiet" /\ ~answering[c]
           /\ \E m \in inbox[c] : Place(c, m)

\* The chats tool's steer (and create, to a chat this one opens): src/chats/tool.ts `call` then `steer`/`create`.
\* The wait row is written before the message is submitted, so the other chat cannot answer it unseen.
Send(c, to, notify) ==
  /\ ui[c] # "quiet" /\ ~answering[c]
  /\ OpenedBy(c) = "none"                                        \* OpenedByAnother
  /\ to # c                                                      \* ThisChat
  /\ sends < MaxSends
  /\ OpenedBy(to) = c \/ Authority(c) \/ Break = "sendAnyTurn"   \* NotTheUsersTurn
  /\ notify => (Authority(c) \/ Break = "notifyAnyTurn")         \* NoticeNotTheUsersTurn
  /\ LET id == <<"steer", c, sends>> IN
       /\ waits' = IF notify THEN waits \cup {[id |-> id, target |-> to, sender |-> c, depth |-> depth[c] + 1]} ELSE waits
       /\ inbox' = [inbox EXCEPT ![to] = @ \cup {[id |-> id, kind |-> "asked", depth |-> depth[c] + 1]}]
       /\ submitted' = [submitted EXCEPT ![to] = @ \cup {id}]
  /\ sends' = sends + 1
  /\ UNCHANGED <<ui, depth, placed, noticed, users, answering, early>>

\* The model yields a final answer; onYield hooks run before the harness commits it (pi-durable generation `answer`).
Yield(c) == /\ ui[c] # "quiet" /\ ~answering[c]
            /\ answering' = [answering EXCEPT ![c] = TRUE]
            /\ UNCHANGED <<ui, depth, inbox, placed, submitted, waits, noticed, sends, users, early>>

\* tellWaiting, one wait row: tell the sender, with what this chat answered. The notice is one hop past the send it
\* answers, whatever the chat took in since. A crash before the commit reruns the
\* hook, so this step can repeat; the harness drops a request id it already has. Bound: two submissions per send.
Notify(c, w) ==
  /\ answering[c] /\ w \in waits /\ w.target = c
  /\ w.id \in placed[c] \/ Break = "noTakenCheck"
  /\ noticed[w.id] < 2
  /\ LET nid == IF Break = "freshNoticeId" THEN <<"notice", w.id, noticed[w.id]>> ELSE <<"notice", w.id>> IN
       IF nid \in submitted[w.sender]
       THEN UNCHANGED <<inbox, submitted, noticed, early>>
       ELSE /\ inbox' = [inbox EXCEPT ![w.sender] = @ \cup {[id |-> nid, kind |-> "told", depth |-> w.depth + 1]}]
            /\ submitted' = [submitted EXCEPT ![w.sender] = @ \cup {nid}]
            /\ noticed' = [noticed EXCEPT ![w.id] = @ + 1]
            /\ early' = (early \/ w.id \notin placed[c])
  /\ UNCHANGED <<ui, depth, placed, waits, sends, users, answering>>

\* tellWaiting, after the notice is submitted: the row goes.
Settle(c, w) == /\ answering[c] /\ w \in waits /\ w.target = c /\ noticed[w.id] >= 1
                /\ waits' = waits \ {w}
                /\ UNCHANGED <<ui, depth, inbox, placed, submitted, noticed, sends, users, answering, early>>

\* The harness commits the answer and ends the run. It may do so with hook work undone (the hook lost to a crash it
\* does not rerun): the row stays and fires on the chat's next answer.
Answer(c) == /\ answering[c]
             /\ answering' = [answering EXCEPT ![c] = FALSE]
             /\ ui' = [ui EXCEPT ![c] = "quiet"]
             /\ UNCHANGED <<depth, inbox, placed, submitted, waits, noticed, sends, users, early>>

AllQuiet == \A c \in Chats : ui[c] = "quiet" /\ inbox[c] = {} /\ ~answering[c]

Noticed == {id \in SendIds : noticed[id] > 0}

Done == AllQuiet /\ UNCHANGED vars

Next == \/ \E c \in Chats : Write(c) \/ Start(c) \/ Join(c) \/ Yield(c) \/ Answer(c)
        \/ \E c, to \in Chats, notify \in BOOLEAN : Send(c, to, notify)
        \/ \E c \in Chats, w \in waits : Notify(c, w) \/ Settle(c, w)
        \/ Done

\* Harm: chats keep waking each other after the user's message. Every message is at most three hops from one the user
\* wrote: their chat sends (1), the answer comes back (2), that chat steers one it opened (3), which sends nothing.
BoundedChain == \A c \in Chats : depth[c] <= 3 /\ \A m \in inbox[c] : m.depth <= 3

\* Harm: the same answer comes back to the asking chat twice.
NoticeOnce == \A id \in SendIds : noticed[id] <= 1

\* Harm: the asking chat is told the other chat answered before that chat ever took the message in.
NoticeAfterAnswer == ~early
====
