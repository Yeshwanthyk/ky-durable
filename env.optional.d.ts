/**
 * What a deploy may leave out: the owner overlay's vars and bindings (wrangler.local.jsonc), the
 * optional secrets (.dev.vars.example), and Access's vars. `pnpm types` sees none of them, so they are
 * typed here, each one possibly missing. boundaryFor (src/server.ts) builds what they connect only when
 * they're set; without Access's vars, src/access.ts refuses every request.
 */
interface Env {
  /** The Workers VPC service to VibeProxy on a computer of the user's. */
  readonly VIBEPROXY?: Fetcher;
  /** VibeProxy's listen address on that computer, which the tunnel forwards to. */
  readonly VIBEPROXY_ORIGIN?: string;
  readonly VIBEPROXY_KEY?: string;
  /** Cloudflare Access (src/access.ts): the team's domain, `<team>.cloudflareaccess.com`. `ky deploy` sets all three. */
  readonly ACCESS_TEAM_DOMAIN?: string;
  /** The audience tag of ky's Access app. */
  readonly ACCESS_AUD?: string;
  /** The emails Access lets in, comma separated. */
  readonly ACCESS_EMAILS?: string;
  /** "1" when `ky deploy` gave the CloudMachine its container (Workers Paid): the cloud machine is listed and woken. */
  readonly KY_CLOUD?: string;
  /** How many idle minutes the cloud machine stays up before it sleeps (src/cloud.ts): 10 when unset; a live test sets 1. */
  readonly KY_CLOUD_IDLE_MINUTES?: string;
  /** How many questions one peer may have open with this ky at once (src/peers/peers.ts): 3 when unset. */
  readonly KY_PEER_OPEN_ASKS?: string;
  /** How many questions one peer may ask this ky in an hour: 10 when unset. */
  readonly KY_PEER_HOURLY_ASKS?: string;
  /** Email Service's send binding, for mail from ky's own address (src/mail.ts). */
  readonly EMAIL?: SendEmail;
  /** ky's own address, like ky@example.com, on a domain onboarded to Email Service; its routing rule sends mail to this Worker. */
  readonly KY_MAIL_ADDRESS?: string;
  /** The most mails ky sends in a day (src/mail.ts): 50 when unset. */
  readonly KY_MAIL_DAILY_SENDS?: string;
  /** The most mails ky triages in an hour; the rest are only kept: 20 when unset. */
  readonly KY_MAIL_HOURLY_TRIAGES?: string;
  /** "1" signs every request in as KY_DEV_EMAIL, with no Access: `pnpm start` only, never a deploy. */
  readonly KY_DEV?: string;
  readonly KY_DEV_EMAIL?: string;
}
