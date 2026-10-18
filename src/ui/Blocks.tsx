import { createContext, type KeyboardEvent, type ReactNode, useContext, useState } from "react";
import type { UiBlock, UiCard } from "../ui-blocks";
import { answered, cardName, compose, decompose, type Choice, type Input, isQuestion, lettered, LETTERS, needsSend, optionState, takesTaps, type Question, sendsOnTap, toggled, type Value } from "./card-answers";
import { Icon, type IconName } from "./Icon";
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
        {ui.title ? <CardHead title={ui.title} icon={ui.icon} /> : null}
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

function CardHead({ title, icon }: { title: string; icon: string | undefined }) {
  return (
    <header className="ui-head">
      {icon ? (
        <span className="ui-icon" aria-hidden="true">
          <Icon name={iconFor(icon)} size={15} />
        </span>
      ) : null}
      <h3 className="ui-title">{title}</h3>
    </header>
  );
}

type Views = { readonly [Type in UiBlock["type"]]: (block: Extract<UiBlock, { type: Type }>, form: Form) => ReactNode };

/** Each block type's component. */
const VIEWS: Views = {
  text: (block) => <TextBlock text={block.text} />,
  choice: (block, form) => <ChoiceView choice={block} form={form} />,
  input: (block, form) => <InputView input={block} form={form} />,
  buttons: (block, form) => <ButtonsBlock buttons={block.buttons} live={form.live} pressed={form.answer} onReply={form.reply} />,
  list: (block) => <ListBlock items={block.items} />,
  facts: (block) => <FactsBlock rows={block.rows} />,
  status: (block) => <StatusBlock text={block.text} tone={block.tone ?? "info"} />
};

/** One block, by its type. */
function BlockView({ block, form }: { block: UiBlock; form: Form }) {
  // SAFETY: VIEWS is keyed by block type, so the view under block.type takes that very block.
  const view = VIEWS[block.type] as (block: UiBlock, form: Form) => ReactNode;

  return view(block, form);
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

function ButtonsBlock({ buttons, live, pressed, onReply }: { buttons: readonly Button[]; live: boolean; pressed: string; onReply: (text: string) => void }) {
  return (
    <div className="ui-actions">
      {buttons.map((button) =>
        button.url ? <LinkButton key={button.label} button={button} url={button.url} /> : <ReplyButton key={button.label} button={button} live={live} pressed={pressed} onReply={onReply} />
      )}
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

function ListBlock({ items }: { items: Extract<UiBlock, { type: "list" }>["items"] }) {
  return (
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

const TONE_ICON: Record<"info" | "success" | "warning" | "error", IconName> = { info: "circle", success: "checkCircle", warning: "alert", error: "alert" };

function StatusBlock({ text, tone }: { text: string; tone: "info" | "success" | "warning" | "error" }) {
  return (
    <p className="ui-status" data-tone={tone}>
      <Icon name={TONE_ICON[tone]} size={13} />
      <span>{text}</span>
    </p>
  );
}
