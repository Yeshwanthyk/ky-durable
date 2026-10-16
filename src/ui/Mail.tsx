import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { MailItem, MailView } from "../protocol";
import { CopyLine } from "./CopyButton";
import { Icon } from "./Icon";
import { Problem } from "./Subscriptions";
import { ago } from "./time";
import { useNow } from "./use-now";

type MailActions = {
  readonly onView: () => Promise<MailView>;
  /** Each resolves with why it was refused, if it was. */
  readonly onApprove: (mail: string) => Promise<string | undefined>;
  readonly onDiscard: (mail: string) => Promise<string | undefined>;
  readonly onDisallow: (address: string) => Promise<string | undefined>;
};

/** What Settings › Mail does; provided around the panel. */
export const MailContext = createContext<MailActions>({
  onView: async () => ({ address: null, held: [], recent: [], allowed: [] }),
  onApprove: async () => "Not connected.",
  onDiscard: async () => "Not connected.",
  onDisallow: async () => "Not connected."
});

/** While the page is open, it looks for new mail this often. */
const REFRESH_MS = 15_000;

const STATES: Record<MailItem["state"], string> = {
  new: "Reading",
  triaged: "Read",
  kept: "Kept",
  held: "Waiting for you",
  discarded: "Discarded",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed"
};

// ky's own address, the mail it wrote that waits for the user to send, the newest mail, and who it may write to.
export function Mail() {
  const actions = useContext(MailContext);
  const [view, setView] = useState<MailView | null>(null);
  const reload = useCallback(() => actions.onView().then(setView), [actions]);

  useEffect(() => {
    reload().catch(() => setView({ address: null, held: [], recent: [], allowed: [] }));
    const timer = setInterval(() => void reload().catch(() => undefined), REFRESH_MS);

    return () => clearInterval(timer);
  }, [reload]);

  if (view === null) return <p className="group-empty">Loading mail…</p>;

  if (view.address === null) return <NotSetUp />;

  const act = (work: (id: string) => Promise<string | undefined>) => async (id: string) => {
    const reason = await work(id);

    await reload();

    return reason;
  };

  return (
    <>
      <section className="group" id="settings-mail">
        <h3 className="group-label">Address</h3>
        <CopyLine text={view.address} label="Address" />
        <p className="group-note">Give it out as you would your own. ky reads what comes, and tells you what matters.</p>
      </section>
      {view.held.length > 0 ? (
        <section className="group">
          <h3 className="group-label">Waiting for you</h3>
          <div className="card">
            {view.held.map((mail) => (
              <HeldMail key={mail.id} mail={mail} onSend={act(actions.onApprove)} onDiscard={act(actions.onDiscard)} />
            ))}
          </div>
          <p className="group-note">ky asks before writing to someone new. Once you send one, it may write to them again.</p>
        </section>
      ) : null}
      <section className="group">
        <h3 className="group-label">Recent</h3>
        <RecentMail mail={view.recent} address={view.address} />
      </section>
      <section className="group">
        <h3 className="group-label">ky may write to</h3>
        <Allowed allowed={view.allowed} onRemove={act(actions.onDisallow)} />
      </section>
    </>
  );
}

// What a deploy needs before ky has an address: a domain on Email Service, a routing rule, and two lines of config.
function NotSetUp() {
  return (
    <section className="group" id="settings-mail">
      <h3 className="group-label">Address</h3>
      <div className="card">
        <div className="row">
          <span className="row-tile">
            <Icon name="mail" size={15} />
          </span>
          <span className="row-text">
            <span className="row-label">Not set up</span>
            <span className="row-sub">ky needs a domain on Cloudflare</span>
          </span>
          <span className="status-dot" />
        </div>
      </div>
      <ol className="group-note mail-steps">
        <li>
          Add your domain to Cloudflare, and turn on <b>Email Routing</b> and <b>Email Service › Email Sending</b> for it.
        </li>
        <li>
          Run <code>ky init --mail yourdomain.com</code>: ky gets <code>&lt;its name&gt;@yourdomain.com</code>, and the deploy routes that address to it.
        </li>
      </ol>
    </section>
  );
}

// A mail ky wrote to someone new: who and what, its text, and the user's Send or Discard.
function HeldMail({ mail, onSend, onDiscard }: { mail: MailItem; onSend: (id: string) => Promise<string | undefined>; onDiscard: (id: string) => Promise<string | undefined> }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();

  const run = async (work: (id: string) => Promise<string | undefined>) => {
    setBusy(true);
    setRefused(await work(mail.id));
    setBusy(false);
  };

  return (
    <div className="mail-held" data-mail={mail.id}>
      <div className="row">
        <span className="row-tile">
          <Icon name="send" size={15} />
        </span>
        <span className="row-text">
          <span className="row-label">{mail.subject}</span>
          <span className="row-sub row-sub-text">To {mail.party}</span>
        </span>
      </div>
      <p className="mail-preview">{mail.preview}</p>
      <div className="machine-confirm-actions mail-held-actions">
        <button type="button" className="automation-text pressable" disabled={busy} onClick={() => void run(onDiscard)}>
          Discard
        </button>
        <button type="button" className="pill primary pressable" disabled={busy} onClick={() => void run(onSend)}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      <Problem text={refused} />
    </div>
  );
}

function RecentMail({ mail, address }: { mail: readonly MailItem[]; address: string }) {
  const now = useNow();

  if (mail.length === 0) return <p className="group-empty">No mail yet. What comes to {address} shows here.</p>;

  return (
    <div className="card">
      {mail.map((each) => (
        <div key={each.id} className="row mail-row" data-direction={each.direction}>
          <span className="row-tile">
            <Icon name={each.direction === "in" ? "mail" : "send"} size={15} />
          </span>
          <span className="row-text">
            <span className="row-label row-sub-text">{each.subject || "(no subject)"}</span>
            <span className="row-sub peer-sub">
              <span className="mail-state" data-state={each.state} />
              <span className="row-sub-text" title={each.note || each.preview}>
                {each.direction === "in" ? each.partyName || each.party : `To ${each.party}`} · {STATES[each.state]}
              </span>
            </span>
          </span>
          <span className="row-value">{ago(each.at, now)}</span>
        </div>
      ))}
    </div>
  );
}

function Allowed({ allowed, onRemove }: { allowed: readonly string[]; onRemove: (address: string) => Promise<string | undefined> }) {
  const [refused, setRefused] = useState<string>();

  if (allowed.length === 0) return <p className="group-empty">Only you, until you send a mail ky wrote to someone new.</p>;

  return (
    <div className="card">
      {allowed.map((address) => (
        <div key={address} className="row">
          <span className="row-tile">
            <Icon name="mail" size={15} />
          </span>
          <span className="row-label row-sub-text">{address}</span>
          <button type="button" className="automation-text pressable" aria-label={`Stop allowing ${address}`} onClick={async () => setRefused(await onRemove(address))}>
            Remove
          </button>
        </div>
      ))}
      <Problem text={refused} />
    </div>
  );
}
