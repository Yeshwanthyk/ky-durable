import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "quiet";

/** A control height in pixels; kit.css maps each to its --control-* token. */
export type ButtonSize = 28 | 32 | 36 | 44;

/** A pill button: ink for the one main action, an outline for the rest, bare text for the quietest. */
export function Button({
  variant = "secondary",
  size = 32,
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={className === undefined ? "kit-button" : `kit-button ${className}`} data-variant={variant} data-size={size} {...rest} />;
}
