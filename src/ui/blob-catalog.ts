import {
  COLORS,
  SHAPES,
  type BotColor,
  type BotShape,
  type ColorId,
  type ShapeId,
} from "./bloub/skins";

export type BlobVariantId = `${ShapeId}-${ColorId}`;

export interface BlobVariant {
  id: BlobVariantId;
  shape: BotShape;
  color: BotColor;
}

function createBlobVariant(shape: BotShape, color: BotColor): BlobVariant {
  const id: BlobVariantId = `${shape.id}-${color.id}`;
  return { id, shape, color };
}

export const BLOB_CATALOG: readonly BlobVariant[] = SHAPES.flatMap((shape) =>
  COLORS.map((color) => createBlobVariant(shape, color)),
);

const BLOB_BY_ID = new Map<BlobVariantId, BlobVariant>(
  BLOB_CATALOG.map((variant) => [variant.id, variant]),
);

const AUTOMATIC_SHAPE_IDS = new Set<ShapeId>(["cercle", "galet", "squircle", "hexagone"]);
const AUTOMATIC_COLOR_IDS = new Set<ColorId>([
  "rouge",
  "orange",
  "vert",
  "turquoise",
  "bleu",
  "violet",
]);

export const AUTOMATIC_BLOB_VARIANTS: readonly BlobVariant[] = BLOB_CATALOG.filter(
  ({ shape, color }) => AUTOMATIC_SHAPE_IDS.has(shape.id) && AUTOMATIC_COLOR_IDS.has(color.id),
);

export function normalizeBlobIdentity(identity: string): string {
  return identity.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function hashBlobIdentity(identity: string): number {
  let hash = 0x811c9dc5;
  for (const character of normalizeBlobIdentity(identity)) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function blobVariantForIdentity(identity: string): BlobVariant {
  const variant =
    AUTOMATIC_BLOB_VARIANTS[hashBlobIdentity(identity) % AUTOMATIC_BLOB_VARIANTS.length];
  if (!variant) throw new RangeError("Automatic blob catalog must contain at least one variant");
  return variant;
}

export function blobPhaseForIdentity(identity: string): number {
  return ((hashBlobIdentity(identity) >>> 8) % 10_000) / 1_000;
}

export function blobVariantById(id: BlobVariantId): BlobVariant | undefined {
  return BLOB_BY_ID.get(id);
}
