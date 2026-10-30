import { createContext } from "react";

/**
 * Whether ky's socket is open. What can't wait for it, like stopping a task (a stop that landed later would stop
 * whatever runs by then), is offered only while it is, and says why not otherwise. Provided around the page.
 */
export const OnlineContext = createContext(true);

/** What a control that needs the connection says while there is none. */
export const OFFLINE_TITLE = "Offline · works once ky reconnects";
