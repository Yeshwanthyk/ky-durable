import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * What a provider offers from its catalog: every model there, with a few
 * featured first. Featured models are the ones Settings lists up front and
 * ky picks by default; the rest stay one click away, so a model the catalog
 * gains needs no change here. Dated snapshots (claude-haiku-4-5-20251001,
 * gpt-4o-2024-05-13) duplicate an undated alias and are left out.
 */
export type Offer = {
  /** The models shown up front, the first being the provider's default. */
  readonly featured: readonly string[];
  /** Its quick, cheap model, for background work while it stands in. */
  readonly light?: string;
};

export type Offered = {
  /** Every model offered: the featured ones first, in order, then the rest of the catalog. */
  readonly models: readonly Model<Api>[];
  /** The featured ones, the same objects as in `models`. */
  readonly featured: readonly Model<Api>[];
  readonly light?: Model<Api>;
};

const SNAPSHOT = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

/**
 * `offer` resolved against `catalog`. A featured or light model the catalog lacks is left out, and the
 * catalog's first model stands in when no featured one is left, so starting never throws; `missing` is
 * what a test checks, so a pi-ai that drops one fails there instead.
 */
export function offered(catalog: readonly Model<Api>[], offer: Offer): Offered {
  const find = (id: string) => catalog.find((model) => model.id === id);
  const found = offer.featured.flatMap((id) => find(id) ?? []);
  const featured = found.length > 0 ? found : catalog.slice(0, 1);
  const light = offer.light === undefined ? undefined : find(offer.light);
  const rest = catalog.filter((model) => !featured.includes(model) && !SNAPSHOT.test(model.id));
  const models = [...featured, ...rest];

  return light ? { models, featured, light } : { models, featured };
}

/** The ids `offer` names that `catalog` lacks. */
export function missing(catalog: readonly Model<Api>[], offer: Offer): string[] {
  return [...offer.featured, ...(offer.light === undefined ? [] : [offer.light])].filter((id) => !catalog.some((model) => model.id === id));
}
