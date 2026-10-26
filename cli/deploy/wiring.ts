import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Cloudflare, Services } from "../cloudflare.ts";
import type { Release } from "../release.ts";
import { DeployRefusal } from "./contract.ts";
import { Deployer, type Site } from "./deployer.ts";

export type Target = Site & { readonly cloudflare: Cloudflare };

export class Refused extends Error {
  readonly reason: DeployRefusal;

  constructor(reason: DeployRefusal) {
    super(reason.refusal);
    this.reason = reason;
  }
}

const isRefusal = Schema.is(DeployRefusal);

const run = <A, E>(cloudflare: Cloudflare, action: Effect.Effect<A, E, Services>) =>
  cloudflare.run(action.pipe(Effect.catchIf(isRefusal, (refusal) => Effect.die(new Refused(refusal)))));

export const claim = (target: Target) => run(target.cloudflare, Deployer.claim(target));

export const address = (target: Target) => run(target.cloudflare, Deployer.address(target));

export const teamDomain = (cloudflare: Cloudflare, accountId: string) => run(cloudflare, Deployer.teamDomain(accountId));

export const deploy = (target: Target, release: Release, say: (step: string) => void) => run(target.cloudflare, Deployer.deploy(target, release, say));

export const deployedRelease = (target: Target) => run(target.cloudflare, Deployer.deployedRelease(target));

export const inspect = (target: Target, release: Release) => run(target.cloudflare, Deployer.inspect(target, release, target.cloudflare.login));

export const teardown = (target: Target, say: (step: string) => void) => run(target.cloudflare, Deployer.teardown(target, say));

export const leftovers = (target: Target) => run(target.cloudflare, Deployer.leftovers(target));
