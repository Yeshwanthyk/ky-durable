import { type FormEvent, useCallback, useEffect, useState } from "react";
import { parseOr } from "../core/decode";
import type { Static } from "typebox";
import { type Hook, type HooksView, HooksViewSchema, MadeHookSchema, RotatedSchema, type Secret, SecretsSchema } from "../inbound/shapes";
import { KY, ownerName, SHARED } from "../skills/contract";
import { CopyLine } from "./CopyButton";
import { EmptyState, Switch, VaultBadge } from "./Controls";
import { Icon } from "../chat-kit/Icon";
import { Problem } from "./Subscriptions";
import { ago } from "./time";
import { useNow } from "./use-now";
import { NAME } from "./open-chat";

/**
 * Settings › Webhooks: the URLs that post into a chat, and the API credentials ky calls with. A hook's URL, and its
 * signing secret, show once, when made or rotated; ky keeps only their hashes and the Vault the secret.
 */

type SecretsView = Static<typeof SecretsSchema>;

const NO_KEYS: SecretsView = { secrets: [], owners: [] };

/** What a hook's sender is given, shown this once. */
type Shown = { readonly hook: string; readonly url: string; readonly signing: string | null };

const why = async (response: Response | null) => (response === null ? "Not connected." : response.ok ? undefined : await response.text());

export function Inbound() {
  const [view, setView] = useState<HooksView | null>(null);
  const [keys, setKeys] = useState<SecretsView>(NO_KEYS);
  const [shown, setShown] = useState<Shown | null>(null);
  const [refused, setRefused] = useState<string>();
  const [keyRefused, setKeyRefused] = useState<string>();

  const reload = useCallback(async () => {
    const [hooks, kept] = await Promise.all([fetch("/api/inbound/hooks"), fetch("/api/inbound/secrets")]);

    if (hooks.ok) setView(parseOr(HooksViewSchema, await hooks.text(), { hooks: [], chats: [] }));

    if (kept.ok) setKeys(parseOr(SecretsSchema, await kept.text(), NO_KEYS));
  }, []);

  useEffect(() => {
    reload().catch(() => setView({ hooks: [], chats: [] }));
  }, [reload]);

  if (view === null) return <p className="group-empty">Loading webhooks…</p>;

  const rotate = async (hook: string) => {
    const response = await fetch(`/api/inbound/hooks/${hook}/rotate`, { method: "POST" }).catch(() => null);

    setRefused(await why(response));

    const rotated = response?.ok ? parseOr(RotatedSchema, await response.text(), null) : null;

    if (rotated) setShown({ hook, url: rotated.url, signing: rotated.signing });
  };

  const remove = async (hook: string) => {
    setRefused(await why(await fetch(`/api/inbound/hooks/${hook}`, { method: "DELETE" }).catch(() => null)));

    if (shown?.hook === hook) setShown(null);
    await reload();
  };

  const send = async (secret: Secret, init: RequestInit, path = "") => {
    setKeyRefused(await why(await fetch(`/api/inbound/secrets/${secret.owner}/${secret.name}${path}`, init).catch(() => null)));
    await reload();
  };

  const forget = (secret: Secret) => send(secret, { method: "DELETE" });

  const move = (secret: Secret, to: string) => send(secret, { method: "POST", body: JSON.stringify({ to }) }, "/move");

  const { secrets, owners } = keys;

  // Each owner's keys under its name: ky's, each specialist's, then one that is gone, then those shared with all.
  const groups = [...new Set([KY, ...owners, ...secrets.map((secret) => secret.owner).filter((owner) => owner !== SHARED), SHARED])].flatMap((owner) => {
    const own = secrets.filter((secret) => secret.owner === owner);

    return own.length === 0 ? [] : [{ owner, own }];
  });

  return (
    <>
      <section className="group" id="settings-inbound">
        <h3 className="group-label">Webhooks</h3>
        {shown ? <ShownOnce shown={shown} onClose={() => setShown(null)} /> : null}
        {view.hooks.length === 0 ? (
          <EmptyState icon="plug">No webhooks yet. A webhook posts what a service sends into a chat, for {NAME} to read.</EmptyState>
        ) : (
          <div className="card">
            {view.hooks.map((hook) => (
              <HookRow key={hook.id} hook={hook} chat={view.chats.find((chat) => chat.session === hook.session)?.title ?? "A chat"} onRotate={rotate} onRemove={remove} />
            ))}
          </div>
        )}
        <AddHook
          chats={view.chats}
          onAdded={async (added) => {
            setShown(added);
            await reload();
          }}
        />
        <Problem text={refused} />
      </section>
      <section className="group">
        <h3 className="group-label">Credentials</h3>
        {secrets.length === 0 ? (
          <EmptyState icon="lock">None yet. {NAME} asks for one in a chat when it needs to call an API.</EmptyState>
        ) : (
          groups.map(({ owner, own }) => (
            <div key={owner} data-owner={owner}>
              <h4 className="group-sublabel">{owner === SHARED ? "Shared with all" : `${ownerName(owner)}'s keys`}</h4>
              <div className="card">
                {own.map((secret) => (
                  <SecretRow key={secret.name} secret={secret} owners={owners} onForget={forget} onMove={move} />
                ))}
              </div>
            </div>
          ))
        )}
        <Problem text={keyRefused} />
      </section>
    </>
  );
}

// A hook's URL and signing secret, just made or rotated: the only time either shows.
function ShownOnce({ shown, onClose }: { shown: Shown; onClose: () => void }) {
  return (
    <div className="card code-card inbound-shown" data-hook={shown.hook}>
      <p className="field-hint">Give this URL to the service that posts. It shows only now; rotate the hook for a new one.</p>
      <CopyLine text={shown.url} label="Webhook URL" />
      {shown.signing ? (
        <>
          <p className="field-hint">Its signing secret, for an X-Hub-Signature-256 header, like GitHub's:</p>
          <CopyLine text={shown.signing} label="Signing secret" />
        </>
      ) : null}
      <div className="card-foot">
        <button type="button" className="automation-text pressable" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

function HookRow({ hook, chat, onRotate, onRemove }: { hook: Hook; chat: string; onRotate: (id: string) => Promise<void>; onRemove: (id: string) => Promise<void> }) {
  const now = useNow();
  const [busy, setBusy] = useState(false);

  const run = (work: (id: string) => Promise<void>) => async () => {
    setBusy(true);
    await work(hook.id);
    setBusy(false);
  };

  return (
    <div className="row" data-hook={hook.id}>
      <span className="row-tile">
        <Icon name="plug" size={15} />
      </span>
      <span className="row-text">
        <span className="row-label">{hook.label}</span>
        <span className="row-sub row-sub-text">
          Into {chat}
          {hook.signed ? " · signed" : ""} · {hook.lastAt === null ? "nothing yet" : `last ${ago(hook.lastAt, now)}`}
        </span>
      </span>
      <button type="button" className="automation-text pressable" disabled={busy} onClick={() => void run(onRotate)()}>
        Rotate
      </button>
      <button type="button" className="automation-text pressable" disabled={busy} onClick={() => void run(onRemove)()}>
        Delete
      </button>
    </div>
  );
}

function AddHook({ chats, onAdded }: { chats: HooksView["chats"]; onAdded: (shown: Shown) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(chats[0]?.session ?? "");
  const [label, setLabel] = useState("");
  const [signed, setSigned] = useState(true);
  const [refused, setRefused] = useState<string>();

  if (!open)
    return (
      <button type="button" className="pill pressable inbound-add" onClick={() => setOpen(true)}>
        <Icon name="plus" size={13} /> New webhook
      </button>
    );

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const response = await fetch("/api/inbound/hooks", { method: "POST", body: JSON.stringify({ session, label, signed }) }).catch(() => null);
    const reason = await why(response);

    setRefused(reason);

    const made = response?.ok ? parseOr(MadeHookSchema, await response.text(), null) : null;

    if (made) {
      setOpen(false);
      setLabel("");
      await onAdded({ hook: made.hook.id, url: made.url, signing: made.signing });
    }
  };

  return (
    <form className="card form-card" aria-label="Add a webhook" onSubmit={(event) => void add(event)}>
      <p className="field-hint">What it posts reaches the chat as outside data: {NAME} reads it, and asks you before it changes anything.</p>
      <label className="field" data-stack>
        <span className="field-label">Name</span>
        <input className="field-input" value={label} placeholder="e.g. GitHub pushes" maxLength={80} onChange={(event) => setLabel(event.currentTarget.value)} />
      </label>
      <label className="field">
        <span className="field-label">Chat</span>
        <select className="field-select" value={session} onChange={(event) => setSession(event.currentTarget.value)}>
          {chats.map((chat) => (
            <option key={chat.session} value={chat.session}>
              {chat.title}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span className="field-label">Signed</span>
        <Switch on={signed} label="Signed with a secret" onFlip={() => setSigned(!signed)} />
      </div>
      <Problem text={refused} />
      <div className="card-foot">
        <button type="button" className="automation-text pressable" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="pill primary pressable" disabled={session === ""}>
          Add
        </button>
      </div>
    </form>
  );
}

type SecretRowProps = {
  readonly secret: Secret;
  readonly owners: readonly string[];
  readonly onForget: (secret: Secret) => Promise<void>;
  readonly onMove: (secret: Secret, to: string) => Promise<void>;
};

// A key, and only the user's ways to change whose it is: move it to another owner, or share it with all.
function SecretRow({ secret, owners, onForget, onMove }: SecretRowProps) {
  const how = secret.scheme === "header" ? `${secret.header ?? ""} header` : secret.scheme;
  const others = [...owners, SHARED].filter((owner) => owner !== secret.owner);

  return (
    <div className="row login-row" data-secret={secret.name}>
      <span className="row-tile">
        <Icon name="lock" size={15} />
      </span>
      <span className="row-text">
        <span className="row-label">{secret.name}</span>
        <span className="row-sub row-sub-text">
          {secret.origin} · {how} · {secret.purpose}
        </span>
      </span>
      <VaultBadge />
      <button type="button" className="automation-text pressable" onClick={() => void onForget(secret)}>
        Delete
      </button>
      <span className="login-move">
        <select className="field-select" aria-label={`Move ${secret.name} to`} value="" onChange={(event) => void onMove(secret, event.target.value)}>
          <option value="" disabled>
            Move to…
          </option>
          {others.map((owner) => (
            <option key={owner} value={owner}>
              {owner === SHARED ? "Share with all" : ownerName(owner)}
            </option>
          ))}
        </select>
      </span>
    </div>
  );
}
