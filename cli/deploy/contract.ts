/**
 * The deploy domain's outside: what a caller may ask of it, what it answers, and why it won't, in
 * B's words. The domain (deployer.ts) fails with these refusals in its typed channel; the edge,
 * `Cloudflare.run` in cli/cloudflare.ts, throws each as an Error whose message is its refusal, as B
 * threw them.
 */
import * as Schema from "effect/Schema";

/** The tag every Worker and Access app the CLI makes carries, and the prefix of the one that names a Worker's release. */
export const TAG = "ky";

export const RELEASE_TAG = "ky-release-";

/** The object every bucket the CLI makes holds, so a bucket without it is never adopted unless it's empty and unbound. */
export const MARKER = ".ky";

/** What a caller may ask: the parity runs generate these, and both deployers take them. */
export const DeployAction = Schema.Union([
  Schema.TaggedStruct("deploy", { version: Schema.String }),
  Schema.TaggedStruct("claim", {}),
  Schema.TaggedStruct("address", {}),
  Schema.TaggedStruct("deployedRelease", {}),
  Schema.TaggedStruct("inspect", { version: Schema.String }),
  Schema.TaggedStruct("teardown", {}),
  Schema.TaggedStruct("leftovers", {})
]);

export type DeployAction = typeof DeployAction.Type;

export const Deployed = Schema.Struct({
  url: Schema.String,
  /** The release the Worker ran before, or undefined when this deploy created it. */
  from: Schema.optional(Schema.String)
});

export type Deployed = typeof Deployed.Type;

/** One piece `ky doctor` checks, and what fixes it. */
export const Check = Schema.Struct({ name: Schema.String, ok: Schema.Boolean, detail: Schema.String, next: Schema.optional(Schema.String) });

export type Check = typeof Check.Type;

/** What to do when the Worker ran a migration this release doesn't have. */
export const NEWER = "get a newer ky: `git pull && pnpm compile` in your ky checkout";

/** Where the user turns Zero Trust on. */
export function zeroTrustPage(accountId: string): string {
  return `https://one.dash.cloudflare.com/${accountId}`;
}

/** Where the user turns Email Routing on for a domain. */
export const emailRoutingPage = (accountId: string, domain: string) => `https://dash.cloudflare.com/${accountId}/${domain}/email/routing/overview`;

/** What renaming the deploy takes. */
export function rename(settings: string): string {
  return `pick another name: set "name" in ${settings}, then run \`ky deploy\``;
}

/** Why a key wrangler.jsonc may hold isn't deployed here. */
const REFUSED = new Map([["containers", "the deployer attaches the cloud machine's container itself, on an account with Workers Paid"]]);

export class NoConfig extends Schema.TaggedError<NoConfig>()("NoConfig", { what: Schema.String }) {
  get refusal(): string {
    return `The config has no ${this.what}; run \`ky init\``;
  }
}

export class BucketName extends Schema.TaggedError<BucketName>()("BucketName", { binding: Schema.String, bucketName: Schema.String }) {
  get refusal(): string {
    return `The ${this.binding} binding's bucket would be ${this.bucketName}, and R2 takes only 3 to 63 lowercase letters, digits and dashes: pick a shorter name`;
  }
}

export class NoSubdomain extends Schema.TaggedError<NoSubdomain>()("NoSubdomain", {}) {
  get refusal(): string {
    return "This account has no workers.dev subdomain yet: run `ky init --subdomain <name>`";
  }
}

/** A Worker, bucket or Access app of this deploy's that ky didn't make. */
export class Taken extends Schema.TaggedError<Taken>()("Taken", { taken: Schema.String, settings: Schema.String }) {
  get refusal(): string {
    return `${this.taken}; ${rename(this.settings)}`;
  }
}

export class ZeroTrustOff extends Schema.TaggedError<ZeroTrustOff>()("ZeroTrustOff", { accountId: Schema.String }) {
  get refusal(): string {
    return `Zero Trust isn't on for this account: turn it on at ${zeroTrustPage(this.accountId)} (the free plan is enough), then run \`ky deploy\``;
  }
}

export class OlderThanWorker extends Schema.TaggedError<OlderThanWorker>()("OlderThanWorker", { applied: Schema.String }) {
  get refusal(): string {
    return `The Worker ran migration ${this.applied}, which this release doesn't have: this ky is older than the Worker; ${NEWER}`;
  }
}

export class CantDeployKey extends Schema.TaggedError<CantDeployKey>()("CantDeployKey", { key: Schema.String }) {
  get refusal(): string {
    return `ky deploy can't deploy \`${this.key}\`: ${REFUSED.get(this.key) ?? "use `pnpm run deploy` from a checkout"}`;
  }
}

export class NoAudience extends Schema.TaggedError<NoAudience>()("NoAudience", { app: Schema.String }) {
  get refusal(): string {
    return `Cloudflare returned no audience tag for the Access app ${this.app}`;
  }
}

export class NoRegistryLogin extends Schema.TaggedError<NoRegistryLogin>()("NoRegistryLogin", {}) {
  get refusal(): string {
    return "Cloudflare returned no registry login";
  }
}

export class NoCloudNamespace extends Schema.TaggedError<NoCloudNamespace>()("NoCloudNamespace", { className: Schema.String, script: Schema.String }) {
  get refusal(): string {
    return `Cloudflare made no ${this.className} namespace for ${this.script}`;
  }
}

export class MailDomainMissing extends Schema.TaggedError<MailDomainMissing>()("MailDomainMissing", { domain: Schema.String }) {
  get refusal(): string {
    return `${this.domain}, ky's mail domain, isn't on this Cloudflare account: add it, then run \`ky deploy\``;
  }
}

export class MailRoutingOff extends Schema.TaggedError<MailRoutingOff>()("MailRoutingOff", { domain: Schema.String, accountId: Schema.String }) {
  get refusal(): string {
    return `Email Routing is off for ${this.domain}: turn it on at ${emailRoutingPage(this.accountId, this.domain)}, then run \`ky deploy\``;
  }
}

export class MailRuleElsewhere extends Schema.TaggedError<MailRuleElsewhere>()("MailRuleElsewhere", {
  address: Schema.String,
  script: Schema.String,
  domain: Schema.String,
  accountId: Schema.String
}) {
  get refusal(): string {
    return `An Email Routing rule already sends ${this.address} elsewhere: point it at the Worker ${this.script} at ${emailRoutingPage(this.accountId, this.domain)}, or pick another address`;
  }
}

/** The login can't route mail: `scopes` is what it needs too, `page` where to make a token with them. */
export class MailScopes extends Schema.TaggedError<MailScopes>()("MailScopes", { address: Schema.String, scopes: Schema.String, page: Schema.String }) {
  get refusal(): string {
    return `Routing ${this.address} to ky needs a token with ${this.scopes} too: add them at ${this.page}, then run \`ky login\``;
  }
}

export class NotOurWorker extends Schema.TaggedError<NotOurWorker>()("NotOurWorker", { script: Schema.String, settings: Schema.String }) {
  get refusal(): string {
    return `A Worker named ${this.script} is in this account and ky didn't deploy it, so ky teardown leaves it alone, with its Access apps and buckets; delete ${this.settings} to forget these settings`;
  }
}

export class AppsLost extends Schema.TaggedError<AppsLost>()("AppsLost", { script: Schema.String, accountId: Schema.String, settings: Schema.String }) {
  get refusal(): string {
    return `This account has no workers.dev subdomain, so ky can't find the Access apps that guarded ${this.script}: remove them at ${zeroTrustPage(this.accountId)}, then delete ${this.settings}`;
  }
}

/** Every reason the deploy domain won't. */
export type DeployRefusal =
  | NoConfig
  | BucketName
  | NoSubdomain
  | Taken
  | ZeroTrustOff
  | OlderThanWorker
  | CantDeployKey
  | NoAudience
  | NoRegistryLogin
  | NoCloudNamespace
  | MailDomainMissing
  | MailRoutingOff
  | MailRuleElsewhere
  | MailScopes
  | NotOurWorker
  | AppsLost;
