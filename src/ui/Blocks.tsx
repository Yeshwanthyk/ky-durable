import { createContext, type KeyboardEvent, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import Type from "typebox";
import { decodeOr } from "../core/decode";
import type { ShownBlock, TabsBlock, UiBlock, UiCard } from "../ui-blocks";
import { answered, cardName, compose, decompose, type Choice, type Input, isQuestion, lettered, LETTERS, needsSend, optionState, takesTaps, type Question, sendsOnTap, toggled, type Value } from "./card-answers";
import { Icon, type IconName } from "./Icon";
import { ChartBlock, seriesColor } from "./Charts";
import { useLightbox } from "./Lightbox";
import { Markdown } from "./Markdown";

/**
 * A card ky composed with the ui tool (src/ui-tool.ts), block by block. Each
 * block type is its own component; one the page does not know was dropped when
 * the card was read (card-answers.ts), so an older page shows the rest of it.
 * A question's answer goes as the user's next message (card-answers.ts); a
 * button sends its reply, or opens its link.
 */

/** Sends the user's answer as their next message; a thread that cannot send has none. */
export const ReplyContext = createContext<((text: string) => void) | null>(null);

type Option = { label: string; detail?: string };

const ICONS: ReadonlyArray<[RegExp, IconName]> = [
  [/mail|gmail|inbox/i, "mail"],
  [/calendar|event|time|clock/i, "clock"],
  [/github|git|branch|code/i, "branch"],
  [/file|doc|drive|sheet/i, "file"],
  [/web|site|link|browser/i, "globe"],
  [/plug|app|connect|auth/i, "plug"],
  [/task|todo|list/i, "list"],
  [/chat|message|slack/i, "chat"]
];

const iconFor = (name: string): IconName => ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? "sparkle";

/** A card's answers while the user fills it in, and once their message has answered it. */
type Form = {
  readonly live: boolean;
  /** The user's message answered the card. */
  readonly done: boolean;
  readonly questions: readonly Question[];
  readonly values: readonly Value[];
  readonly answer: string;
  readonly change: (index: number, value: Value) => void;
  readonly submit: () => void;
  readonly reply: (text: string) => void;
};

function useForm(questions: readonly Question[], answer: string | null, open: boolean): Form {
  const send = useContext(ReplyContext);
  const [values, setValues] = useState<Value[]>(() => questions.map(() => []));
  const [sent, setSent] = useState(false);
  const live = takesTaps(open, answer, sent) && send !== null;

  const reply = (text: string) => {
    if (!live || !text) return;
    setSent(true);
    send(text);
  };

  const change = (index: number, value: Value) => {
    if (!live) return;
    const next = values.map((each, at) => (at === index ? value : each));

    if (sendsOnTap(questions)) reply(compose(questions, next));
    else setValues(next);
  };

  const submit = () => (answered(questions, values) ? reply(compose(questions, values)) : undefined);

  const shown = answer === null ? { done: false, values, answer: "" } : { done: true, values: decompose(questions, answer), answer };

  return { live, questions, change, submit, reply, ...shown };
}

/**
 * The card. `answer` is the user's next message, if the chat has one; `open`
 * says the card is the chat's latest word, so it still takes taps.
 */
export function BlockCard({ ui, answer, open }: { ui: UiCard; answer: string | null; open: boolean }) {
  const form = useForm(ui.blocks.filter(isQuestion), answer, open);

  return (
    <div className="ui-card-slot">
      <section className="ui-card" aria-label={cardName(ui)} data-live={form.live}>
        {ui.title ? <CardHead title={ui.title} subtitle={ui.subtitle} icon={ui.icon} /> : null}
        {ui.blocks.map((block, at) => (
          <BlockView key={at} block={block} form={form} />
        ))}
        {form.live && needsSend(form.questions) ? <SendRow form={form} /> : null}
      </section>
      <CardNote note={ui.note} />
    </div>
  );
}

/** The small print under a card. */
function CardNote({ note }: { note: string | undefined }) {
  return note ? <p className="ui-note">{note}</p> : null;
}

function SendRow({ form }: { form: Form }) {
  return (
    <div className="ui-actions">
      <button type="button" className="ui-button pressable" data-tone="primary" disabled={!answered(form.questions, form.values)} onClick={form.submit}>
        Send
      </button>
    </div>
  );
}

function CardHead({ title, subtitle, icon }: { title: string; subtitle: string | undefined; icon: string | undefined }) {
  return (
    <header className="ui-head">
      {icon ? (
        <span className="ui-icon" aria-hidden="true">
          <Icon name={iconFor(icon)} size={15} />
        </span>
      ) : null}
      <h3 className="ui-title">{title}</h3>
      {subtitle ? <span className="ui-subtitle quiet">{subtitle}</span> : null}
    </header>
  );
}

type Views<Block extends { type: string }, Extra> = { readonly [Type in Block["type"]]: (block: Extract<Block, { type: Type }>, extra: Extra) => ReactNode };

/** The blocks that only show, which a tab or a column may hold too. */
const SHOWN: Views<ShownBlock, Form | null> = {
  text: (block) => <TextBlock text={block.text} />,
  list: (block) => <ListBlock label={block.label} items={block.items} />,
  facts: (block) => <FactsBlock rows={block.rows} />,
  image: (block) => <ImageBlock src={block.src} caption={block.caption} />,
  status: (block) => <StatusBlock text={block.text} tone={block.tone ?? "info"} />,
  stats: (block) => <StatsBlock items={block.items} />,
  chart: (block) => <ChartBlock chart={block} />,
  table: (block) => <TableBlock table={block} />
};

/** Each block type's component. */
const VIEWS: Views<UiBlock, Form> = {
  ...SHOWN,
  choice: (block, form) => <ChoiceView choice={block} form={form} />,
  input: (block, form) => <InputView input={block} form={form} />,
  buttons: (block, form) => <ButtonsBlock buttons={block.buttons} live={form.live} pressed={form.answer} onReply={form.reply} />,
  page: (block) => <PageBlock site={block.site} title={block.title ?? "Page"} height={block.height ?? 480} />,
  tabs: (block) => <TabsView tabs={block.tabs} />,
  columns: (block) => <ColumnsBlock columns={block.columns} />
};

/** One block, by its type. */
function BlockView({ block, form }: { block: UiBlock; form: Form }) {
  // SAFETY: VIEWS is keyed by block type, so the view under block.type takes that very block.
  const view = VIEWS[block.type] as (block: UiBlock, form: Form) => ReactNode;

  return view(block, form);
}

/** A block in a tab or a column. */
function Shown({ block }: { block: ShownBlock | TabsBlock }) {
  if (block.type === "tabs") return <TabsView tabs={block.tabs} />;
  // SAFETY: SHOWN is keyed by block type, so the view under block.type takes that very block.
  const view = SHOWN[block.type] as (block: ShownBlock, form: Form | null) => ReactNode;

  return view(block, null);
}

/** Blocks side by side; the grid folds them one under another once a column would be narrower than it reads. */
function ColumnsBlock({ columns }: { columns: ReadonlyArray<ReadonlyArray<ShownBlock | TabsBlock>> }) {
  return (
    <div className="ui-columns">
      {columns.map((column, index) => (
        <div className="ui-column" key={index}>
          {column.map((block, at) => (
            <Shown key={at} block={block} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Tabs over a few views of the same answer; the first shows first. */
function TabsView({ tabs }: { tabs: TabsBlock["tabs"] }) {
  const [shown, setShown] = useState(0);
  const tab = tabs[shown] ?? tabs[0];

  return (
    <div className="ui-tabs">
      <div className="ui-tab-row" role="tablist">
        {tabs.map((each, index) => (
          <button key={index} type="button" role="tab" className="ui-tab pressable" aria-selected={index === shown} onClick={() => setShown(index)}>
            {each.label}
          </button>
        ))}
      </div>
      <div className="ui-tab-panel" role="tabpanel" aria-label={tab?.label}>
        {tab?.blocks.map((block, at) => (
          <Shown key={`${shown}-${at}`} block={block} />
        ))}
      </div>
    </div>
  );
}

type Stat = Extract<ShownBlock, { type: "stats" }>["items"][number];

const TONE_COLOR = { info: undefined, success: "var(--success)", warning: "var(--warning)", error: "var(--danger)" } as const;

/** A few headline numbers in a row that wraps; a number that is a chart's series wears its color. */
function StatsBlock({ items }: { items: readonly Stat[] }) {
  return (
    <dl className="ui-stats">
      {items.map((item, index) => (
        <div key={index}>
          <dd style={{ color: item.tone ? TONE_COLOR[item.tone] : undefined }}>
            {item.series ? <i className="ui-swatch" style={{ background: seriesColor(item.series - 1) }} /> : null}
            {String(item.value)}
          </dd>
          <dt>{item.label}</dt>
        </div>
      ))}
    </dl>
  );
}

type Table = Extract<ShownBlock, { type: "table" }>;

/** A cell that reads as a number, an amount or a share right-aligns. */
const numeric = (cell: string) => /^[-+−]?[$€£¥]?[\d.,]+\s?(%|[kKmMbB])?$/.test(cell.trim());

function TableBlock({ table }: { table: Table }) {
  const right = table.columns.map((_, column) => table.rows.length > 0 && table.rows.every((row) => numeric(row[column] ?? "0")));

  return (
    <figure className="ui-table">
      {table.label ? <figcaption className="ui-block-label">{table.label}</figcaption> : null}
      <div className="ui-table-scroll">
        <table>
          <thead>
            <tr>
              {table.columns.map((column, index) => (
                <th key={index} data-numeric={right[index]}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              <tr key={index}>
                {table.columns.map((_, column) => (
                  <td key={column} data-numeric={right[column]}>
                    {row[column] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

function ChoiceView({ choice, form }: { choice: Choice; form: Form }) {
  const index = form.questions.indexOf(choice);

  return <ChoiceBlock choice={choice} value={form.values[index] ?? []} live={form.live} answered={form.done} onChange={(next) => form.change(index, next)} />;
}

function InputView({ input, form }: { input: Input; form: Form }) {
  const index = form.questions.indexOf(input);
  const value = form.values[index]?.[0] ?? "";

  if (form.done) return <AnsweredInput label={input.label} value={value} />;

  return <InputBlock input={input} value={value} live={form.live} alone={form.questions.length === 1} onChange={(next) => form.change(index, [next])} onDone={form.submit} />;
}

function TextBlock({ text }: { text: string }) {
  return (
    <div className="ui-text">
      <Markdown source={text} />
    </div>
  );
}

/** A question with lettered options: a letter key picks one while focus is in it, at once, with no animation. */
const modified = (event: KeyboardEvent) => event.metaKey || event.ctrlKey || event.altKey;

type ChoiceProps = { choice: Choice; value: Value; live: boolean; answered: boolean; onChange: (value: Value) => void };

/** A question with lettered options: a letter key picks one while focus is in it, at once, with no animation. */
function ChoiceBlock({ choice, value, live, answered, onChange }: ChoiceProps) {
  const pick = (label: string) => onChange(toggled(value, label, choice.multiple === true));

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const option = live && !modified(event) ? lettered(choice, event.key) : undefined;

    if (option === undefined) return;
    event.preventDefault();
    pick(option.label);
  };

  const hint = choice.hint ?? (choice.multiple ? "Choose all that apply" : undefined);

  return (
    <div className="ui-choice" role="group" aria-label={choice.label} onKeyDown={onKeyDown}>
      <p className="ui-question">{choice.label}</p>
      {hint ? <p className="ui-hint">{hint}</p> : null}
      <div className="ui-options">
        {choice.options.map((option, index) => (
          <OptionRow
            key={option.label}
            option={option}
            letter={LETTERS[index] ?? ""}
            on={value.includes(option.label)}
            multiple={choice.multiple === true}
            answered={answered}
            live={live}
            onPick={() => pick(option.label)}
          />
        ))}
      </div>
    </div>
  );
}

type OptionProps = { option: Option; letter: string; on: boolean; multiple: boolean; answered: boolean; live: boolean; onPick: () => void };

/** One option: its letter, or a tick once a multiple choice has it; once the card is done, only what was chosen stays bright. */
function OptionRow({ option, letter, on, multiple, answered: answeredCard, live, onPick }: OptionProps) {
  const state = optionState(on, multiple, answeredCard, live);

  return (
    <button
      type="button"
      className="ui-option pressable pressable-row"
      aria-pressed={state.pressed}
      data-on={on}
      disabled={state.dim}
      aria-disabled={!live || undefined}
      onClick={live ? onPick : undefined}
    >
      <span className="ui-key" aria-hidden="true">
        {state.ticked ? <Icon name="check" size={12} /> : letter}
      </span>
      <OptionLabel option={option} />
    </button>
  );
}

function OptionLabel({ option }: { option: Option }) {
  return (
    <span className="ui-label">
      {option.label}
      {option.detail ? <span className="ui-detail">{option.detail}</span> : null}
    </span>
  );
}

function AnsweredInput({ label, value }: { label: string; value: string }) {
  return (
    <div className="ui-input" data-answered="true">
      <p className="ui-question">{label}</p>
      <p className="ui-typed">{value}</p>
    </div>
  );
}

type InputProps = { input: Input; value: string; live: boolean; alone: boolean; onChange: (value: string) => void; onDone: () => void };

/** A field to type in; alone on its card it has its own ✓, which Enter presses. */
function InputBlock({ input, value, live, alone, onChange, onDone }: InputProps) {
  return (
    <form
      className="ui-input"
      onSubmit={(event) => {
        event.preventDefault();
        onDone();
      }}
    >
      <label className="ui-question">{input.label}</label>
      <div className="ui-field">
        <Field input={input} value={value} live={live} onChange={onChange} />
        {alone ? <DoneButton ready={live && Boolean(value.trim())} /> : null}
      </div>
    </form>
  );
}

/** The field itself: a line, or a few for a multiline input. */
function Field({ input, value, live, onChange }: { input: Input; value: string; live: boolean; onChange: (value: string) => void }) {
  const field = {
    value,
    disabled: !live,
    placeholder: input.placeholder ?? "Type here",
    "aria-label": input.label,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value)
  };

  return input.multiline ? <textarea rows={3} {...field} /> : <input type="text" {...field} />;
}

function DoneButton({ ready }: { ready: boolean }) {
  return (
    <button type="submit" className="ui-done pressable" aria-label="Send answer" disabled={!ready}>
      <Icon name="check" size={15} />
    </button>
  );
}

type Button = Extract<UiBlock, { type: "buttons" }>["buttons"][number];

/** A link a card may open: http or https only, since the arguments are the model's to write. */
const webLink = (url: string | undefined) => (url !== undefined && /^https?:\/\//i.test(url) ? url : null);

function ButtonsBlock({ buttons, live, pressed, onReply }: { buttons: readonly Button[]; live: boolean; pressed: string; onReply: (text: string) => void }) {
  return (
    <div className="ui-actions">
      {buttons.map((button) => {
        const url = webLink(button.url);

        return url ? <LinkButton key={button.label} button={button} url={url} /> : <ReplyButton key={button.label} button={button} live={live} pressed={pressed} onReply={onReply} />;
      })}
    </div>
  );
}

/** A button that opens a page, such as an app's authorize link, in a new tab. */
function LinkButton({ button, url }: { button: Button; url: string }) {
  return (
    <a className="ui-button pressable" data-tone={button.tone ?? "primary"} href={url} target="_blank" rel="noreferrer">
      {button.label}
    </a>
  );
}

/** A button that sends its reply, or its label, as the user's message. */
function ReplyButton({ button, live, pressed, onReply }: { button: Button; live: boolean; pressed: string; onReply: (text: string) => void }) {
  const reply = button.reply ?? button.label;

  return (
    <button type="button" className="ui-button pressable" data-tone={button.tone ?? "default"} data-on={pressed === reply} disabled={!live} onClick={() => onReply(reply)}>
      {button.label}
    </button>
  );
}

function ListBlock({ label, items }: { label: string | undefined; items: Extract<UiBlock, { type: "list" }>["items"] }) {
  const list = (
    <ul className="ui-list">
      {items.map((item, index) => (
        <li key={index}>
          <span className="ui-list-title">{item.title}</span>
          {item.meta ? <span className="ui-list-meta quiet">{item.meta}</span> : null}
          {item.detail ? <span className="ui-detail">{item.detail}</span> : null}
        </li>
      ))}
    </ul>
  );

  return label ? (
    <div className="ui-labelled">
      <p className="ui-block-label">{label}</p>
      {list}
    </div>
  ) : (
    list
  );
}

function FactsBlock({ rows }: { rows: Extract<UiBlock, { type: "facts" }>["rows"] }) {
  return (
    <dl className="ui-facts">
      {rows.map((row, index) => (
        <div key={index}>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A saved file's id reads from ky's own /files; the schema lets nothing else through but an https URL. */
const imageUrl = (src: string) => (/^[0-9a-f]{32}$/.test(src) ? `/files/${src}` : src);

/** An image, its caption under it; a tap opens it full size. */
function ImageBlock({ src, caption }: { src: string; caption: string | undefined }) {
  const open = useLightbox();
  const url = imageUrl(src);
  const label = caption ?? "Image";

  return (
    <figure className="ui-image attachment">
      <button type="button" className="attachment-open" aria-label={`Open ${label}`} onClick={() => open([{ src: url, label }], 0)}>
        <img src={url} alt={label} loading="lazy" referrerPolicy="no-referrer" />
      </button>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

/** What a site's page opened with ?embed posts (src/site-routes.ts). */
const HeightReport = Type.Object({ kySiteHeight: Type.Number() });

const clampHeight = (height: number) => Math.min(2000, Math.max(80, Math.ceil(height)));

/**
 * A published site's page in the card. It runs sandboxed in an opaque origin, as at /s/<id>/, so its script
 * can't reach ky's page or the user's session; with ?embed it posts its height, and only its own frame's
 * message sizes the frame.
 */
function PageBlock({ site, title, height: initial }: { site: string; title: string; height: number }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(initial);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const reported = event.source === frame.current?.contentWindow ? decodeOr(HeightReport, event.data, null) : null;

      if (reported !== null) setHeight(clampHeight(reported.kySiteHeight));
    };

    addEventListener("message", onMessage);

    return () => removeEventListener("message", onMessage);
  }, []);

  return (
    <figure className="ui-page">
      <iframe ref={frame} src={`/s/${site}/?embed`} title={title} sandbox="allow-scripts allow-forms allow-popups" referrerPolicy="no-referrer" style={{ height }} />
      <figcaption>
        <a href={`/s/${site}/`} target="_blank" rel="noreferrer">
          Open {title}
        </a>
      </figcaption>
    </figure>
  );
}

const TONE_ICON: Record<"info" | "success" | "warning" | "error", IconName> = { info: "circle", success: "checkCircle", warning: "alert", error: "alert" };

function StatusBlock({ text, tone }: { text: string; tone: "info" | "success" | "warning" | "error" }) {
  return (
    <p className="ui-status" data-tone={tone}>
      <Icon name={TONE_ICON[tone]} size={13} />
      <span>{text}</span>
    </p>
  );
}
