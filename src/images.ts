// Turns image sources from the tree into Figma images (plugin side).
import { collectImageSources } from './tree';
import type { HtmlFrame, ImageAssets } from './types';

export interface LoadedImage {
  hash: string;
  /** Pixel size. */
  width: number;
  height: number;
  /** CSS size, for background tiling. */
  intrinsicWidth: number;
}

export interface LoadedImages {
  bySrc: Map<string, LoadedImage>;
  /** Sources that could not be loaded (imported as placeholders or skipped). */
  failed: number;
}

/**
 * Uses the PNG bytes rasterized by the render iframe; sources it could not read
 * (cross-origin without CORS) are fetched by Figma directly.
 */
export async function loadImages(tree: HtmlFrame, assets: ImageAssets): Promise<LoadedImages> {
  const bySrc = new Map<string, LoadedImage>();
  let failed = 0;
  await Promise.all(
    Array.from(collectImageSources(tree).keys(), async (src) => {
      try {
        const asset = assets[src];
        if (asset) {
          const { hash } = figma.createImage(asset.bytes);
          bySrc.set(src, { hash, width: asset.width, height: asset.height, intrinsicWidth: asset.intrinsicWidth });
        } else if (/^https?:/i.test(src)) {
          const image = await figma.createImageAsync(src);
          const { width, height } = await image.getSizeAsync();
          bySrc.set(src, { hash: image.hash, width, height, intrinsicWidth: width });
        } else {
          failed++;
        }
      } catch (error) {
        console.warn(`Could not load image ${src.slice(0, 100)}`, error);
        failed++;
      }
    }),
  );
  return { bySrc, failed };
}
