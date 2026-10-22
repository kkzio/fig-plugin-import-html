// ---------------------------------------------------------------------------
// Serialized HTML tree (produced by serializer.ts, consumed by code.ts)
// ---------------------------------------------------------------------------

/** Position and size in document coordinates (px, relative to the page's top-left). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Sides<T> = [top: T, right: T, bottom: T, left: T];
type Corners<T> = [topLeft: T, topRight: T, bottomRight: T, bottomLeft: T];

/**
 * Visual style of an element's box. Colors, gradients and shadows are kept as
 * the browser's computed CSS strings and parsed on the plugin side.
 */
export interface BoxStyle {
  /** False for `visibility: hidden`: the box paints nothing, but children may. */
  visible: boolean;
  opacity: number;
  backgroundColor: string;
  backgroundImage: string;
  backgroundSize: string;
  backgroundPosition: string;
  backgroundRepeat: string;
  borderWidths: Sides<number>;
  borderStyles: Sides<string>;
  borderColors: Sides<string>;
  radii: Corners<number>;
  boxShadow: string;
  /** `overflow` is not `visible` → clip children. */
  clips: boolean;
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle: string;
  /** `normal` or a px value. */
  lineHeight: string;
  /** `normal` or a px value. */
  letterSpacing: string;
  color: string;
  textAlign: string;
  textDecoration: string;
  textTransform: string;
  whiteSpace: string;
}

export interface HtmlFrame {
  type: 'frame';
  name: string;
  rect: Rect;
  style: BoxStyle;
  children: HtmlNode[];
}

export interface HtmlText {
  type: 'text';
  name: string;
  rect: Rect;
  characters: string;
  style: TextStyle;
}

export interface HtmlImage {
  type: 'image';
  name: string;
  rect: Rect;
  /** Absolute URL or data URI. */
  src: string;
  objectFit: string;
  style: BoxStyle;
}

export interface HtmlSvg {
  type: 'svg';
  name: string;
  rect: Rect;
  /** Standalone SVG markup with computed fill/stroke inlined. */
  markup: string;
  opacity: number;
}

export type HtmlNode = HtmlFrame | HtmlText | HtmlImage | HtmlSvg;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Tag on messages posted by the serializer from inside the render iframe. */
export const SERIALIZER_SOURCE = 'import-html-serializer';

/** Initial render size, and the width used for fluid layouts with no width of their own. */
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

export type SerializerPayload =
  /** The page's own width differs from the iframe's: resize the iframe. */
  | { type: 'resize'; width: number; height: number }
  | { type: 'done'; tree: HtmlFrame }
  | { type: 'error'; error: string };

export type SerializerMessage = SerializerPayload & { source: typeof SERIALIZER_SOURCE };

// Messages sent from the UI iframe to the plugin sandbox.
export type UiToPluginMessage =
  | { type: 'import-tree'; tree: HtmlFrame }
  | { type: 'cancel' };

// Messages sent from the plugin sandbox to the UI iframe.
export type PluginToUiMessage =
  | { type: 'import-done' }
  | { type: 'import-error'; message: string };
