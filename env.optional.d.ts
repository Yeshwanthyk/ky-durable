/**
 * What a deploy may leave out: the owner overlay's vars and bindings (wrangler.local.jsonc), and the
 * optional secrets (.dev.vars.example). `pnpm types` sees neither, so they are typed here, each one
 * possibly missing. boundaryFor (src/server.ts) builds what they connect only when they're set.
 */
interface Env {
  /** The Workers VPC service to VibeProxy on a computer of the user's. */
  readonly VIBEPROXY?: Fetcher;
  /** VibeProxy's listen address on that computer, which the tunnel forwards to. */
  readonly VIBEPROXY_ORIGIN?: string;
  readonly VIBEPROXY_KEY?: string;
  readonly OPENCODE_API_KEY?: string;
  /** Executor's MCP endpoint for the organization. */
  readonly EXECUTOR_URL?: string;
  readonly EXECUTOR_TOKEN?: string;
}
