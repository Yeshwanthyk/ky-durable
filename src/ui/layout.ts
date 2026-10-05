/** The sidebar and panel sit beside the chat from this width; below it they slide over it. */
const WIDE = "(min-width: 1024px)";

export const wide = () => window.matchMedia(WIDE).matches;
