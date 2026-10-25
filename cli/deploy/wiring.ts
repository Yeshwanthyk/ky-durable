/**
 * The deploy domain's edge: each action runs the Deployer through the login's `Cloudflare.run`; a
 * refusal throws as `Refused` in its own words, Cloudflare's error as a CloudflareError, and a defect
 * as it was thrown.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Cloudflare, Services } from "../cloudflare.ts";
import type { Release } from "../release.ts";
import { DeployRefusal } from "./contract.ts";
import { Deployer, type Deploys, type Site } from "./deployer.ts";

/** One deploy target: an account, the config to deploy there, and the overlay it came from. */
export type Target = Site & { readonly cloudflare: Cloudflare };

/** Why the deploy won't, thrown in B's words: the message is what the user reads. */
export class Refused extends Error {
  /** The refusal itself, such as `Taken`. */
  readonly reason: DeployRefusal;

  constructor(reason: DeployRefusal) {
    super(reason.refusal);
    this.reason = reason;
  }
}

const isRefusal = Schema.is(DeployRefusal);

const run = <A, E>(cloudflare: Cloudflare, action: (deployer: Deploys) => Effect.Effect<A, E, Services>) =>
  cloudflare.run(
    Deployer.use(action).pipe(
      Effect.provide(Deployer.layer),
      Effect.catchIf(isRefusal, (refusal) => Effect.die(new Refused(refusal)))
    )
  );

/** The deploy's Worker, when there is one, and its address, once nothing of its names is one ky didn't make; it writes nothing. */
export const claim = (target: Target) => run(target.cloudflare, (deployer) => deployer.claim(target));

/** The Worker's address, from the account's workers.dev subdomain. */
export const address = (target: Target) => run(target.cloudflare, (deployer) => deployer.address(target));

/** The account's Access team domain; undefined until Zero Trust is on. */
export const teamDomain = (cloudflare: Cloudflare, accountId: string) => run(cloudflare, (deployer) => deployer.teamDomain(accountId));

export const deploy = (target: Target, release: Release, say: (step: string) => void) => run(target.cloudflare, (deployer) => deployer.deploy(target, release, say));

/** The release the Worker runs, or undefined when there's no Worker. */
export const deployedRelease = (target: Target) => run(target.cloudflare, (deployer) => deployer.deployedRelease(target));

/** Every piece of a deploy, checked in order, each with what fixes it. */
export const inspect = (target: Target, release: Release) => run(target.cloudflare, (deployer) => deployer.inspect(target, release, target.cloudflare.login));

export const teardown = (target: Target, say: (step: string) => void) => run(target.cloudflare, (deployer) => deployer.teardown(target, say));

/** What teardown should have removed that's still in the account. */
export const leftovers = (target: Target) => run(target.cloudflare, (deployer) => deployer.leftovers(target));
