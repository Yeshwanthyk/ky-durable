import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useState } from "react";
import { type Login, Logins } from "../browse/contract";
import { KY, ownerName } from "../skills/contract";
import { EmptyState, VaultBadge } from "./Controls";
import { Icon } from "../chat-kit/Icon";
import { Problem } from "./Subscriptions";
import { ago } from "./time";
import { useNow } from "./use-now";

/** Settings › the sites each owner's browser stays signed in to, by owner: ky's, then each specialist's. Only the user moves one. */

const loginsOf = Schema.decodeUnknownOption(Schema.fromJsonString(Logins));

const NONE: Logins = { logins: [], owners: [] };

export function BrowserLogins() {
  const [kept, setKept] = useState<Logins>(NONE);
  const [refused, setRefused] = useState<string>();

  const reload = useCallback(async () => {
    const response = await fetch("/api/browse/logins");

    if (response.ok) setKept(Option.getOrElse(loginsOf(await response.text()), () => NONE));
  }, []);

  useEffect(() => {
    reload().catch(() => setKept(NONE));
  }, [reload]);

  const send = async (login: Login, init: RequestInit, path = "") => {
    const response = await fetch(`/api/browse/logins/${login.owner}/${encodeURIComponent(login.site)}${path}`, init).catch(() => null);

    setRefused(response === null ? "Not connected." : response.ok ? undefined : await response.text());
    await reload();
  };

  const remove = (login: Login) => send(login, { method: "DELETE" });

  const move = (login: Login, to: string) => send(login, { method: "POST", body: JSON.stringify({ to }) }, "/move");

  const { logins, owners } = kept;

  const groups = [...new Set([KY, ...owners, ...logins.map((login) => login.owner)])].flatMap((owner) => {
    const own = logins.filter((login) => login.owner === owner);

    return own.length === 0 ? [] : [{ owner, own }];
  });

  return (
    <section className="group" id="settings-browser-logins">
      <h3 className="group-label">Browser logins</h3>
      {logins.length === 0 ? (
        <EmptyState icon="globe">None yet. When ky hands you its browser to sign in to a site, it keeps that login here.</EmptyState>
      ) : (
        groups.map(({ owner, own }) => (
          <div key={owner} data-owner={owner}>
            <h4 className="group-sublabel">{ownerName(owner)}'s browser</h4>
            <div className="card">
              {own.map((login) => (
                <LoginRow key={login.site} login={login} owners={owners} onMove={move} onRemove={remove} />
              ))}
            </div>
          </div>
        ))
      )}
      <Problem text={refused} />
    </section>
  );
}

type RowProps = {
  readonly login: Login;
  readonly owners: readonly string[];
  readonly onMove: (login: Login, to: string) => Promise<void>;
  readonly onRemove: (login: Login) => Promise<void>;
};

function LoginRow({ login, owners, onMove, onRemove }: RowProps) {
  const now = useNow();
  const others = owners.filter((owner) => owner !== login.owner);

  return (
    <div className="row login-row" data-login={login.site}>
      <span className="row-tile">
        <Icon name="globe" size={15} />
      </span>
      <span className="row-text">
        <span className="row-label">{login.site}</span>
        <span className="row-sub row-sub-text">
          {login.cookies} {login.cookies === 1 ? "cookie" : "cookies"} · saved {ago(login.updatedAt, now)}
        </span>
      </span>
      <VaultBadge />
      <button type="button" className="automation-text pressable" onClick={() => void onRemove(login)}>
        Remove
      </button>
      {others.length > 0 && (
        <span className="login-move">
          <select className="field-select" aria-label={`Move ${login.site} to`} value="" onChange={(event) => void onMove(login, event.target.value)}>
            <option value="" disabled>
              Move to…
            </option>
            {others.map((owner) => (
              <option key={owner} value={owner}>
                {ownerName(owner)}
              </option>
            ))}
          </select>
        </span>
      )}
    </div>
  );
}
