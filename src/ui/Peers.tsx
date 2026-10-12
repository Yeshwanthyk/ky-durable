import { createContext, type FormEvent, useCallback, useContext, useEffect, useState } from "react";
import type { PeerInvite, PeerView } from "../protocol";
import { CopyLine } from "./CopyButton";
import { Icon } from "./Icon";
import { Problem } from "./Subscriptions";

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

const STATES: Record<PeerView["state"], string> = { on: "On", revoked: "Revoked: it unpaired", unreachable: "Unreachable" };

// Other people's kys this one is paired with: each checked with a call to it, an invite to give, and a form to pair with one.
export function Peers() {
  const actions = useContext(PeerContext);
  const [peers, setPeers] = useState<PeerView[] | null>(null);
  const reload = useCallback(() => actions.onList().then(setPeers), [actions]);

  useEffect(() => {
    reload().catch(() => setPeers([]));
  }, [reload]);

  const remove = async (name: string) => {
    await actions.onRemove(name);
    await reload();
  };

  const pair = async (name: string, address: string, code: string) => {
    const reason = await actions.onPair(name, address, code);

    if (!reason) await reload();

    return reason;
  };

  return (
    <>
      <section className="group" id="settings-peers">
        <h3 className="group-label">Paired</h3>
        <PeerList peers={peers} onRemove={remove} />
      </section>
      <section className="group">
        <h3 className="group-label">Invite someone's ky</h3>
        <InviteForm onInvite={actions.onInvite} />
      </section>
      <section className="group">
        <h3 className="group-label">Pair with someone's ky</h3>
        <PairForm onPair={pair} />
      </section>
    </>
  );
}

function PeerList({ peers, onRemove }: { peers: PeerView[] | null; onRemove: (name: string) => Promise<void> }) {
  if (peers === null) return <p className="group-empty">Checking peers…</p>;

  if (peers.length === 0) return <p className="group-empty">No peers yet. Invite someone's ky, or pair with theirs.</p>;

  return (
    <div className="card">
      {peers.map((peer) => (
        <div key={peer.name} className="row" data-peer={peer.name}>
          <span className="row-tile">
            <Icon name="nodes" size={15} />
          </span>
          <span className="row-text">
            <span className="row-label">{peer.name}</span>
            <span className="row-sub">
              {peer.address} · {STATES[peer.state]}
              {peer.detail ? ` (${peer.detail})` : ""}
            </span>
          </span>
          <button type="button" className="pill pressable" onClick={() => onRemove(peer.name)}>
            Remove
          </button>
          <span className="status-dot" data-connected={peer.state === "on"} />
        </div>
      ))}
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

/** A field in a peer form. */
function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <label className="row">
      <span className="row-label">{label}</span>
      <input
        className="key-input"
        aria-label={label}
        autoComplete="off"
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
  const [made, setMade] = useState<PeerInvite>();
  const [refused, setRefused] = useState<string>();

  const make = async (event: FormEvent) => {
    event.preventDefault();
    const result = await onInvite(name.trim());

    setRefused("refused" in result ? result.refused : undefined);
    setMade("refused" in result ? undefined : result);
  };

  return (
    <form className="automation-form key-form" aria-label="Invite a peer" onSubmit={make}>
      <div className="card">
        <Field label="Call their ky" value={name} onChange={setName} placeholder="A name for it here, like benky" />
        <Problem text={refused} />
        {made ? <Invite invite={made} /> : null}
        <div className="card-foot">
          <button type="submit" className="pill primary pressable" disabled={name.trim() === ""}>
            Make a code
          </button>
        </div>
      </div>
    </form>
  );
}

// The invite to send the other person: this ky's address and the code, as one line to copy.
function Invite({ invite }: { invite: PeerInvite }) {
  return (
    <div className="machine-code">
      <p className="group-note">Send them this. They paste it in Settings › Peers; it works once, within 10 minutes.</p>
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

    if (!reason) {
      setInvite("");
      setName("");
      setNamed(false);
    }
  };

  return (
    <form className="automation-form key-form" aria-label="Pair with a peer" onSubmit={pair}>
      <div className="card">
        <Field label="Their invite" value={invite} onChange={enter} placeholder="Paste what they sent you" />
        <Field
          label="Call their ky"
          value={name}
          onChange={(typed) => {
            setName(typed);
            setNamed(true);
          }}
          placeholder="A name for it here, like anaky"
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
