// CSS backgrounds and shadows → Figma paints and effects (plugin side).
import { cssUrl, parseColor, parseShadows, solidPaint, splitTopLevel, type Rgba } from './css';
import type { LoadedImage } from './images';
import type { BoxStyle } from './types';

type Matrix = [[number, number, number], [number, number, number]];

function invert([[a, b, c], [d, e, f]]: Matrix): Transform {
  const det = a * e - b * d;
  if (!det) return [[1, 0, 0], [0, 1, 0]];
  return [
    [e / det, -b / det, (b * f - c * e) / det],
    [-d / det, a / det, (c * d - a * f) / det],
  ];
}

// ---------------------------------------------------------------------------
// Gradients
// ---------------------------------------------------------------------------

interface RawStop {
  color: Rgba;
  /** 0–1 along the gradient line, or null when the CSS stop has no position. */
  position: number | null;
}

/** `rgb(…) 20%`, `rgb(…) 10px 30px`, `rgb(…)`; bare hints like `30%` are skipped. */
function parseStops(parts: string[], lineLength: number): ColorStop[] {
  const raw: RawStop[] = [];
  for (const part of parts) {
    const match = part.match(/^([a-z-]+\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+)\s*(.*)$/i);
    const color = match && parseColor(match[1]);
    if (!color) continue;
    const positions = match[2]
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / lineLength));
    if (!positions.length) raw.push({ color, position: null });
    for (const position of positions) raw.push({ color, position });
  }
  if (!raw.length) return [];

  // CSS rules: first/last default to 0/1, positions never go backwards, and
  // missing ones are spread evenly between their neighbors.
  if (raw[0].position === null) raw[0].position = 0;
  if (raw[raw.length - 1].position === null) raw[raw.length - 1].position = 1;
  let max = 0;
  for (const stop of raw) {
    if (stop.position !== null) max = stop.position = Math.max(stop.position, max);
  }
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].position !== null) continue;
    const start = i - 1;
    let end = i;
    while (raw[end].position === null) end++;
    const from = raw[start].position!;
    const to = raw[end].position!;
    for (let j = i; j < end; j++) raw[j].position = from + ((to - from) * (j - start)) / (end - start);
  }

  // Fully transparent stops fade a neighbor's color (as CSS does), not black.
  return raw.map((stop, i) => {
    let { r, g, b } = stop.color;
    if (stop.color.a === 0) {
      const neighbor = raw.slice(0, i).reverse().find((s) => s.color.a > 0) ?? raw.slice(i + 1).find((s) => s.color.a > 0);
      if (neighbor) ({ r, g, b } = neighbor.color);
    }
    return { position: Math.min(1, Math.max(0, stop.position!)), color: { r, g, b, a: stop.color.a } };
  });
}

const SIDE_ANGLES: Record<string, number> = { top: 0, right: 90, bottom: 180, left: 270 };

/** CSS gradient direction (`135deg`, `0.25turn`, `to top right`) → degrees, or null. */
function parseAngle(token: string, width: number, height: number): number | null {
  const unit = token.match(/^(-?[\d.]+)(deg|rad|turn|grad)$/);
  if (unit) {
    const n = parseFloat(unit[1]);
    return { deg: n, rad: (n * 180) / Math.PI, turn: n * 360, grad: n * 0.9 }[unit[2] as 'deg'];
  }
  const to = token.match(/^to\s+(\w+)(?:\s+(\w+))?$/);
  if (!to) return null;
  const sides = [to[1], to[2]].filter(Boolean) as string[];
  if (sides.length === 1) return SIDE_ANGLES[sides[0]] ?? 180;
  // Corners: the gradient line is perpendicular to the diagonal between the other two corners.
  const corner = Math.atan2(height, width) * (180 / Math.PI);
  const vertical = sides.find((s) => s === 'top' || s === 'bottom');
  const horizontal = sides.find((s) => s === 'left' || s === 'right');
  if (vertical === 'top') return horizontal === 'right' ? corner : 360 - corner;
  return horizontal === 'right' ? 180 - corner : 180 + corner;
}

function linearGradient(args: string, width: number, height: number): GradientPaint | null {
  const parts = splitTopLevel(args);
  let angle = parts.length ? parseAngle(parts[0], width, height) : null;
  if (angle !== null) parts.shift();
  else angle = 180;

  // The gradient line passes through the center, long enough to reach the corners.
  const rad = (angle * Math.PI) / 180;
  const dir = { x: Math.sin(rad), y: -Math.cos(rad) };
  const length = Math.abs(width * dir.x) + Math.abs(height * dir.y);
  const start = { x: width / 2 - (dir.x * length) / 2, y: height / 2 - (dir.y * length) / 2 };
  const delta = { x: dir.x * length, y: dir.y * length };
  const perp = { x: -delta.y, y: delta.x };

  const stops = parseStops(parts, length);
  if (stops.length < 2) return null;
  // Gradient space (0,0.5)→(1,0.5) mapped onto the line, in the node's 0–1 space.
  const toNode: Matrix = [
    [delta.x / width, perp.x / width, (start.x - perp.x / 2) / width],
    [delta.y / height, perp.y / height, (start.y - perp.y / 2) / height],
  ];
  return { type: 'GRADIENT_LINEAR', gradientStops: stops, gradientTransform: invert(toNode) };
}

/** A position component (`30%`, `20px`, `left`, `center`) → px along `size`. */
function positionPx(token: string | undefined, size: number): number {
  if (!token || token === 'center') return size / 2;
  if (token === 'left' || token === 'top') return 0;
  if (token === 'right' || token === 'bottom') return size;
  return token.endsWith('%') ? (parseFloat(token) / 100) * size : parseFloat(token);
}

function radialGradient(args: string, width: number, height: number): GradientPaint | null {
  const parts = splitTopLevel(args);
  let spec = '';
  if (parts.length && /^(circle|ellipse|at\s|closest-|farthest-|-?[\d.])/.test(parts[0])) spec = parts.shift()!;

  const [shapeSize, at] = spec.split(/\s*\bat\b\s*/);
  const tokens = (shapeSize ?? '').split(/\s+/).filter(Boolean);
  let position = (at ?? '').split(/\s+/).filter(Boolean);
  if (position[0] === 'top' || position[0] === 'bottom') position = [position[1] ?? 'center', position[0]];
  const cx = positionPx(position[0], width);
  const cy = positionPx(position[1], height);

  const lengths = tokens.filter((t) => /^-?[\d.]/.test(t));
  const keyword = tokens.find((t) => /^(closest|farthest)-/.test(t)) ?? 'farthest-corner';
  const circle = tokens.includes('circle') || (lengths.length === 1 && !tokens.includes('ellipse'));
  const dx = [cx, width - cx].map(Math.abs);
  const dy = [cy, height - cy].map(Math.abs);
  let rx: number;
  let ry: number;
  if (lengths.length) {
    rx = positionPx(lengths[0], width);
    ry = lengths[1] ? positionPx(lengths[1], height) : rx;
  } else {
    const pick = keyword.startsWith('closest') ? Math.min : Math.max;
    const sideX = pick(...dx);
    const sideY = pick(...dy);
    if (keyword.endsWith('side')) {
      rx = circle ? pick(sideX, sideY) : sideX;
      ry = circle ? rx : sideY;
    } else if (circle) {
      rx = ry = Math.hypot(sideX, sideY);
    } else {
      // An ellipse through the corner keeps the side ratio.
      rx = sideX * Math.SQRT2;
      ry = sideY * Math.SQRT2;
    }
  }
  rx = Math.max(rx, 0.01);
  ry = Math.max(ry, 0.01);

  const stops = parseStops(parts, rx);
  if (stops.length < 2) return null;
  // Gradient space: center (0.5, 0.5), radius 0.5.
  const toNode: Matrix = [
    [(2 * rx) / width, 0, (cx - rx) / width],
    [0, (2 * ry) / height, (cy - ry) / height],
  ];
  return { type: 'GRADIENT_RADIAL', gradientStops: stops, gradientTransform: invert(toNode) };
}

// ---------------------------------------------------------------------------
// Backgrounds
// ---------------------------------------------------------------------------

function imagePaint(
  image: LoadedImage,
  size: string,
  repeat: string,
  width: number,
): ImagePaint {
  if (size === 'contain') return { type: 'IMAGE', imageHash: image.hash, scaleMode: 'FIT' };
  if (size !== 'cover' && !repeat.includes('no-repeat')) {
    // Repeating background: tile at the CSS tile width (Figma scales from pixel size).
    const tileWidth = size.startsWith('auto') ? image.intrinsicWidth : positionPx(size.split(' ')[0], width);
    return { type: 'IMAGE', imageHash: image.hash, scaleMode: 'TILE', scalingFactor: tileWidth / image.width };
  }
  return { type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' };
}

/** Background color and layers (gradients, images) as Figma fills, bottom first. */
export function backgroundPaints(
  style: BoxStyle,
  width: number,
  height: number,
  images: Map<string, LoadedImage>,
): Paint[] {
  const paints: Paint[] = [];
  const color = solidPaint(style.backgroundColor);
  if (color) paints.push(color);
  if (style.backgroundImage === 'none' || !width || !height) return paints;

  const layers = splitTopLevel(style.backgroundImage);
  const sizes = splitTopLevel(style.backgroundSize);
  const repeats = splitTopLevel(style.backgroundRepeat);
  // CSS lists the top layer first; Figma paints the last fill on top.
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const fn = layer.match(/^([a-z-]+)\(([\s\S]*)\)$/);
    let paint: Paint | null = null;
    const url = cssUrl(layer);
    if (url) {
      const image = images.get(url);
      if (image) paint = imagePaint(image, sizes[i % sizes.length] ?? 'auto', repeats[i % repeats.length] ?? 'repeat', width);
    } else if (fn?.[1] === 'linear-gradient' || fn?.[1] === 'repeating-linear-gradient') {
      paint = linearGradient(fn[2], width, height);
    } else if (fn?.[1] === 'radial-gradient' || fn?.[1] === 'repeating-radial-gradient') {
      paint = radialGradient(fn[2], width, height);
    }
    if (paint) paints.push(paint);
  }
  return paints;
}

/** `<img>` fill for a CSS `object-fit` value. */
export function objectFitPaint(image: LoadedImage, objectFit: string): ImagePaint {
  switch (objectFit) {
    case 'cover':
    case 'none':
      return { type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' };
    case 'contain':
    case 'scale-down':
      return { type: 'IMAGE', imageHash: image.hash, scaleMode: 'FIT' };
    default:
      // `fill` (the default) stretches the image to the box: CROP with identity.
      return { type: 'IMAGE', imageHash: image.hash, scaleMode: 'CROP', imageTransform: [[1, 0, 0], [0, 1, 0]] };
  }
}

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------

/** `box-shadow` / `text-shadow` → Figma effects. */
export function shadowEffects(value: string): Effect[] {
  return (
    parseShadows(value)
      .filter((s) => s.color.a > 0)
      // CSS paints the first shadow on top; Figma paints the last effect on top.
      .reverse()
      .map((s): Effect => {
        const base = {
          color: s.color,
          offset: { x: s.x, y: s.y },
          radius: s.blur,
          spread: s.spread,
          visible: true,
          blendMode: 'NORMAL' as const,
        };
        return s.inset ? { type: 'INNER_SHADOW', ...base } : { type: 'DROP_SHADOW', ...base, showShadowBehindNode: false };
      })
  );
}
