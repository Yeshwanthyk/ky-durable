import * as Schema from "effect/Schema";

import type { Refusable } from "../../src/core/edge.ts";

/**
 * How the deployer knows what it owns in an owner's Cloudflare account: the tag on its Worker and Access
 * apps, the tag prefix naming the release a Worker runs, and the object marking its buckets. They are
 * identities stored in owners' accounts, not the product's name: never change them with branding, or the
 * next deploy reads every existing deploy as someone else's. An earlier ky's markers are in legacy.ts.
 */
export const TAG = "self-hosted-agent";

export const RELEASE_TAG = "self-hosted-agent-release-";

export const MARKER = ".self-hosted-agent";

const Deployed = Schema.Struct({
  url: Schema.String,
  from: Schema.optional(Schema.String)
});

export type Deployed = typeof Deployed.Type;

const Check = Schema.Struct({ name: Schema.String, ok: Schema.Boolean, detail: Schema.String, next: Schema.optional(Schema.String) });

export type Check = typeof Check.Type;

export const NEWER = "get a newer ky: `git pull && pnpm compile` in your ky checkout";

export function zeroTrustPage(accountId: string): string {
  return `https://one.dash.cloudflare.com/${accountId}`;
}

const emailRoutingPage = (accountId: string, domain: string) => `https://dash.cloudflare.com/${accountId}/${domain}/email/routing/overview`;

export function rename(settings: string): string {
  return `pick another name: set "name" in ${settings}, then run \`ky deploy\``;
}

const REFUSED = new Map([["containers", "the deployer attaches the cloud machine's container itself, on an account with Workers Paid"]]);

export class NoConfig extends Schema.TaggedError<NoConfig>()("NoConfig", { what: Schema.String }) implements Refusable {
  get refusal(): string {
    return `The config has no ${this.what}; run \`ky init\``;
  }
}

export class BucketName extends Schema.TaggedError<BucketName>()("BucketName", { binding: Schema.String, bucketName: Schema.String }) implements Refusable {
  get refusal(): string {
    return `The ${this.binding} binding's bucket would be ${this.bucketName}, and R2 takes only 3 to 63 lowercase letters, digits and dashes: pick a shorter name`;
  }
}

export class NoSubdomain extends Schema.TaggedError<NoSubdomain>()("NoSubdomain", {}) implements Refusable {
  get refusal(): string {
    return "This account has no workers.dev subdomain yet: run `ky init --subdomain <name>`";
  }
}

export class Taken extends Schema.TaggedError<Taken>()("Taken", { taken: Schema.String, settings: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.taken}; ${rename(this.settings)}`;
  }
}

export class ZeroTrustOff extends Schema.TaggedError<ZeroTrustOff>()("ZeroTrustOff", { accountId: Schema.String }) implements Refusable {
  get refusal(): string {
    return `Zero Trust isn't on for this account: turn it on at ${zeroTrustPage(this.accountId)} (the free plan is enough), then run \`ky deploy\``;
  }
}

export class OlderThanWorker extends Schema.TaggedError<OlderThanWorker>()("OlderThanWorker", { applied: Schema.String }) implements Refusable {
  get refusal(): string {
    return `The Worker ran migration ${this.applied}, which this release doesn't have: this ky is older than the Worker; ${NEWER}`;
  }
}

export class CantDeployKey extends Schema.TaggedError<CantDeployKey>()("CantDeployKey", { key: Schema.String }) implements Refusable {
  get refusal(): string {
    return `ky deploy can't deploy \`${this.key}\`: ${REFUSED.get(this.key) ?? "use `pnpm run deploy` from a checkout"}`;
  }
}

export class NoAudience extends Schema.TaggedError<NoAudience>()("NoAudience", { app: Schema.String }) implements Refusable {
  get refusal(): string {
    return `Cloudflare returned no audience tag for the Access app ${this.app}`;
  }
}

export class NoRegistryLogin extends Schema.TaggedError<NoRegistryLogin>()("NoRegistryLogin", {}) implements Refusable {
  get refusal(): string {
    return "Cloudflare returned no registry login";
  }
}

export class NoCloudNamespace extends Schema.TaggedError<NoCloudNamespace>()("NoCloudNamespace", { className: Schema.String, script: Schema.String }) implements Refusable {
  get refusal(): string {
    return `Cloudflare made no ${this.className} namespace for ${this.script}`;
  }
}

export class MailDomainMissing extends Schema.TaggedError<MailDomainMissing>()("MailDomainMissing", { domain: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.domain}, ky's mail domain, isn't on this Cloudflare account: add it, then run \`ky deploy\``;
  }
}

export class MailRoutingOff extends Schema.TaggedError<MailRoutingOff>()("MailRoutingOff", { domain: Schema.String, accountId: Schema.String }) implements Refusable {
  get refusal(): string {
    return `Email Routing is off for ${this.domain}: turn it on at ${emailRoutingPage(this.accountId, this.domain)}, then run \`ky deploy\``;
  }
}

export class MailRuleElsewhere extends Schema.TaggedError<MailRuleElsewhere>()("MailRuleElsewhere", {
  address: Schema.String,
  script: Schema.String,
  domain: Schema.String,
  accountId: Schema.String
}) implements Refusable {
  get refusal(): string {
    return `An Email Routing rule already sends ${this.address} elsewhere: point it at the Worker ${this.script} at ${emailRoutingPage(this.accountId, this.domain)}, or pick another address`;
  }
}

export class MailScopes extends Schema.TaggedError<MailScopes>()("MailScopes", { address: Schema.String, scopes: Schema.String, page: Schema.String }) implements Refusable {
  get refusal(): string {
    return `Routing ${this.address} to ky needs a token with ${this.scopes} too: add them at ${this.page}, then run \`ky login\``;
  }
}

export class NotOurWorker extends Schema.TaggedError<NotOurWorker>()("NotOurWorker", { script: Schema.String, settings: Schema.String }) implements Refusable {
  get refusal(): string {
    return `A Worker named ${this.script} is in this account and ky didn't deploy it, so ky teardown leaves it alone, with its Access apps and buckets; delete ${this.settings} to forget these settings`;
  }
}

export class AppsLost extends Schema.TaggedError<AppsLost>()("AppsLost", { script: Schema.String, accountId: Schema.String, settings: Schema.String }) implements Refusable {
  get refusal(): string {
    return `This account has no workers.dev subdomain, so ky can't find the Access apps that guarded ${this.script}: remove them at ${zeroTrustPage(this.accountId)}, then delete ${this.settings}`;
  }
}

export const DeployRefusal = Schema.Union([
  NoConfig,
  BucketName,
  NoSubdomain,
  Taken,
  ZeroTrustOff,
  OlderThanWorker,
  CantDeployKey,
  NoAudience,
  NoRegistryLogin,
  NoCloudNamespace,
  MailDomainMissing,
  MailRoutingOff,
  MailRuleElsewhere,
  MailScopes,
  NotOurWorker,
  AppsLost
]);

export type DeployRefusal = typeof DeployRefusal.Type;
