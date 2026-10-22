// Parsers for computed CSS values (plugin side).

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseAlpha(part: string | undefined): number {
  if (part === undefined) return 1;
  return part.endsWith('%') ? parseFloat(part) / 100 : parseFloat(part);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function linearToSrgb(c: number): number {
  return clamp01(c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

function oklabToRgb(L: number, a: number, b: number, alpha: number): Rgba {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: alpha,
  };
}

/**
 * Parses a computed color. Browsers normalize most colors to `rgb()`/`rgba()`, but
 * keep `oklch()`, `oklab()` and `color(srgb …)` as authored (e.g. Tailwind v4).
 */
export function parseColor(value: string): Rgba | null {
  value = value.trim();
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const fn = value.match(/^([a-z-]+)\((.*)\)$/i);
  if (!fn) return null;
  const name = fn[1].toLowerCase();
  const [channels, alpha] = fn[2].split('/');
  const parts = channels.split(/[\s,]+/).filter(Boolean);
  // Legacy comma syntax puts alpha as the 4th channel: rgba(0, 0, 0, 0.5)
  const legacyAlpha = name === 'rgb' || name === 'rgba' ? parts[3] : undefined;
  const a = parseAlpha(alpha?.trim() ?? legacyAlpha);
  const num = (part: string, percentScale = 1) =>
    part.endsWith('%') ? (parseFloat(part) / 100) * percentScale : parseFloat(part);

  switch (name) {
    case 'rgb':
    case 'rgba':
      return { r: num(parts[0], 255) / 255, g: num(parts[1], 255) / 255, b: num(parts[2], 255) / 255, a };
    case 'color':
      if (parts[0] !== 'srgb') return null;
      return { r: num(parts[1]), g: num(parts[2]), b: num(parts[3]), a };
    case 'oklab':
      return oklabToRgb(num(parts[0]), num(parts[1], 0.4), num(parts[2], 0.4), a);
    case 'oklch': {
      const hue = (parseFloat(parts[2]) * Math.PI) / 180;
      const chroma = num(parts[1], 0.4);
      return oklabToRgb(num(parts[0]), chroma * Math.cos(hue), chroma * Math.sin(hue), a);
    }
    default:
      return null;
  }
}

/** A solid Figma paint, or null for transparent/unparseable colors. */
export function solidPaint(value: string): SolidPaint | null {
  const c = parseColor(value);
  if (!c || c.a <= 0) return null;
  return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: clamp01(c.a) };
}

/** `normal` or a px value → px number, or null for `normal`. */
export function parsePx(value: string): number | null {
  if (value === 'normal') return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Splits on commas outside parentheses and quotes: `a(1, 2), b` → [`a(1, 2)`, `b`]. */
export function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** The URL of a `url(…)` background layer, or null for other layers (gradients). */
export function cssUrl(layer: string): string | null {
  const match = layer.match(/^url\(\s*(["']?)([\s\S]*)\1\s*\)$/);
  return match ? match[2] : null;
}

export interface Shadow {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: Rgba;
}

/** Parses computed `box-shadow` / `text-shadow` (e.g. `rgba(0, 0, 0, 0.2) 0px 8px 24px 0px`). */
export function parseShadows(value: string): Shadow[] {
  if (!value || value === 'none') return [];
  return splitTopLevel(value).map((layer) => {
    const colorToken = layer.match(/[a-z-]+\([^)]*\)|#[0-9a-f]{3,8}\b|\btransparent\b/i)?.[0];
    const rest = (colorToken ? layer.replace(colorToken, '') : layer).replace(/\binset\b/, '');
    const [x = 0, y = 0, blur = 0, spread = 0] = rest.trim().split(/\s+/).filter(Boolean).map(parseFloat);
    return {
      inset: /\binset\b/.test(layer),
      x,
      y,
      blur,
      spread,
      color: (colorToken && parseColor(colorToken)) || { r: 0, g: 0, b: 0, a: 1 },
    };
  });
}
