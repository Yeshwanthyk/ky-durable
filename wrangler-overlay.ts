/**
 * The owner overlay (wrangler.local.jsonc) over the generic wrangler.jsonc, as
 * vite.config.ts applies it for `pnpm start`: vars merge,
 * VPC services are added, and anything else the overlay sets replaces
 * wrangler.jsonc's. It changes `config` in place, since a config the Vite
 * plugin's `config` hook returns is merged again, adding every array to itself.
 */
import type { Unstable_RawConfig } from "wrangler";

export function applyOverlay(
  config: Pick<Unstable_RawConfig, "vars" | "vpc_services">,
  overlay: Unstable_RawConfig
): void {
  Object.assign(config, {
    ...overlay,
    vars: { ...config.vars, ...overlay.vars },
    vpc_services: [...(config.vpc_services ?? []), ...(overlay.vpc_services ?? [])]
  });
}
