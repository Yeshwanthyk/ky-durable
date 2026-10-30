import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useState } from "react";
import { type Login, Logins } from "../browse/contract";
import { EmptyState, VaultBadge } from "./Controls";
import { Icon } from "./Icon";
import { Problem } from "./Subscriptions";
import { ago } from "./time";
import { useNow } from "./use-now";

/** Settings › the sites ky's browser stays signed in to, after the user signed in there through a hand-off. */

const loginsOf = Schema.decodeUnknownOption(Schema.fromJsonString(Logins));

export function BrowserLogins() {
  const [logins, setLogins] = useState<readonly Login[]>([]);
  const [refused, setRefused] = useState<string>();

  const reload = useCallback(async () => {
    const response = await fetch("/api/browse/logins");

    if (response.ok) setLogins(Option.getOrElse(Option.map(loginsOf(await response.text()), (kept) => kept.logins), () => []));
  }, []);

  useEffect(() => {
    reload().catch(() => setLogins([]));
  }, [reload]);

  const remove = async (site: string) => {
    const response = await fetch(`/api/browse/logins/${encodeURIComponent(site)}`, { method: "DELETE" }).catch(() => null);

    setRefused(response === null ? "Not connected." : response.ok ? undefined : await response.text());
    await reload();
  };

  return (
    <section className="group" id="settings-browser-logins">
      <h3 className="group-label">Browser logins</h3>
      {logins.length === 0 ? (
        <EmptyState icon="globe">None yet. When ky hands you its browser to sign in to a site, it keeps that login here.</EmptyState>
      ) : (
        <div className="card">
          {logins.map((login) => (
            <LoginRow key={login.site} login={login} onRemove={remove} />
          ))}
        </div>
      )}
      <Problem text={refused} />
    </section>
  );
}

function LoginRow({ login, onRemove }: { login: Login; onRemove: (site: string) => Promise<void> }) {
  const now = useNow();

  return (
    <div className="row" data-login={login.site}>
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
      <button type="button" className="automation-text pressable" onClick={() => void onRemove(login.site)}>
        Remove
      </button>
    </div>
  );
}
