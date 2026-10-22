// Runs *inside* the render iframe, appended to the user's HTML. Waits for the page
// (and its scripts) to settle, walks the DOM and posts a serialized tree to the UI.
import { parseColor } from './css';
import {
  DEFAULT_VIEWPORT,
  SERIALIZER_SOURCE,
  type BoxStyle,
  type HtmlFrame,
  type HtmlImage,
  type HtmlNode,
  type HtmlSvg,
  type HtmlText,
  type Rect,
  type SerializerPayload,
  type TextStyle,
} from './types';

/** Max time to wait for the `load` event (slow images, hanging requests). */
const LOAD_TIMEOUT_MS = 8000;
/** Extra time after load for page scripts to finish mutating the DOM. */
const SETTLE_MS = 300;

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE', 'IFRAME',
]);
const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'password', 'search', 'number', 'tel', 'url']);
const BUTTON_INPUT_TYPES = new Set(['button', 'submit', 'reset']);
const SVG_PAINT_PROPS = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity', 'stop-color', 'stop-opacity',
];
const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function px(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function toDocRect(r: DOMRect): Rect {
  return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
}

function isTransparent(color: string): boolean {
  return color === 'transparent' || /^rgba?\(.*[,/]\s*0\)$/.test(color);
}

function nameOf(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id}`;
  if (el.classList.length) return `${tag}.${el.classList[0]}`;
  return tag;
}

/** Computed radius is `10px`, `50%` or elliptical `10px 20px`; Figma needs one number. */
function resolveRadius(value: string, width: number, height: number): number {
  const [h, v = h] = value.split(' ');
  const resolve = (part: string, basis: number) =>
    part.endsWith('%') ? (parseFloat(part) / 100) * basis : px(part);
  return Math.min(resolve(h, width), resolve(v, height));
}

function boxStyle(cs: CSSStyleDeclaration, rect: Rect): BoxStyle {
  const side = (prop: string) => SIDES.map((s) => cs.getPropertyValue(`border-${s}-${prop}`));
  const styles = side('style');
  return {
    visible: cs.visibility === 'visible',
    opacity: px(cs.opacity),
    backgroundColor: cs.backgroundColor,
    backgroundImage: cs.backgroundImage,
    backgroundSize: cs.backgroundSize,
    backgroundPosition: cs.backgroundPosition,
    backgroundRepeat: cs.backgroundRepeat,
    // `border-style: none/hidden` computes to width 0 already, but be explicit.
    borderWidths: side('width').map((w, i) =>
      styles[i] === 'none' || styles[i] === 'hidden' ? 0 : px(w),
    ) as BoxStyle['borderWidths'],
    borderStyles: styles as BoxStyle['borderStyles'],
    borderColors: side('color') as BoxStyle['borderColors'],
    radii: CORNERS.map((c) =>
      resolveRadius(cs.getPropertyValue(`border-${c}-radius`), rect.width, rect.height),
    ) as BoxStyle['radii'],
    boxShadow: cs.boxShadow,
    clips: cs.overflowX !== 'visible' || cs.overflowY !== 'visible',
  };
}

function paintsBox(style: BoxStyle): boolean {
  if (!style.visible) return false;
  return (
    !isTransparent(style.backgroundColor) ||
    style.backgroundImage !== 'none' ||
    style.boxShadow !== 'none' ||
    style.borderWidths.some((w, i) => w > 0 && !isTransparent(style.borderColors[i]))
  );
}

function textStyle(cs: CSSStyleDeclaration, color = cs.color): TextStyle {
  return {
    fontFamily: cs.fontFamily,
    fontSize: px(cs.fontSize),
    fontWeight: px(cs.fontWeight) || 400,
    fontStyle: cs.fontStyle,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing,
    color,
    textAlign: cs.textAlign,
    textDecoration: cs.textDecorationLine,
    textTransform: cs.textTransform,
    whiteSpace: cs.whiteSpace,
  };
}

function textName(characters: string): string {
  const oneLine = characters.replace(/\s+/g, ' ').trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine;
}

// ---------------------------------------------------------------------------
// Node serializers
// ---------------------------------------------------------------------------

function serializeText(node: Text, parentStyle: CSSStyleDeclaration): HtmlText | null {
  if (parentStyle.visibility !== 'visible') return null;

  const ws = parentStyle.whiteSpace;
  let characters = node.data;
  if (ws === 'pre-line') characters = characters.replace(/[ \t]+/g, ' ');
  else if (!/^(pre|pre-wrap|break-spaces)$/.test(ws)) characters = characters.replace(/\s+/g, ' ').trim();
  if (!characters.trim()) return null;

  const range = document.createRange();
  range.selectNodeContents(node);
  const rect = toDocRect(range.getBoundingClientRect());
  if (!rect.width || !rect.height) return null;

  return { type: 'text', name: textName(characters), rect, characters, style: textStyle(parentStyle) };
}

/** The value/placeholder of form controls is not in the DOM as text nodes. */
function formControlText(el: Element, cs: CSSStyleDeclaration, rect: Rect): HtmlText | null {
  let characters = '';
  let color = cs.color;
  let centered = false;

  if (el instanceof HTMLInputElement) {
    const type = el.type.toLowerCase();
    if (BUTTON_INPUT_TYPES.has(type)) {
      characters = el.value;
      centered = true;
    } else if (TEXT_INPUT_TYPES.has(type)) {
      characters = type === 'password' ? '•'.repeat(el.value.length) : el.value;
      if (!characters) {
        characters = el.placeholder;
        color = getComputedStyle(el, '::placeholder').color;
      }
    }
  } else if (el instanceof HTMLTextAreaElement) {
    characters = el.value;
    if (!characters) {
      characters = el.placeholder;
      color = getComputedStyle(el, '::placeholder').color;
    }
  } else if (el instanceof HTMLSelectElement) {
    characters = el.selectedOptions[0]?.text ?? '';
  }
  if (!characters) return null;

  // Text sits in the content box; single-line controls center it vertically.
  const left = px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const right = px(cs.borderRightWidth) + px(cs.paddingRight);
  const top = px(cs.borderTopWidth) + px(cs.paddingTop);
  const bottom = px(cs.borderBottomWidth) + px(cs.paddingBottom);
  const content: Rect = {
    x: rect.x + left,
    y: rect.y + top,
    width: Math.max(0, rect.width - left - right),
    height: Math.max(0, rect.height - top - bottom),
  };
  if (!(el instanceof HTMLTextAreaElement)) {
    const lineHeight = cs.lineHeight === 'normal' ? px(cs.fontSize) * 1.2 : px(cs.lineHeight);
    content.y += Math.max(0, (content.height - lineHeight) / 2);
    content.height = Math.min(content.height, lineHeight);
  }

  const style = textStyle(cs, color);
  if (centered) style.textAlign = 'center';
  return { type: 'text', name: textName(characters), rect: content, characters, style };
}

/** Color attribute → the opacity attribute its alpha is folded into. */
const SVG_COLOR_PROPS: [color: string, opacity: string][] = [
  ['fill', 'fill-opacity'],
  ['stroke', 'stroke-opacity'],
  ['stop-color', 'stop-opacity'],
];

function hex(channel: number): string {
  return Math.round(channel * 255).toString(16).padStart(2, '0');
}

/**
 * Rewrites computed colors (`rgba()`, `oklch()`, …) as `#rrggbb` plus an opacity
 * attribute, and `url("#id")` as `url(#id)`: forms Figma's SVG parser accepts.
 */
function normalizeSvgColors(el: Element) {
  for (const [colorProp, opacityProp] of SVG_COLOR_PROPS) {
    const value = el.getAttribute(colorProp);
    if (!value) continue;
    if (value.startsWith('url(')) {
      el.setAttribute(colorProp, value.replace(/["']/g, ''));
      continue;
    }
    const color = parseColor(value);
    if (!color) continue;
    el.setAttribute(colorProp, `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`);
    const opacity = parseFloat(el.getAttribute(opacityProp) ?? '1');
    el.setAttribute(opacityProp, String((Number.isFinite(opacity) ? opacity : 1) * color.a));
  }
}

function serializeSvg(svg: SVGSVGElement, cs: CSSStyleDeclaration, rect: Rect): HtmlSvg {
  // Styles from stylesheets (and `currentColor`) are lost outside the page, so
  // inline every element's computed paint properties as attributes.
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const sources = [svg, ...Array.from(svg.querySelectorAll('*'))];
  const targets = [clone, ...Array.from(clone.querySelectorAll('*'))];
  sources.forEach((source, i) => {
    const target = targets[i];
    const computed = getComputedStyle(source);
    for (const prop of SVG_PAINT_PROPS) {
      if (prop.startsWith('stop-') && source.tagName !== 'stop') continue;
      const value = computed.getPropertyValue(prop);
      // Attributes take unitless user units (`2.5`, not `2.5px`).
      if (value) target.setAttribute(prop, value.replace(/(\d)px\b/g, '$1'));
    }
    normalizeSvgColors(target);
    if (computed.display === 'none') target.setAttribute('display', 'none');
    if (computed.visibility !== 'visible') target.setAttribute('visibility', 'hidden');
    // Descendants only: the root's size and position come from the measured rect.
    if (i > 0 && computed.transform !== 'none') target.setAttribute('transform', computed.transform);
    // Everything relevant is now an attribute; inline styles would override them.
    target.removeAttribute('style');
    target.removeAttribute('class');
  });
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(rect.width));
  clone.setAttribute('height', String(rect.height));
  // Root opacity is applied to the Figma node instead.
  clone.removeAttribute('opacity');

  return {
    type: 'svg',
    name: nameOf(svg),
    rect,
    markup: new XMLSerializer().serializeToString(clone),
    opacity: px(cs.opacity),
  };
}

function serializeImage(el: HTMLImageElement | HTMLCanvasElement, cs: CSSStyleDeclaration, rect: Rect): HtmlImage | null {
  let src: string;
  if (el instanceof HTMLImageElement) {
    src = el.currentSrc || el.src;
  } else {
    try {
      src = el.toDataURL('image/png');
    } catch {
      return null; // tainted by a cross-origin image
    }
  }
  if (!src) return null;
  return { type: 'image', name: nameOf(el), rect, src, objectFit: cs.objectFit, style: boxStyle(cs, rect) };
}

/** Returns a list because `display: contents` elements are flattened into their parent. */
function serializeElement(el: Element): HtmlNode[] {
  if (SKIP_TAGS.has(el.tagName)) return [];
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || px(cs.opacity) === 0) return [];
  if (cs.display === 'contents') return serializeChildren(el, cs);

  const rect = toDocRect(el.getBoundingClientRect());
  const visible = cs.visibility === 'visible';

  if (el instanceof SVGSVGElement) {
    return visible && rect.width && rect.height ? [serializeSvg(el, cs, rect)] : [];
  }
  if (el instanceof HTMLImageElement || el instanceof HTMLCanvasElement) {
    const image = visible && rect.width && rect.height ? serializeImage(el, cs, rect) : null;
    return image ? [image] : [];
  }

  const style = boxStyle(cs, rect);
  const children = serializeChildren(el, cs);
  const controlText = visible ? formControlText(el, cs, rect) : null;
  if (controlText) children.push(controlText);

  // Drop wrappers that paint nothing and contain nothing.
  if (!children.length && !paintsBox(style)) return [];
  return [{ type: 'frame', name: nameOf(el), rect, style, children }];
}

function serializeChildren(el: Element, cs: CSSStyleDeclaration): HtmlNode[] {
  // Custom elements may render through a shadow root with <slot>s.
  const nodes = el.shadowRoot ? Array.from(el.shadowRoot.childNodes) : Array.from(el.childNodes);
  const result: HtmlNode[] = [];
  for (const node of nodes) {
    if (node instanceof HTMLSlotElement) {
      for (const assigned of node.assignedNodes({ flatten: true })) {
        result.push(...serializeNode(assigned, cs));
      }
    } else {
      result.push(...serializeNode(node, cs));
    }
  }
  return result;
}

function serializeNode(node: Node, parentStyle: CSSStyleDeclaration): HtmlNode[] {
  if (node instanceof Element) return serializeElement(node);
  if (node instanceof Text) {
    const text = serializeText(node, parentStyle);
    return text ? [text] : [];
  }
  return [];
}

const BACKGROUND_PROPS = [
  'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat',
] as const;

function serializeDocument(): HtmlFrame {
  const root = document.documentElement;
  const body = document.body;
  const width = root.clientWidth;
  const height = Math.max(root.scrollHeight, body?.scrollHeight ?? 0, window.innerHeight);
  const rect: Rect = { x: 0, y: 0, width, height };

  // The page canvas takes the <html> background, or <body>'s if <html> has none.
  const rootStyle = boxStyle(getComputedStyle(root), rect);
  const children = body ? serializeElement(body) : [];
  const bodyFrame = children[0]?.type === 'frame' ? children[0] : null;
  const htmlPaints = !isTransparent(rootStyle.backgroundColor) || rootStyle.backgroundImage !== 'none';
  if (!htmlPaints && bodyFrame) {
    for (const prop of BACKGROUND_PROPS) rootStyle[prop] = bodyFrame.style[prop];
    bodyFrame.style.backgroundColor = 'transparent';
    bodyFrame.style.backgroundImage = 'none';
  }
  if (isTransparent(rootStyle.backgroundColor)) rootStyle.backgroundColor = 'rgb(255, 255, 255)';
  Object.assign(rootStyle, {
    visible: true,
    opacity: 1,
    borderWidths: [0, 0, 0, 0],
    radii: [0, 0, 0, 0],
    boxShadow: 'none',
    clips: true,
  });

  return { type: 'frame', name: document.title.trim(), rect, style: rootStyle, children };
}

// ---------------------------------------------------------------------------
// Viewport detection
// ---------------------------------------------------------------------------

/** Two page widths used to check whether the layout stretches with the viewport. */
const PROBE_WIDTHS = [2400, 4800] as const;
/** Max time to wait for the UI to resize the iframe. */
const RESIZE_TIMEOUT_MS = 2000;

/** `<meta name="viewport" content="width=390">` → 390 (ignores `device-width`). */
function metaViewportWidth(): number | null {
  const content = document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '';
  const match = content.match(/(?:^|[,;\s])width\s*=\s*(\d+(?:\.\d+)?)/i);
  return match ? Math.round(parseFloat(match[1])) : null;
}

const REPLACED_TAGS = new Set(['IMG', 'svg', 'CANVAS', 'VIDEO', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);

/** Whether the element itself draws something: a box, text, or replaced content. */
function isVisiblyPainted(el: Element, cs: CSSStyleDeclaration): boolean {
  if (cs.visibility !== 'visible') return false;
  if (REPLACED_TAGS.has(el.tagName)) return true;
  if (
    !isTransparent(cs.backgroundColor) ||
    cs.backgroundImage !== 'none' ||
    cs.boxShadow !== 'none' ||
    SIDES.some((s) => px(cs.getPropertyValue(`border-${s}-width`)) > 0)
  ) {
    return true;
  }
  return Array.from(el.childNodes).some((n) => n instanceof Text && n.data.trim() !== '');
}

/** True if the element or an ancestor is currently held back by a px `max-width`. */
function limitedByMaxWidth(el: Element): boolean {
  for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
    const maxWidth = getComputedStyle(node).maxWidth;
    if (maxWidth.endsWith('px') && Math.abs(node.getBoundingClientRect().width - px(maxWidth)) <= 1) {
      return true;
    }
  }
  return false;
}

interface Extent {
  probeWidth: number;
  /** Width of the widest painted element. */
  maxWidth: number;
  /** That element is capped by `max-width`: a responsive layout. */
  maxWidthLimited: boolean;
  /** Left and right edges of painted in-flow content. */
  minLeft: number;
  maxRight: number;
}

/** Measures the painted content laid out as if `<html>` were `probeWidth` px wide. */
function measureAt(probeWidth: number): Extent {
  const root = document.documentElement;
  const previous = root.style.getPropertyValue('width');
  const priority = root.style.getPropertyPriority('width');
  root.style.setProperty('width', `${probeWidth}px`, 'important');

  const extent: Extent = { probeWidth, maxWidth: 0, maxWidthLimited: false, minLeft: Infinity, maxRight: 0 };
  let widest: Element | null = null;
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (SKIP_TAGS.has(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    const cs = getComputedStyle(el);
    // Transparent wrappers stretch with the page without changing how it looks.
    if (!isVisiblyPainted(el, cs)) continue;
    if (r.width > extent.maxWidth) {
      extent.maxWidth = r.width;
      widest = el;
    }
    // Absolute/fixed boxes may be placed against the real viewport, not the page.
    if (cs.position !== 'absolute' && cs.position !== 'fixed') {
      extent.minLeft = Math.min(extent.minLeft, r.left + window.scrollX);
      extent.maxRight = Math.max(extent.maxRight, r.right + window.scrollX);
    }
  }
  extent.maxWidthLimited = widest !== null && limitedByMaxWidth(widest);

  root.style.setProperty('width', previous, priority);
  return extent;
}

/**
 * The page's own width: an explicit `<meta viewport>` width, else the width of a
 * fixed-width design, else DEFAULT_VIEWPORT.width for fluid layouts.
 */
function detectWidth(): number {
  const meta = metaViewportWidth();
  if (meta) return meta;
  if (!document.body) return DEFAULT_VIEWPORT.width;

  // A fluid layout stretches when the page gets wider (or is only held back by
  // `max-width`); a fixed-width design measures the same at any width. Probing
  // wide, not narrow, keeps flex items from shrinking below their set width.
  const [a, b] = PROBE_WIDTHS.map(measureAt);
  const fixed = a.maxWidth > 0 && Math.abs(b.maxWidth - a.maxWidth) <= 1 && !a.maxWidthLimited;
  if (!fixed || a.maxRight <= a.minLeft) return DEFAULT_VIEWPORT.width;

  // Centered content (equal gaps) is the design itself; otherwise keep the
  // smaller gap (usually the body margin) on both sides.
  const span = a.maxRight - a.minLeft;
  const leftGap = a.minLeft;
  const rightGap = a.probeWidth - a.maxRight;
  const centered = Math.abs(leftGap - rightGap) <= 2;
  const margin = centered ? 0 : Math.max(0, Math.min(leftGap, rightGap));
  const width = Math.ceil(span + 2 * margin);
  return width >= 100 ? width : DEFAULT_VIEWPORT.width;
}

/** Typical device height for a width, so `100vh` sections look right. */
function viewportHeight(width: number): number {
  if (width <= 600) return 812;
  if (width <= 1100) return 1024;
  return DEFAULT_VIEWPORT.height;
}

function waitForWidth(width: number): Promise<void> {
  return new Promise((resolve) => {
    if (window.innerWidth === width) return resolve();
    const timer = setTimeout(done, RESIZE_TIMEOUT_MS);
    function onResize() {
      if (window.innerWidth === width) done();
    }
    function done() {
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
      resolve();
    }
    window.addEventListener('resize', onResize);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function post(message: SerializerPayload) {
  parent.postMessage({ source: SERIALIZER_SOURCE, ...message }, '*');
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

function waitForLoad(): Promise<void> {
  if (document.readyState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    window.addEventListener('load', () => resolve(), { once: true });
    setTimeout(resolve, LOAD_TIMEOUT_MS);
  });
}

async function run() {
  try {
    await waitForLoad();
    await document.fonts.ready;
    await settle();

    const width = detectWidth();
    if (width !== window.innerWidth) {
      post({ type: 'resize', width, height: viewportHeight(width) });
      await waitForWidth(width);
      await settle(); // let resize handlers and media queries apply
    }

    post({ type: 'done', tree: serializeDocument() });
  } catch (error) {
    post({ type: 'error', error: String(error) });
  }
}

// This script is parsed after the page body, before `load`: make lazy images load
// now (the render iframe is only one viewport tall) and hide the scrollbar so the
// layout width equals the chosen viewport width.
document.querySelectorAll('img[loading="lazy"]').forEach((img) => {
  (img as HTMLImageElement).loading = 'eager';
});
document.documentElement.style.setProperty('scrollbar-width', 'none');
run();
