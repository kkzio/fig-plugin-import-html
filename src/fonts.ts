// Maps CSS font-family/weight/style to fonts available in Figma and loads them.
import type { HtmlNode, TextStyle } from './types';

const FALLBACK: FontName = { family: 'Inter', style: 'Regular' };

// Generic CSS families → Figma families to try, in order.
const GENERIC_FAMILIES: Record<string, string[]> = {
  'sans-serif': ['Inter', 'Roboto', 'Arial'],
  'system-ui': ['Inter', 'Roboto'],
  '-apple-system': ['SF Pro Text', 'Inter'],
  blinkmacsystemfont: ['SF Pro Text', 'Inter'],
  'ui-sans-serif': ['Inter', 'Roboto'],
  serif: ['Times New Roman', 'Georgia', 'Noto Serif', 'Roboto Serif'],
  'ui-serif': ['Georgia', 'Times New Roman', 'Noto Serif'],
  monospace: ['Roboto Mono', 'Courier New', 'Source Code Pro'],
  'ui-monospace': ['SF Mono', 'Roboto Mono', 'Courier New'],
  cursive: ['Comic Sans MS', 'Caveat'],
  fantasy: ['Impact', 'Inter'],
};

// Longest first so "extrabold" wins over "bold".
const WEIGHT_KEYWORDS: [string, number][] = [
  ['extralight', 200], ['ultralight', 200], ['extrabold', 800], ['ultrabold', 800],
  ['semibold', 600], ['demibold', 600], ['hairline', 100], ['regular', 400], ['medium', 500],
  ['normal', 400], ['light', 300], ['heavy', 900], ['black', 900], ['thin', 100], ['bold', 700],
  ['book', 400],
];

let availableFonts: Map<string, FontName[]> | null = null;

async function getAvailableFonts(): Promise<Map<string, FontName[]>> {
  if (!availableFonts) {
    availableFonts = new Map();
    for (const { fontName } of await figma.listAvailableFontsAsync()) {
      const key = fontName.family.toLowerCase();
      const list = availableFonts.get(key) ?? [];
      list.push(fontName);
      availableFonts.set(key, list);
    }
  }
  return availableFonts;
}

function cssFamilies(fontFamily: string): string[] {
  return fontFamily
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function styleWeight(style: string): number {
  const normalized = style.toLowerCase().replace(/[\s_-]/g, '');
  for (const [keyword, weight] of WEIGHT_KEYWORDS) {
    if (normalized.includes(keyword)) return weight;
  }
  return 400; // "Italic", "Oblique", ""
}

function isItalic(style: string): boolean {
  return /italic|oblique/i.test(style);
}

function pickStyle(fonts: FontName[], weight: number, italic: boolean): FontName {
  let best = fonts[0];
  let bestScore = Infinity;
  for (const font of fonts) {
    const score =
      Math.abs(styleWeight(font.style) - weight) + (isItalic(font.style) === italic ? 0 : 1000);
    if (score < bestScore) {
      best = font;
      bestScore = score;
    }
  }
  return best;
}

export function fontKey(style: TextStyle): string {
  return `${style.fontFamily}|${style.fontWeight}|${style.fontStyle}`;
}

export interface LoadedFonts {
  /** fontKey(style) → loaded Figma font. */
  byKey: Map<string, FontName>;
  /** CSS families that had no match in Figma. */
  missing: Set<string>;
}

function collectTextStyles(node: HtmlNode, out: Map<string, TextStyle>) {
  if (node.type === 'text') out.set(fontKey(node.style), node.style);
  else if (node.type === 'frame') node.children.forEach((child) => collectTextStyles(child, out));
}

/** Resolves and loads every font used in the tree, so nodes can be built synchronously. */
export async function loadFonts(tree: HtmlNode): Promise<LoadedFonts> {
  const available = await getAvailableFonts();
  const styles = new Map<string, TextStyle>();
  collectTextStyles(tree, styles);

  const byKey = new Map<string, FontName>();
  const missing = new Set<string>();
  const loaded = new Map<string, Promise<boolean>>();
  const load = (font: FontName) => {
    const id = `${font.family}|${font.style}`;
    if (!loaded.has(id)) loaded.set(id, figma.loadFontAsync(font).then(() => true, () => false));
    return loaded.get(id)!;
  };

  for (const [key, style] of styles) {
    const families = cssFamilies(style.fontFamily);
    let candidates: FontName[] | undefined;
    for (const family of families) {
      const names = GENERIC_FAMILIES[family.toLowerCase()] ?? [family];
      candidates = names.map((n) => available.get(n.toLowerCase())).find(Boolean);
      if (candidates) break;
    }
    if (!candidates && families[0]) missing.add(families[0]);

    const font = candidates
      ? pickStyle(candidates, style.fontWeight, style.fontStyle !== 'normal')
      : FALLBACK;
    byKey.set(key, (await load(font)) ? font : FALLBACK);
  }

  await load(FALLBACK);
  return { byKey, missing };
}
