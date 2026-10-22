// Helpers over the serialized tree, shared by the serializer and the plugin.
import { cssUrl, splitTopLevel } from './css';
import type { HtmlNode } from './types';

/** Largest size (px) each image source is drawn at, keyed by source URL. */
export function collectImageSources(node: HtmlNode, out = new Map<string, { width: number; height: number }>()) {
  const add = (src: string) => {
    const seen = out.get(src);
    out.set(src, {
      width: Math.max(seen?.width ?? 0, node.rect.width),
      height: Math.max(seen?.height ?? 0, node.rect.height),
    });
  };
  if (node.type === 'image') {
    add(node.src);
  } else if (node.type === 'frame') {
    if (node.style.backgroundImage !== 'none') {
      for (const layer of splitTopLevel(node.style.backgroundImage)) {
        const url = cssUrl(layer);
        if (url) add(url);
      }
    }
    node.children.forEach((child) => collectImageSources(child, out));
  }
  return out;
}
