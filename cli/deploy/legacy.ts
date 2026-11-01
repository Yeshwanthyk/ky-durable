/**
 * The markers an earlier ky left in owners' accounts, before the deploy identity in contract.ts went neutral.
 * The deployer reads them only to recognize what an earlier ky deployed: such a Worker, Access app or bucket
 * is ours, and the next deploy re-marks it with today's identity. Nothing new is ever marked with them.
 *
 * Delete this module, and each use of it, once every known deploy has been redeployed. With it go the tests'
 * copies of the old identity: `earlierKy` in test/fakes/cloudflare.ts, the `"ky"` and `".ky"` in
 * test/invariants/deploy.test.ts's `ourTags`/`ourBucket` and its I-D8, and the earlier-release block in
 * test/node/cli.test.ts. The account-level `ky` Access tag stays in each account the deploys came from:
 * remove it there by hand once no Access app carries it.
 */
const TAG = "ky";

const RELEASE_TAG = "ky-release-";

export const LEGACY_MARKER = ".ky";

/** Whether a Worker's or Access app's tags are an earlier ky's. */
export function legacyTagged(tags: readonly string[] | null | undefined): boolean {
  return tags?.includes(TAG) ?? false;
}

/** The release an earlier ky's Worker tags name. */
export function legacyRelease(tags: readonly string[] | null | undefined): string | undefined {
  return tags?.find((tag) => tag.startsWith(RELEASE_TAG))?.slice(RELEASE_TAG.length);
}
