import { useCallback, useId, useRef, useState } from "react";
import { BotAvatar } from "./BotAvatar";
import type { Mentionable } from "../chat-kit/Composer";
import { Icon } from "../chat-kit/Icon";
import { useDismiss } from "./use-dismiss";

/** A chat's specialists, and the user's way to change them. */
export type Group = {
  readonly members: readonly string[];
  readonly specialists: readonly Mentionable[];
  readonly onChange: (members: string[]) => void;
};

/** Avatars shown in the button before it counts the rest. */
const FACES = 3;

// Who is in the chat besides ky. With specialists in it, it is a group chat: they take up the user's
// messages in their line on their own. The button shows their faces; it opens a list to add or remove them.
export function GroupMembers({ members, specialists, onChange }: Group) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useDismiss(open, root, close);

  const toggle = (id: string) => onChange(members.includes(id) ? members.filter((each) => each !== id) : [...members, id]);
  const label = members.length === 0 ? "Add specialists to this chat" : `Group chat with ${members.map((id) => `@${id}`).join(", ")}`;

  return (
    <div className="group-members" ref={root}>
      <button
        type="button"
        className="group-button pressable"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {members.length === 0 ? (
          <Icon name="plus" size={15} />
        ) : (
          <span className="group-faces">
            {members.slice(0, FACES).map((id) => (
              <BotAvatar key={id} name={`@${id}`} identity={id} owner={id} still size={22} />
            ))}
            {members.length > FACES ? <span className="group-more">+{members.length - FACES}</span> : null}
          </span>
        )}
      </button>
      {open ? (
        <div className="group-menu" id={menuId} role="menu" aria-label="Specialists in this chat">
          <div className="group-menu-head">Specialists in this chat</div>
          {specialists.map((specialist) => {
            const member = members.includes(specialist.id);

            return (
              <button
                key={specialist.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={member}
                className="group-option pressable"
                onClick={() => toggle(specialist.id)}
              >
                <BotAvatar name={`@${specialist.id}`} identity={specialist.id} owner={specialist.id} still size={26} />
                <span className="group-option-text">
                  <span className="mention-id">@{specialist.id}</span>
                  <span className="mention-description">{specialist.description}</span>
                </span>
                <span className="group-check" data-on={member}>
                  {member ? <Icon name="check" size={12} /> : null}
                </span>
              </button>
            );
          })}
          <p className="group-menu-note">
            Specialists here answer on their own when a message is in their line, up to three at a time; ky takes the
            rest. Start with @ to ask one directly.
          </p>
        </div>
      ) : null}
    </div>
  );
}
