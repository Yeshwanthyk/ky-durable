------------------------------- MODULE Specialists -------------------------------
(* ky's specialist / profile design: specialists own a home sandbox, runners, a
   browser session, Vault logins and workflows. This is the FIXED design; each
   fix is marked (Fn). specialists_check.py explores the same machine exhaustively,
   with every fix toggleable, and prints the shortest trace for each broken
   invariant. Check with TLC:  java -cp tla2tools.jar tlc2.TLC -config Specialists.cfg Specialists *)
EXTENDS FiniteSets, TLC

CONSTANTS Ky, Fin, Res, Mac, Bank
Owners      == {Ky, Fin, Res}
Specialists == {Fin, Res}
Home        == [c \in Owners |-> IF c = Ky THEN "cloud" ELSE IF c = Fin THEN "sb_fin" ELSE "sb_res"]
Delegations == {<<Res, Ky>>, <<Res, Fin>>, <<Ky, Fin>>}

VARIABLES alive, grants, vault, sess, wf, run, macOn, tainted, inbox, last
vars == <<alive, grants, vault, sess, wf, run, macOn, tainted, inbox, last>>

None == "none"
Allowed(c) == {Home[c]} \cup (IF c \in grants THEN {Mac} ELSE {})

Init == /\ alive = Owners /\ grants = {} /\ vault = {} /\ sess = {}
        /\ wf = Fin /\ run = None /\ macOn = TRUE /\ tainted = {}
        /\ inbox = None /\ last = None

\* ---- the user: only the user grants, moves, reassigns, deletes ----
Grant(c)  == /\ c \in alive \cap Specialists /\ c \notin grants
             /\ grants' = grants \cup {c} /\ last' = None
             /\ UNCHANGED <<alive, vault, sess, wf, run, macOn, tainted, inbox>>
Revoke(c) == /\ c \in grants /\ grants' = grants \ {c}
             /\ run' = IF run # None /\ run.owner = c /\ run.machine = Mac THEN None ELSE run   \* (F1) revoke stops runs
             /\ last' = None /\ UNCHANGED <<alive, vault, sess, wf, macOn, tainted, inbox>>
Handoff(c) == /\ c \in alive \cap Specialists /\ c \notin vault
              /\ vault' = vault \cup {c} /\ sess' = sess \cup {c} /\ last' = None
              /\ UNCHANGED <<alive, grants, wf, run, macOn, tainted, inbox>>
MoveLogin(f, t) == /\ f # t /\ f \in vault /\ t \in alive /\ {f, t} \subseteq {Ky, Fin}
                   /\ vault' = (vault \ {f}) \cup {t}
                   /\ sess'  = (sess \ {f}) \cup {t}                                         \* (F2) moving a login ends sessions that held it
                   /\ last' = None /\ UNCHANGED <<alive, grants, wf, run, macOn, tainted, inbox>>
Reassign(t) == /\ t \in alive /\ t # wf /\ wf' = t /\ last' = None
               /\ UNCHANGED <<alive, grants, vault, sess, run, macOn, tainted, inbox>>
Delete(c) == /\ c \in alive \cap Specialists                                                  \* (F3) delete cleans everything it owned
             /\ alive' = alive \ {c} /\ grants' = grants \ {c} /\ vault' = vault \ {c} /\ sess' = sess \ {c}
             /\ run' = IF run # None /\ run.owner = c THEN None ELSE run
             /\ wf' = IF wf = c THEN Ky ELSE wf
             /\ inbox' = IF inbox # None /\ c \in {inbox.from, inbox.to} THEN None ELSE inbox
             /\ last' = None /\ UNCHANGED <<macOn, tainted>>

\* ---- the world ----
MacToggle == /\ macOn' = ~macOn /\ last' = None
             /\ UNCHANGED <<alive, grants, vault, sess, wf, run, tainted, inbox>>

\* ---- workflows: a run snapshots its owner's profile at start (F5); no silent fallback (F4) ----
StartRun(m) == /\ run = None /\ wf \in alive /\ m \in Allowed(wf) /\ (m = Mac => macOn)
               /\ run' = [owner |-> wf, machine |-> m] /\ last' = None
               /\ UNCHANGED <<alive, grants, vault, sess, wf, macOn, tainted, inbox>>
RunStep == /\ run # None
           /\ last' = [kind |-> "machine", actor |-> run.owner, res |-> run.machine, ok |-> TRUE, taint |-> FALSE]
           /\ UNCHANGED <<alive, grants, vault, sess, wf, run, macOn, tainted, inbox>>
FinishRun == /\ run # None /\ run' = None /\ last' = None
             /\ UNCHANGED <<alive, grants, vault, sess, wf, macOn, tainted, inbox>>

\* ---- specialist conversations ----
ReadWeb == /\ Res \in alive /\ tainted' = tainted \cup {Res} /\ last' = None
           /\ UNCHANGED <<alive, grants, vault, sess, wf, run, macOn, inbox>>
Delegate(f, t) == /\ <<f, t>> \in Delegations /\ {f, t} \subseteq alive /\ inbox = None
                  /\ inbox' = [from |-> f, to |-> t, taint |-> f \in tainted]                  \* (F6) the message carries its taint
                  /\ tainted' = IF f \in tainted THEN tainted \cup {t} ELSE tainted
                  /\ last' = None /\ UNCHANGED <<alive, grants, vault, sess, wf, run, macOn>>
BankWrite(c) == /\ c \in alive /\ c \in sess
                /\ last' = [kind |-> "bank", actor |-> c, res |-> Bank, ok |-> (c \in tainted), taint |-> (c \in tainted)]  \* (F7) a tainted write asks first
                /\ UNCHANGED <<alive, grants, vault, sess, wf, run, macOn, tainted, inbox>>
BankWriteFor == /\ inbox # None /\ inbox.to \in alive /\ inbox.to \in sess
                /\ LET t == inbox.taint \/ inbox.to \in tainted IN
                   last' = [kind |-> "bank", actor |-> inbox.to, res |-> Bank, ok |-> t, taint |-> inbox.taint]
                /\ inbox' = None /\ UNCHANGED <<alive, grants, vault, sess, wf, run, macOn, tainted>>
MachineCall(c) == /\ c \in alive /\ Mac \in Allowed(c)                                         \* (F8) the machine tool checks the profile
                  /\ last' = [kind |-> "machine", actor |-> c, res |-> Mac, ok |-> TRUE, taint |-> FALSE]
                  /\ UNCHANGED <<alive, grants, vault, sess, wf, run, macOn, tainted, inbox>>

Next == \/ \E c \in Owners : Grant(c) \/ Revoke(c) \/ Handoff(c) \/ Reassign(c) \/ Delete(c) \/ BankWrite(c) \/ MachineCall(c)
        \/ \E f, t \in Owners : MoveLogin(f, t) \/ Delegate(f, t)
        \/ \E m \in {"cloud", "sb_fin", "sb_res", Mac} : StartRun(m)
        \/ MacToggle \/ RunStep \/ FinishRun \/ ReadWeb \/ BankWriteFor

Spec == Init /\ [][Next]_vars

\* ---- invariants ----
RunnerScope         == /\ (last # None /\ last.kind = "machine") => last.res \in Allowed(last.actor)
                       /\ (run # None /\ run.machine = Mac) => run.owner \in grants
SessionMatchesVault == sess \subseteq vault
NoStaleCookies      == (last # None /\ last.kind = "bank") => last.actor \in vault
NoLaundering        == (last # None /\ last.kind = "bank" /\ last.taint) => last.ok
DeadSpecialistIdle        == /\ (run # None => run.owner \in alive)
                       /\ ((last # None /\ last.kind = "machine") => last.actor \in alive)
NoOrphanWorkflow    == wf \in alive
\* NoSilentFallback and OneProfilePerRun hold by construction above (StartRun only picks
\* Allowed machines that are up; run.owner is fixed at start); specialists_check.py models their naive forms.
=============================================================================
