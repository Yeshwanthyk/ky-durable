import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type FormEvent, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import type { ToolPolicy } from "../approvals/contract";
import { Logins } from "../browse/contract";
import { parseOr } from "../core/decode";
import { SecretsSchema } from "../inbound/shapes";
import { isMac } from "../machines/contract";
import type { MachineInfo, SpecialistAccess, SpecialistView } from "../protocol";
import { AutomationsContext } from "./Automations";
import { BotAvatar } from "./BotAvatar";
import { Sheet } from "./Sheet";

/** Soul › a specialist's page: its computer and Macs, workflows, skills, logins, keys and rules at a glance, and a box to ask it. */

const loginsOf = Schema.decodeUnknownOption(Schema.fromJsonString(Logins));

type Kept = { readonly logins: readonly string[]; readonly keys: readonly string[] };

const NOTHING: Kept = { logins: [], keys: [] };

const POLICY: Readonly<Record<ToolPolicy, string>> = { allow: "Allow", ask: "Ask", block: "Block" };

/** The sites `id`'s browser stays signed in to, and the API keys it keeps: its own, not the shared ones. */
function useKept(id: string): Kept {
  const [kept, setKept] = useState<Kept>(NOTHING);

  useEffect(() => {
    let open = true;

    const load = async () => {
      const [logins, secrets] = await Promise.all([fetch("/api/browse/logins"), fetch("/api/inbound/secrets")]);
      const sites = logins.ok ? Option.match(loginsOf(await logins.text()), { onNone: () => [], onSome: (view) => view.logins }) : [];
      const keys = secrets.ok ? parseOr(SecretsSchema, await secrets.text(), { secrets: [], owners: [] }).secrets : [];

      if (open) setKept({ logins: sites.flatMap((login) => (login.owner === id ? [login.site] : [])), keys: keys.flatMap((key) => (key.owner === id ? [key.name] : [])) });
    };

    load().catch(() => setKept(NOTHING));

    return () => {
      open = false;
    };
  }, [id]);

  return kept;
}

type Props = {
  readonly specialist: SpecialistView;
  readonly access: SpecialistAccess | undefined;
  readonly machines: readonly MachineInfo[];
  readonly onBrief: () => void;
  readonly onSettings: () => void;
  /** Asks the specialist in the chat. */
  readonly onAsk: (id: string, text: string) => void;
  readonly onClose: () => void;
};

export function SpecialistPage({ specialist, access, machines, onBrief, onSettings, onAsk, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { automations, onAction } = useContext(AutomationsContext);
  const { id } = specialist;
  const kept = useKept(id);
  const [asking, setAsking] = useState("");
  const own = automations.filter((automation) => automation.owner === id && automation.status !== "archived");
  const rules = Object.entries(access?.tools ?? {});

  const ask = (event: FormEvent) => {
    event.preventDefault();
    onAsk(id, asking.trim());
    dialog.current?.close();
  };

  return (
    <Sheet dialog={dialog} label={`@${id}'s page`} onClose={onClose}>
      <div className="specialist-page" data-specialist={id}>
        <div className="row">
          <span className="row-tile row-avatar">
            <BotAvatar name={`@${id}`} identity={id} owner={id} still size={36} />
          </span>
          <span className="row-text">
            <span className="row-sub row-sub-text">{specialist.description}</span>
          </span>
          <button type="button" className="automation-text pressable" onClick={onBrief}>
            Brief v{specialist.brief.version}
          </button>
          <button type="button" className="automation-text pressable" onClick={onSettings}>
            Settings
          </button>
        </div>
        <form className="specialist-ask" onSubmit={ask}>
          <input className="field-input" aria-label={`Ask @${id}`} value={asking} placeholder={`Ask @${id}…`} onChange={(event) => setAsking(event.target.value)} />
          <button type="submit" className="pill primary pressable" disabled={asking.trim() === ""}>
            Ask
          </button>
        </form>
        <Part label="Computer" empty="No sandbox of its own, and no Mac.">
          {computers(access, machines).map(({ name, status }) => (
            <Line key={name} label={name} value={status} />
          ))}
        </Part>
        <Part label="Workflows" empty={`None yet. In the chat: "make a workflow for @${id} that…"`}>
          {own.map((automation) => (
            <div key={automation.id} className="row" data-automation={automation.id}>
              <span className="row-text">
                <span className="row-label">{automation.title}</span>
                <span className="row-sub row-sub-text">{automation.status}</span>
              </span>
              {automation.status === "active" ? (
                <>
                  <button type="button" className="automation-text pressable" onClick={() => onAction(automation.id, "run")}>
                    Run now
                  </button>
                  <button type="button" className="automation-text pressable" onClick={() => onAction(automation.id, "pause")}>
                    Pause
                  </button>
                </>
              ) : automation.status === "paused" ? (
                <button type="button" className="automation-text pressable" onClick={() => onAction(automation.id, "resume")}>
                  Resume
                </button>
              ) : null}
            </div>
          ))}
        </Part>
        <section className="group" aria-label="Skills">
          <h4 className="group-sublabel">Skills</h4>
          <p className="group-empty">Every skill ky has is its too.</p>
        </section>
        <Part label="Logins" empty="None. It keeps a login when you sign in to a site in its browser.">
          {kept.logins.map((site) => (
            <Line key={site} label={site} value="Signed in" />
          ))}
        </Part>
        <Part label="Keys" empty="None. It keeps a key when you give it one it asks for.">
          {kept.keys.map((name) => (
            <Line key={name} label={name} value="In the Vault" />
          ))}
        </Part>
        <Part label="Rules" empty="ky's: Settings › Executor.">
          {rules.map(([tool, policy]) => (
            <Line key={tool} label={tool} value={POLICY[policy]} />
          ))}
        </Part>
      </div>
    </Sheet>
  );
}

/** Its own sandbox, then each Mac it may use, with whether each is there now. */
function computers(access: SpecialistAccess | undefined, machines: readonly MachineInfo[]): ReadonlyArray<{ readonly name: string; readonly status: string }> {
  if (access === undefined) return [];
  const home = machines.find((machine) => machine.sandbox?.id === access.home);
  const sandbox = home ? [{ name: home.name, status: home.online ? "Online" : "Asleep" }] : [];

  const macs = access.macs.map((name) => {
    const mac = machines.find((machine) => machine.name === name && isMac(machine));

    return { name, status: mac === undefined ? "Not paired" : mac.online ? "Online" : "Offline" };
  });

  return [...sandbox, ...macs];
}

function Part({ label, empty, children }: { readonly label: string; readonly empty: string; readonly children: readonly ReactNode[] }) {
  const none = children.length === 0;

  return (
    <section className="group" aria-label={label}>
      <h4 className="group-sublabel">{label}</h4>
      {none ? <p className="group-empty">{empty}</p> : <div className="card">{children}</div>}
    </section>
  );
}

function Line({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value">{value}</span>
    </div>
  );
}
