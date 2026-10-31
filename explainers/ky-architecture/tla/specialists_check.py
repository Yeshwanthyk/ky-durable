"""Exhaustive BFS model check of ky's specialist/profile design (mirrors Specialists.tla).

Run:  python3 -I specialists_check.py            # every fix off (naive), then every fix on
      python3 -I specialists_check.py --ablate   # each fix off alone, to show which invariant needs it
"""
import sys
from collections import deque, namedtuple

OWNERS = ("ky", "fin", "res")        # ky = default profile; fin holds the bank; res reads the web
SPECIALISTS = ("fin", "res")
HOME = {"ky": "cloud", "fin": "sb_fin", "res": "sb_res"}
RUNNER = "mac"                       # one paired Mac
SITE = "bank"
DELEGATIONS = {("res", "ky"), ("res", "fin"), ("ky", "fin")}

S = namedtuple("S", "alive grants vault sess wf run mac_on tainted inbox last")
# alive    frozenset of owner ids alive
# grants   frozenset of (owner, "mac")            runners the user granted
# vault    frozenset of (owner, site)             saved logins, scoped by owner
# sess     frozenset of (owner, site)             cookies loaded in an owner's live browser session
# wf       owner of workflow w1
# run      None | (owner_at_start, machine, owner_now_resolved)
# mac_on   runner online
# tainted  frozenset of owners whose conversation holds untrusted (web) text
# inbox    frozenset of (frm, to, tainted)        delegation messages ("ask @fin ...")
# last     None | (kind, actor, resource, approved, tainted, detail)  the last effect, for invariants


def init():
    return S(frozenset(OWNERS), frozenset(), frozenset(), frozenset(), "fin", None, True, frozenset(), frozenset(), None)


def allowed_machines(st, o):
    return {HOME[o]} | ({RUNNER} if o == "ky" or (o, "mac") in st.grants else set())   # ky has every Mac


def successors(st, fx):
    out = []
    def add(label, **kw):
        out.append((label, st._replace(last=kw.pop("last", None), **kw)))

    # ---- the user (only the user grants) ----
    for o in SPECIALISTS:
        if o in st.alive:
            if (o, "mac") not in st.grants:
                add(f"Grant({o},mac)", grants=st.grants | {(o, "mac")})
            else:
                g = st.grants - {(o, "mac")}
                run = st.run
                if fx["revoke_stops_runs"] and run and run[0] == o and run[1] == RUNNER:
                    run = None
                add(f"Revoke({o},mac)", grants=g, run=run)
            if (o, SITE) not in st.vault:   # a hand-off saves the login into o's scope and o's session
                add(f"HandoffLogin({o})", vault=st.vault | {(o, SITE)}, sess=st.sess | {(o, SITE)})
    for frm in ("ky", "fin"):
        for to in ("ky", "fin"):
            if frm != to and (frm, SITE) in st.vault and to in st.alive:
                sess = st.sess
                if fx["move_ends_sessions"]:
                    sess = sess - {(frm, SITE)}
                add(f"MoveLogin({frm}->{to})", vault=(st.vault - {(frm, SITE)}) | {(to, SITE)}, sess=sess | {(to, SITE)})
    for to in OWNERS:
        if to != st.wf and to in st.alive:
            add(f"ReassignWorkflow({to})", wf=to)
    for o in SPECIALISTS:
        if o in st.alive:
            kw = dict(alive=st.alive - {o})
            if fx["delete_cleans"]:
                kw.update(grants=frozenset(g for g in st.grants if g[0] != o),
                          vault=frozenset(v for v in st.vault if v[0] != o),
                          sess=frozenset(s for s in st.sess if s[0] != o),
                          run=None if st.run and st.run[0] == o else st.run,
                          wf="ky" if st.wf == o else st.wf,
                          inbox=frozenset(m for m in st.inbox if o not in (m[0], m[1])))
            add(f"DeleteSpecialist({o})", **kw)

    # ---- the world ----
    add("MacToggle", mac_on=not st.mac_on)

    # ---- automations: start, step, finish ----
    if st.run is None:
        o = st.wf
        if o in st.alive or not fx["delete_cleans"]:
            for m in sorted(allowed_machines(st, o)):
                if m == RUNNER and not st.mac_on:
                    continue
                add(f"StartRun({o}@{m})", run=(o, m, o))
            if (o, "mac") in st.grants and not st.mac_on and not fx["no_silent_fallback"]:
                add(f"StartRunFallback({o})", run=(o, HOME[o], o),
                    last=("fallback", o, HOME[o], False, False, "runner offline"))
    else:
        start_owner, m, _ = st.run
        resolved = start_owner if fx["profile_snapshot"] else st.wf   # who the profile service says owns the run now
        add(f"RunStep({resolved}@{m})", run=(start_owner, m, resolved),
            last=("machine", resolved, m, True, False, f"started as {start_owner}"))
        add("FinishRun", run=None)

    # ---- specialist conversations ----
    for o in OWNERS:
        if o not in st.alive:
            continue
        if o == "res":
            add(f"ReadWeb({o})", tainted=st.tainted | {o})
        for to in OWNERS:
            if (o, to) in DELEGATIONS and to in st.alive and not st.inbox:
                add(f"Delegate({o}->{to})", inbox=frozenset({(o, to, o in st.tainted)}),
                    tainted=st.tainted | ({to} if fx["taint_propagates"] and o in st.tainted else set()))
        # o uses the bank through its own browser session: a write (pay, transfer)
        if (o, SITE) in st.sess:
            t = o in st.tainted
            needs_ok = fx["tainted_writes_ask"] and t
            add(f"BankWrite({o})", last=("bank", o, SITE, needs_ok, t, "own session"))
        # o tries to use the runner directly
        add(f"MachineCall({o}->mac)", last=("machine", o, RUNNER, True, False, "tool call")) if not fx["machine_tool_checks"] else None
        if fx["machine_tool_checks"] and RUNNER in allowed_machines(st, o):
            add(f"MachineCall({o}->mac)", last=("machine", o, RUNNER, True, False, "tool call"))
    # delegated work: the receiver acts on a message
    for (frm, to, t) in st.inbox:
        if to in st.alive and (to, SITE) in st.sess:
            carried = t if fx["delegation_carries_taint"] else False
            needs_ok = fx["tainted_writes_ask"] and (carried or to in st.tainted)
            add(f"BankWriteFor({frm}->{to})", inbox=st.inbox - {(frm, to, t)},
                last=("bank", to, SITE, needs_ok, t, f"asked by {frm}"))
    return out


def invariants(st):
    bad = []
    l = st.last
    if l:
        kind, actor, res, approved, tainted, detail = l
        if kind == "machine" and res not in allowed_machines(st, actor) and actor in st.alive:
            bad.append("I1 RunnerScope: work runs on a machine outside its owner's home+runners")
        if kind == "machine" and actor not in st.alive:
            bad.append("I7 DeadSpecialistIdle: a deleted specialist's run or call still uses a machine")
        if kind == "bank" and (actor, SITE) not in st.vault:
            bad.append("I3 NoStaleCookies: a browser session uses a login its owner no longer holds in the Vault")
        if kind == "bank" and tainted and not approved:
            bad.append("I4 NoLaundering: a bank write that untrusted web text led to ran without the user's OK")
        if kind == "fallback":
            bad.append("I5 NoSilentFallback: a workflow bound to a runner ran on another machine")
        if kind == "machine" and "started as" in detail and detail.split()[-1] != actor:
            bad.append("I6 OneProfilePerRun: a run changed owner (profile) midway")
    for (o, site) in st.sess:
        if (o, site) not in st.vault:
            bad.append("I2 SessionMatchesVault: a live session holds cookies its owner's Vault scope doesn't")
            break
    if st.run and st.run[0] not in st.alive:
        bad.append("I7 DeadSpecialistIdle: a deleted specialist still has a run going")
    if st.wf not in st.alive:
        bad.append("I8 NoOrphanWorkflow: a workflow is owned by a deleted specialist")
    if st.run and st.run[1] not in allowed_machines(st, st.run[0]) and st.run[0] in st.alive:
        bad.append("I1 RunnerScope: a run keeps going on a runner its owner was revoked from")
    return bad


def check(fx, limit=2_000_000):
    start = init()
    seen = {start: None}
    q = deque([start])
    found = {}
    while q:
        st = q.popleft()
        for label, nxt in successors(st, fx):
            for inv in invariants(nxt):
                if inv not in found:
                    found[inv] = (st, label)
            nxt = nxt._replace(last=None)
            if nxt not in seen:
                seen[nxt] = (st, label)
                q.append(nxt)
                if len(seen) > limit:
                    raise SystemExit("state limit")
    return found, seen


def trace(seen, st):
    steps = []
    while seen[st] is not None:
        st, label = seen[st]
        steps.append(label)
    return list(reversed(steps))


FIXES = ["revoke_stops_runs", "move_ends_sessions", "delete_cleans", "no_silent_fallback",
         "profile_snapshot", "taint_propagates", "delegation_carries_taint", "tainted_writes_ask", "machine_tool_checks"]


def report(name, fx):
    found, seen = check(fx)
    print(f"\n== {name}: {len(seen)} states, {len(found)} invariant(s) broken")
    for inv, (st, label) in sorted(found.items()):
        print(f"  ✗ {inv}\n      shortest trace: {' → '.join(trace(seen, st) + [label])}")
    return found


if __name__ == "__main__":
    report("naive (every fix off)", {f: False for f in FIXES})
    report("fixed (every fix on)", {f: True for f in FIXES})
    if "--ablate" in sys.argv:
        for f in FIXES:
            fx = {g: True for g in FIXES}; fx[f] = False
            found, _ = check(fx)
            print(f"  without {f:26s} → breaks: {', '.join(sorted(i.split(':')[0] for i in found)) or 'nothing'}")
