import type { ImageContent } from "@earendil-works/pi-ai";
import { IMAGE_TYPES, MAX_IMAGE_CHARS, MAX_IMAGE_SIDE, MAX_IMAGES } from "../images";

/** An image picked in the composer, ready to send. */
export type PendingImage = ImageContent & {
  readonly id: string;
  readonly name: string;
};

/** Each image's share of what one message may carry. */
const IMAGE_CHARS = Math.floor(MAX_IMAGE_CHARS / MAX_IMAGES);

const QUALITIES = [0.85, 0.72, 0.6];

const base64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image."));
    reader.readAsDataURL(blob);
  });

const encode = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image."))),
      "image/jpeg",
      quality
    )
  );

/**
 * Read a picked, pasted or dropped file. A small image in a type models take
 * goes as it is, so screenshots stay sharp; anything else is scaled to fit
 * MAX_IMAGE_SIDE and re-encoded as JPEG, smaller each try until it fits.
 */
export async function prepareImage(file: File): Promise<PendingImage> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error(`${file.name || "That file"} isn't an image ky can read.`);
  });

  const id = crypto.randomUUID();
  const name = file.name || "image";

  try {
    const fits = Math.max(bitmap.width, bitmap.height) <= MAX_IMAGE_SIDE;

    if (fits && IMAGE_TYPES.has(file.type) && file.size * 1.37 <= IMAGE_CHARS) {
      return { type: "image", id, name, mimeType: file.type, data: await base64(file) };
    }

    let scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));

    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");

      if (context === null) throw new Error("This browser can't resize images.");
      // JPEG has no transparency; without a backdrop clear pixels turn black.
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      for (const quality of QUALITIES) {
        const data = await base64(await encode(canvas, quality));

        if (data.length <= IMAGE_CHARS) return { type: "image", id, name, mimeType: "image/jpeg", data };
      }

      scale *= 0.75;
    }

    throw new Error(`${name} is too large to send.`);
  } finally {
    bitmap.close();
  }
}

export const imageSrc = (image: ImageContent) => `data:${image.mimeType};base64,${image.data}`;
