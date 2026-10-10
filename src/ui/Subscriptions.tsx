import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { ChatGptCode, ChatGptState, SubscriptionKind, SubscriptionView } from "../protocol";
import { Icon, type IconName } from "./Icon";
import { clock } from "./time";
import { reveal } from "./use-panel";

type SubscriptionActions = {
  /** Resolves with why the token was refused, if it was. */
  readonly onSetClaude: (token: string) => Promise<string | undefined>;
  readonly onRemove: (kind: SubscriptionKind) => void;
  readonly onChatGptLogin: () => Promise<ChatGptCode | { refused: string }>;
  readonly onChatGptPoll: (login: string) => Promise<ChatGptState>;
  readonly onGithubRepos: (token: string) => Promise<{ repos: string[] } | { refused: string }>;
  /** Resolves with why the token or repos were refused, if they were. */
  readonly onSetGithub: (token: string, repos: readonly string[]) => Promise<string | undefined>;
};

/** What Settings › Subscriptions shows, and what it does. */
export type SubscriptionsData = { views: readonly SubscriptionView[]; actions: SubscriptionActions };

/** How often Settings asks after a ChatGPT sign-in; the Vault polls OpenAI on its own clock. */
const POLL_MS = 3000;

/** How long OpenAI's device code lasts. */
const CODE_MS = 15 * 60_000;

const DAY_MS = 86_400_000;

/** A Claude token's expiry, warning in its last two weeks. */
function expiry(expiresAt: number, now: number): string {
  const days = Math.ceil((expiresAt - now) / DAY_MS);

  if (days <= 0) return "Expired; make a new token";

  return days <= 14 ? `Expires in ${days} days; make a new token soon` : `Expires in ${days} days`;
}

function claudeNote(view: SubscriptionView, now: number): string {
  return view.connected && view.expiresAt ? expiry(view.expiresAt, now) : "Paste what claude setup-token prints";
}

function chatgptNote(view: SubscriptionView): string {
  if (!view.connected) return "Sign in with a code";

  return view.error ?? "Signed in; ky renews it";
}

function githubNote(view: SubscriptionView): string {
  // Actions too: shipping a self-edit watches the deploy workflow, and a rollback runs it.
  if (!view.connected) return "For the cloud machine: a fine-grained token with Contents, Pull requests and Actions read and write";
  const repos = view.repos ?? [];

  return `${repos.length} ${repos.length === 1 ? "repo" : "repos"}: ${repos.join(", ")}`;
}

// Your Claude and ChatGPT subscriptions, which tasks on machines that aren't signed in run with, and GitHub for the cloud machine; off until a machine is paired, as nothing else uses them.
export function Subscriptions({ views, actions, now, paired }: SubscriptionsData & { now: number; paired: boolean }) {
  const view = (kind: SubscriptionKind): SubscriptionView =>
    views.find((each) => each.kind === kind) ?? { kind, connected: false, expiresAt: null, error: null };

  return (
    <section className="group" id="settings-subscriptions">
      <h3 className="group-label">Subscriptions</h3>
      <fieldset className="subscriptions-rows" disabled={!paired}>
        <div className="card">
          <ClaudeRow view={view("claude")} actions={actions} now={now} />
          <ChatGptRow view={view("chatgpt")} actions={actions} />
          <GithubRow view={view("github")} actions={actions} />
        </div>
      </fieldset>
      {paired ? (
        <p className="panel-note">
          Machines run Claude Code and Codex with these when they aren't signed in, or when you pick ky's login. The cloud machine clones and pushes with
          GitHub's, to ky/ branches only.
        </p>
      ) : (
        <PairFirst />
      )}
    </section>
  );
}

function PairFirst() {
  return (
    <p className="panel-note">
      Pair a machine first; Claude Code and Codex run there.{" "}
      <button type="button" className="refused-link" onClick={() => reveal("settings-machines")}>
        Go to Machines
      </button>
    </p>
  );
}

function SubscriptionRow({ icon, label, note, ok, children }: { icon: IconName; label: string; note: string; ok: boolean; children: ReactNode }) {
  return (
    <div className="row subscription-row">
      <span className="row-tile">
        <Icon name={icon} size={15} />
      </span>
      <span className="row-text">
        <span className="row-label">{label}</span>
        <span className="row-sub">{note}</span>
      </span>
      {children}
      <span className="status-dot" data-connected={ok} />
    </div>
  );
}

function RemoveButton({ onRemove }: { onRemove: () => void }) {
  return (
    <button type="button" className="pill pressable" onClick={onRemove}>
      Remove
    </button>
  );
}

/** Why something was refused, as an alert; nothing without one. */
export function Problem({ text }: { text: string | undefined }) {
  return text ? (
    <p className="automation-refused" role="alert">
      {text}
    </p>
  ) : null;
}

function ClaudeRow({ view, actions, now }: { view: SubscriptionView; actions: SubscriptionActions; now: number }) {
  const [refused, setRefused] = useState<string>();

  return (
    <>
      <SubscriptionRow icon="terminal" label="Claude" note={claudeNote(view, now)} ok={view.connected}>
        {view.connected ? <RemoveButton onRemove={() => actions.onRemove("claude")} /> : <ClaudeForm onSave={actions.onSetClaude} onRefused={setRefused} />}
      </SubscriptionRow>
      <Problem text={refused} />
    </>
  );
}

function ClaudeForm({ onSave, onRefused }: { onSave: SubscriptionActions["onSetClaude"]; onRefused: (reason: string | undefined) => void }) {
  const [token, setToken] = useState("");

  const save = async () => {
    const reason = await onSave(token);

    onRefused(reason);

    if (reason === undefined) setToken("");
  };

  return (
    <form
      className="subscription-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <input
        className="subscription-input"
        type="password"
        autoComplete="off"
        aria-label="Claude subscription token"
        placeholder="sk-ant-oat…"
        value={token}
        onChange={(event) => setToken(event.currentTarget.value)}
      />
      <button type="submit" className="pill pressable" disabled={token.trim() === ""}>
        Save
      </button>
    </form>
  );
}

type Signing = { code: ChatGptCode; until: number };

/** Ask after the sign-in every POLL_MS until it is done or failed; `onEnd` gets its error, if it failed. */
function useChatGptPoll(signing: Signing | null, poll: SubscriptionActions["onChatGptPoll"], onEnd: (error: string | undefined) => void) {
  useEffect(() => {
    if (signing === null) return;
    let live = true;

    const timer = setInterval(() => {
      void poll(signing.code.loginId).then((state) => {
        if (live && state !== "pending") onEnd(state === "done" ? undefined : state.error);
      });
    }, POLL_MS);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [signing, poll, onEnd]);
}

function ChatGptRow({ view, actions }: { view: SubscriptionView; actions: SubscriptionActions }) {
  const [signing, setSigning] = useState<Signing | null>(null);
  const [problem, setProblem] = useState<string>();

  const onEnd = useCallback((error: string | undefined) => {
    setSigning(null);
    setProblem(error);
  }, []);

  useChatGptPoll(signing, actions.onChatGptPoll, onEnd);

  const start = async () => {
    setProblem(undefined);
    const started = await actions.onChatGptLogin();

    if ("refused" in started) setProblem(started.refused);
    else setSigning({ code: started, until: Date.now() + CODE_MS });
  };

  return (
    <>
      <SubscriptionRow icon="cloud" label="ChatGPT" note={chatgptNote(view)} ok={view.connected && view.error === null}>
        {view.connected ? <RemoveButton onRemove={() => actions.onRemove("chatgpt")} /> : <SignInButton again={signing !== null} onStart={start} />}
      </SubscriptionRow>
      {signing ? <ChatGptCodeNote signing={signing} /> : null}
      <Problem text={problem} />
    </>
  );
}

function SignInButton({ again, onStart }: { again: boolean; onStart: () => Promise<void> }) {
  return (
    <button type="button" className="pill pressable" onClick={() => void onStart()}>
      {again ? "New code" : "Sign in"}
    </button>
  );
}

function ChatGptCodeNote({ signing }: { signing: Signing }) {
  return (
    <div className="machine-code">
      <p className="panel-note">
        Open{" "}
        <a href={signing.code.verificationUrl} target="_blank" rel="noreferrer">
          {signing.code.verificationUrl}
        </a>
        , sign in to ChatGPT and enter this code before {clock(signing.until)}.
      </p>
      <code className="machine-command" aria-label="ChatGPT code">
        {signing.code.userCode}
      </code>
    </div>
  );
}

function GithubRow({ view, actions }: { view: SubscriptionView; actions: SubscriptionActions }) {
  const [token, setToken] = useState("");
  const [listed, setListed] = useState<readonly string[] | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string>();

  const list = async () => {
    const answer = await actions.onGithubRepos(token);

    if ("refused" in answer) return setProblem(answer.refused);
    setProblem(answer.repos.length === 0 ? "The token reaches no repos: give it some on GitHub." : undefined);
    setListed(answer.repos);
    setPicked(new Set());
  };

  const save = async () => {
    const reason = await actions.onSetGithub(token, [...picked]);

    setProblem(reason);

    if (reason === undefined) {
      setToken("");
      setListed(null);
    }
  };

  const toggle = (repo: string) =>
    setPicked((current) => {
      const next = new Set(current);

      if (!next.delete(repo)) next.add(repo);

      return next;
    });

  return (
    <>
      <SubscriptionRow icon="repo" label="GitHub" note={githubNote(view)} ok={view.connected}>
        {view.connected ? (
          <RemoveButton onRemove={() => actions.onRemove("github")} />
        ) : (
          <form
            className="subscription-form"
            onSubmit={(event) => {
              event.preventDefault();
              void (listed === null ? list() : save());
            }}
          >
            <input
              className="subscription-input"
              type="password"
              autoComplete="off"
              aria-label="GitHub token"
              placeholder="github_pat_…"
              value={token}
              onChange={(event) => {
                setToken(event.currentTarget.value);
                setListed(null);
              }}
            />
            <button type="submit" className="pill pressable" disabled={token.trim() === "" || (listed !== null && picked.size === 0)}>
              {listed === null ? "Next" : "Save"}
            </button>
          </form>
        )}
      </SubscriptionRow>
      {!view.connected && listed !== null && listed.length > 0 ? (
        <fieldset className="github-repos" aria-label="Repos the cloud machine may use">
          {listed.map((repo) => (
            <label key={repo} className="github-repo">
              <input type="checkbox" checked={picked.has(repo)} onChange={() => toggle(repo)} />
              <span>{repo}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <Problem text={problem} />
    </>
  );
}
