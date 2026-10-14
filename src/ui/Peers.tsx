import { createContext, type FormEvent, useCallback, useContext, useEffect, useState } from "react";
import type { PeerInvite, PeerView } from "../protocol";
import { CopyLine } from "./CopyButton";
import { Icon } from "./Icon";
import { Problem } from "./Subscriptions";
import { clock } from "./time";
import { useNow } from "./use-now";

type PeerActions = {
  readonly onList: () => Promise<PeerView[]>;
  readonly onInvite: (name: string) => Promise<PeerInvite | { refused: string }>;
  /** Each resolves with why it was refused, if it was. */
  readonly onPair: (name: string, address: string, code: string) => Promise<string | undefined>;
  readonly onRemove: (name: string) => Promise<string | undefined>;
};

/** What Settings › Peers does; provided around the panel. */
export const PeerContext = createContext<PeerActions>({
  onList: async () => [],
  onInvite: async () => ({ refused: "Not connected." }),
  onPair: async () => "Not connected.",
  onRemove: async () => "Not connected."
});

/** How long an invite works: src/peers.ts INVITE_TTL_MS. */
const INVITE_TTL_MS = 10 * 60_000;

const STATES: Record<PeerView["state"], string> = { on: "Paired", revoked: "They unpaired", unreachable: "Not answering" };

/** Which way the user is adding a peer: making an invite, or pasting one. */
type Adding = "invite" | "pair" | null;

// Other people's kys this one is paired with, each checked with a call to it, and adding one: an invite to give, or one to paste.
export function Peers() {
  const actions = useContext(PeerContext);
  const [peers, setPeers] = useState<PeerView[] | null>(null);
  const [adding, setAdding] = useState<Adding>(null);
  const reload = useCallback(() => actions.onList().then(setPeers), [actions]);

  useEffect(() => {
    reload().catch(() => setPeers([]));
  }, [reload]);

  const remove = async (name: string) => {
    const reason = await actions.onRemove(name);

    await reload();

    return reason;
  };

  const pair = async (name: string, address: string, code: string) => {
    const reason = await actions.onPair(name, address, code);

    if (!reason) {
      setAdding(null);
      await reload();
    }

    return reason;
  };

  const choose = (next: Adding) => setAdding((current) => (current === next ? null : next));

  return (
    <>
      <section className="group" id="settings-peers">
        <h3 className="group-label">Paired</h3>
        <PeerList peers={peers} onRemove={remove} />
      </section>
      <section className="group">
        <h3 className="group-label">Add a peer</h3>
        <p className="group-note peer-how">One of you makes an invite and sends it; the other pastes it. Each names the other's ky its own way.</p>
        <div className="group-actions">
          <button type="button" className="pill pressable" aria-pressed={adding === "invite"} onClick={() => choose("invite")}>
            <Icon name="plus" size={14} />
            Invite someone
          </button>
          <button type="button" className="pill pressable" aria-pressed={adding === "pair"} onClick={() => choose("pair")}>
            <Icon name="nodes" size={14} />I have an invite
          </button>
        </div>
        {adding === "invite" ? <InviteForm onInvite={actions.onInvite} /> : null}
        {adding === "pair" ? <PairForm onPair={pair} /> : null}
      </section>
    </>
  );
}

/** A peer's address as the list shows it: the host, without the scheme. */
function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

function PeerList({ peers, onRemove }: { peers: PeerView[] | null; onRemove: (name: string) => Promise<string | undefined> }) {
  if (peers === null) return <p className="group-empty">Checking peers…</p>;

  if (peers.length === 0) return <p className="group-empty">No peers yet. Once you pair, ky can ask theirs, and theirs can ask ky.</p>;

  return (
    <div className="card">
      {peers.map((peer) => (
        <PeerRow key={peer.name} peer={peer} onRemove={onRemove} />
      ))}
    </div>
  );
}

// A peer: its name, where it is and whether it answers, and unpairing it once the user confirms.
function PeerRow({ peer, onRemove }: { peer: PeerView; onRemove: (name: string) => Promise<string | undefined> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();

  const remove = async () => {
    setBusy(true);
    const reason = await onRemove(peer.name);

    setBusy(false);
    setRefused(reason);
    setConfirming(false);
  };

  return (
    <div className="peer" data-peer={peer.name}>
      <div className="row">
        <span className="row-tile">
          <Icon name="nodes" size={15} />
        </span>
        <span className="row-text">
          <span className="row-label">{peer.name}</span>
          <span className="row-sub peer-sub">
            <span className="peer-state" data-state={peer.state} />
            <span className="row-sub-text" title={peer.detail}>
              {STATES[peer.state]} · {hostOf(peer.address)}
            </span>
          </span>
        </span>
        {confirming ? null : (
          <button type="button" className="automation-text pressable" aria-label={`Unpair ${peer.name}`} onClick={() => setConfirming(true)}>
            Unpair
          </button>
        )}
      </div>
      {peer.state === "unreachable" && peer.detail ? <p className="group-note peer-detail">{peer.detail}</p> : null}
      {confirming ? (
        <div className="machine-confirm peer-confirm" role="alertdialog" aria-label={`Unpair ${peer.name}`}>
          <p>Unpair {peer.name}? Neither ky can ask the other anything until you pair again.</p>
          <div className="machine-confirm-actions">
            <button type="button" className="automation-text pressable" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="machine-unpair-confirm pressable" disabled={busy} onClick={() => void remove()}>
              Unpair
            </button>
          </div>
        </div>
      ) : null}
      <Problem text={refused} />
    </div>
  );
}

/** What to call the ky at `address`, by its first label: "ky-mp-a" for https://ky-mp-a.example.workers.dev; "" if none fits. */
function nameFor(address: string): string {
  try {
    const label = new URL(address.trim()).hostname.split(".")[0] ?? "";

    return label
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+/, "")
      .slice(0, 32);
  } catch {
    return "";
  }
}

// What this ky calls theirs: lowercase letters, digits and dashes, as the server checks.
function NameField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="row">
      <span className="row-text">
        <span className="row-label">Name</span>
        <span className="row-sub">What ky calls theirs</span>
      </span>
      <input
        className="key-input peer-name"
        aria-label="Name for their ky"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function InviteForm({ onInvite }: { onInvite: PeerActions["onInvite"] }) {
  const [name, setName] = useState("");
  const [made, setMade] = useState<{ invite: PeerInvite; expiresAt: number }>();
  const [making, setMaking] = useState(false);
  const [refused, setRefused] = useState<string>();

  const make = async (event: FormEvent) => {
    event.preventDefault();
    setMaking(true);
    const result = await onInvite(name.trim());

    setMaking(false);
    setRefused("refused" in result ? result.refused : undefined);
    setMade("refused" in result ? undefined : { invite: result, expiresAt: Date.now() + INVITE_TTL_MS });
  };

  return (
    <form className="automation-form key-form" aria-label="Invite a peer" onSubmit={make}>
      <div className="card">
        <NameField value={name} onChange={setName} placeholder="benky" />
        <Problem text={refused} />
        {made ? <Invite invite={made.invite} expiresAt={made.expiresAt} /> : null}
        <div className="card-foot">
          <button type="submit" className="pill primary pressable" disabled={making || name.trim() === ""}>
            {made ? "New invite" : "Make invite"}
          </button>
        </div>
      </div>
    </form>
  );
}

// The invite to send the other person: this ky's address and the code, as one line to copy, until it expires.
function Invite({ invite, expiresAt }: { invite: PeerInvite; expiresAt: number }) {
  const now = useNow();

  if (expiresAt <= now) return <p className="group-note peer-invite">That invite has expired. Make a new one.</p>;

  return (
    <div className="machine-code peer-invite">
      <p className="group-note">
        Send them this. They choose <b>I have an invite</b> in Settings › Peers and paste it. It works once, until {clock(expiresAt)}.
      </p>
      <CopyLine text={`${invite.address} ${invite.code}`} label="Invite" />
    </div>
  );
}

/** The address and code in a pasted invite, which is the two separated by spaces or a line break. */
function parse(invite: string) {
  const [address = "", code = ""] = invite.trim().split(/\s+/);

  return { address, code };
}

function PairForm({ onPair }: { onPair: PeerActions["onPair"] }) {
  const [invite, setInvite] = useState("");
  const [name, setName] = useState("");
  // Until the user names it, the name follows the invite's address.
  const [named, setNamed] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [refused, setRefused] = useState<string>();
  const { address, code } = parse(invite);

  const enter = (typed: string) => {
    setInvite(typed);

    if (!named) setName(nameFor(parse(typed).address));
  };

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    setPairing(true);
    const reason = await onPair(name.trim(), address, code);

    setRefused(reason);
    setPairing(false);
  };

  return (
    <form className="automation-form key-form" aria-label="Pair with a peer" onSubmit={pair}>
      <div className="card">
        <label className="row peer-paste">
          <span className="row-label">Their invite</span>
          <textarea
            className="key-input"
            aria-label="Their invite"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            rows={3}
            placeholder="Paste what they sent you: an address and a code"
            value={invite}
            onChange={(event) => enter(event.target.value)}
          />
        </label>
        <NameField
          value={name}
          onChange={(typed) => {
            setName(typed);
            setNamed(true);
          }}
          placeholder="anaky"
        />
        <Problem text={refused} />
        <div className="card-foot">
          <button type="submit" className="pill primary pressable" disabled={pairing || [name, address, code].some((each) => each.trim() === "")}>
            {pairing ? "Pairing…" : "Pair"}
          </button>
        </div>
      </div>
    </form>
  );
}
