import { type FormEvent, useCallback, useEffect, useState } from "react";
import { parseOr } from "../core/decode";
import { type Hook, type HooksView, HooksViewSchema, MadeHookSchema, RotatedSchema, type Secret, SecretsSchema } from "../inbound/shapes";
import { CopyLine } from "./CopyButton";
import { EmptyState, Switch, VaultBadge } from "./Controls";
import { Icon } from "./Icon";
import { Problem } from "./Subscriptions";
import { ago } from "./time";
import { useNow } from "./use-now";

/**
 * Settings › Webhooks: the URLs that post into a chat, and the API credentials ky calls with. A hook's URL, and its
 * signing secret, show once, when made or rotated; ky keeps only their hashes and the Vault the secret.
 */

/** What a hook's sender is given, shown this once. */
type Shown = { readonly hook: string; readonly url: string; readonly signing: string | null };

const why = async (response: Response | null) => (response === null ? "Not connected." : response.ok ? undefined : await response.text());

export function Inbound() {
  const [view, setView] = useState<HooksView | null>(null);
  const [secrets, setSecrets] = useState<readonly Secret[]>([]);
  const [shown, setShown] = useState<Shown | null>(null);
  const [refused, setRefused] = useState<string>();

  const reload = useCallback(async () => {
    const [hooks, kept] = await Promise.all([fetch("/api/inbound/hooks"), fetch("/api/inbound/secrets")]);

    if (hooks.ok) setView(parseOr(HooksViewSchema, await hooks.text(), { hooks: [], chats: [] }));

    if (kept.ok) setSecrets(parseOr(SecretsSchema, await kept.text(), { secrets: [] }).secrets);
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

  const forget = async (name: string) => {
    setRefused(await why(await fetch(`/api/inbound/secrets/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => null)));
    await reload();
  };

  return (
    <>
      <section className="group" id="settings-inbound">
        <h3 className="group-label">Webhooks</h3>
        {shown ? <ShownOnce shown={shown} onClose={() => setShown(null)} /> : null}
        {view.hooks.length === 0 ? (
          <EmptyState icon="plug">No webhooks yet. A webhook posts what a service sends into a chat, for ky to read.</EmptyState>
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
          <EmptyState icon="lock">None yet. ky asks for one in a chat when it needs to call an API.</EmptyState>
        ) : (
          <div className="card">
            {secrets.map((secret) => (
              <SecretRow key={secret.name} secret={secret} onForget={forget} />
            ))}
          </div>
        )}
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
      <p className="field-hint">What it posts reaches the chat as outside data: ky reads it, and asks you before it changes anything.</p>
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

function SecretRow({ secret, onForget }: { secret: Secret; onForget: (name: string) => Promise<void> }) {
  const how = secret.scheme === "header" ? `${secret.header ?? ""} header` : secret.scheme;

  return (
    <div className="row" data-secret={secret.name}>
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
      <button type="button" className="automation-text pressable" onClick={() => void onForget(secret.name)}>
        Delete
      </button>
    </div>
  );
}
