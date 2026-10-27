import type { Api, Model } from "@earendil-works/pi-ai";

export type Offer = { readonly featured: readonly string[]; readonly light?: string };

type Offered = { readonly models: readonly Model<Api>[]; readonly featured: readonly Model<Api>[]; readonly light?: Model<Api> };

const SNAPSHOT = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

export function offered(catalog: readonly Model<Api>[], offer: Offer): Offered {
  const find = (id: string) => catalog.find((model) => model.id === id);
  const found = offer.featured.flatMap((id) => find(id) ?? []);
  const featured = found.length > 0 ? found : catalog.slice(0, 1);
  const light = offer.light === undefined ? undefined : find(offer.light);
  const rest = catalog.filter((model) => !featured.includes(model) && !SNAPSHOT.test(model.id));
  const models = [...featured, ...rest];

  return light ? { models, featured, light } : { models, featured };
}

export function missing(catalog: readonly Model<Api>[], offer: Offer): string[] {
  return [...offer.featured, ...(offer.light === undefined ? [] : [offer.light])].filter((id) => !catalog.some((model) => model.id === id));
}
