import { useCallback, useEffect, useState } from "react";
import { parseOr } from "../core/decode";
import { AsksSchema, type SecretAsk } from "../inbound/shapes";
import { InputBlock } from "./Blocks";
import { VaultBadge } from "./Controls";
import { Icon } from "./Icon";
import { Problem } from "./Subscriptions";

/**
 * The credentials ky is asking a chat for, under its thread: a masked field for each. The field posts straight to
 * the Vault's route (src/inbound/routes.ts), so what the user types never passes through the chat or ky's model.
 * The calls ky asks to make are approvals, whose cards are the approvals PR's.
 */

const NOTHING: readonly SecretAsk[] = [];

/** While the chat is open it looks again this often, for an ask a background turn made. */
const REFRESH_MS = 10_000;

/** `changed` is anything that moves when the thread does, so a turn that just asked shows its card at once. */
export function InboundCards({ session, changed }: { session: string; changed: unknown }) {
  const [asks, setAsks] = useState<readonly SecretAsk[]>(NOTHING);

  const reload = useCallback(
    () =>
      fetch(`/api/inbound/asks?session=${encodeURIComponent(session)}`)
        .then(async (response) => (response.ok ? setAsks(parseOr(AsksSchema, await response.text(), { asks: NOTHING }).asks) : undefined))
        .catch(() => undefined),
    [session]
  );

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), REFRESH_MS);

    return () => clearInterval(timer);
  }, [reload, changed]);

  if (asks.length === 0) return null;

  return (
    <div className="inbound-cards">
      {asks.map((ask) => (
        <SecretCard key={ask.name} ask={ask} onDone={reload} />
      ))}
    </div>
  );
}

const HOW: Record<SecretAsk["scheme"], (ask: SecretAsk) => string> = {
  bearer: () => "as a bearer token",
  basic: () => "as user:password",
  header: (ask) => `in the ${ask.header ?? ""} header`
};

/** Send what the user typed to the Vault's route: undefined once it's kept, or why it wasn't. */
async function saved(ask: SecretAsk, value: string): Promise<string | undefined> {
  const response = await fetch("/api/inbound/secrets", { method: "POST", body: JSON.stringify({ session: ask.session, name: ask.name, value }) }).catch(() => null);

  if (response === null) return "Not connected.";

  return response.ok ? undefined : response.text();
}

// A credential ky asked for: what it's for and where it goes, and a masked field whose value goes to the Vault only.
function SecretCard({ ask, onDone }: { ask: SecretAsk; onDone: () => Promise<void> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();

  const save = async () => {
    if (!value.trim() || busy) return;

    setBusy(true);
    const refusal = await saved(ask, value);

    setBusy(false);
    setRefused(refusal);

    if (refusal === undefined) {
      setValue("");
      await onDone();
    }
  };

  return (
    <div className="ui-card-slot">
      <section className="ui-card" aria-label={`Credential ${ask.name}`} data-live={!busy} data-inbound="secret">
        <header className="ui-head">
          <span className="ui-icon" aria-hidden="true">
            <Icon name="lock" size={15} />
          </span>
          <h3 className="ui-title">{ask.name}</h3>
          <span className="ui-subtitle quiet">{new URL(ask.origin).host}</span>
        </header>
        <p className="ui-hint">
          {ask.purpose}. Sent only to {ask.origin}, {HOW[ask.scheme](ask)}.
        </p>
        <InputBlock input={{ type: "input", label: "Paste it here", placeholder: "Credential" }} value={value} live={!busy} alone masked onChange={setValue} onDone={() => void save()} />
        <Problem text={refused} />
      </section>
      <p className="ui-note">
        <VaultBadge /> · ky calls the API with it, and never sees it.
      </p>
    </div>
  );
}
