import type { MachineFacts } from "./machines/contract";

/** The cloud machine's name in ky: one per deploy, which no runner of the user's may pair as. */
export const CLOUD = "cloud";

/**
 * What the cloud machine is before its runner first says hello: Linux, both agents installed and
 * signed in with ky's subscriptions only, no Chrome, no ports.
 */
export const CLOUD_FACTS: MachineFacts = {
  os: "linux",
  chrome: false,
  repos: [],
  agents: { claude: { installed: true, signedIn: false }, codex: { installed: true, signedIn: false } },
  ports: [],
  kind: "cloud"
};
