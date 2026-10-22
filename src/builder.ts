// Builds Figma nodes from the serialized HTML tree. Every node is absolutely
// positioned inside its parent frame, using the coordinates measured by the browser.
import { parsePx, solidPaint } from './css';
import { fontKey, loadFonts, type LoadedFonts } from './fonts';
import { loadImages, type LoadedImage } from './images';
import { backgroundPaints, objectFitPaint, shadowEffects } from './paints';
import type { BoxStyle, HtmlFrame, HtmlImage, HtmlNode, HtmlSvg, HtmlText, ImageAssets, Rect } from './types';

/** Figma rejects sizes below 0.01. */
const MIN_SIZE = 0.01;

const TEXT_CASE: Record<string, TextCase> = {
  uppercase: 'UPPER',
  lowercase: 'LOWER',
  capitalize: 'TITLE',
};

const TEXT_ALIGN: Record<string, TextNode['textAlignHorizontal']> = {
  left: 'LEFT',
  start: 'LEFT',
  center: 'CENTER',
  '-webkit-center': 'CENTER',
  right: 'RIGHT',
  end: 'RIGHT',
  justify: 'JUSTIFIED',
};

export interface BuildResult {
  root: FrameNode;
  layerCount: number;
  missingFonts: string[];
  /** SVGs Figma could not parse (imported as placeholders). */
  failedSvgs: number;
  /** Images that could not be loaded (imported as placeholders or left out). */
  failedImages: number;
}

type BoxNode = FrameNode | RectangleNode;

class Builder {
  layerCount = 0;
  failedSvgs = 0;

  constructor(
    private fonts: LoadedFonts,
    private images: Map<string, LoadedImage>,
  ) {}

  build(node: HtmlNode, parent: Rect): SceneNode {
    this.layerCount++;
    switch (node.type) {
      case 'frame':
        return this.frame(node, parent);
      case 'text':
        return this.text(node, parent);
      case 'svg':
        return this.svg(node, parent);
      case 'image':
        return this.image(node, parent);
    }
  }

  private place(target: SceneNode & LayoutMixin, rect: Rect, parent: Rect) {
    target.resize(Math.max(rect.width, MIN_SIZE), Math.max(rect.height, MIN_SIZE));
    target.x = rect.x - parent.x;
    target.y = rect.y - parent.y;
  }

  frame(node: HtmlFrame, parent: Rect): FrameNode {
    const frame = figma.createFrame();
    frame.name = node.name;
    this.place(frame, node.rect, parent);
    applyBoxStyle(frame, node.style, node.rect, this.images);
    frame.clipsContent = node.style.clips;
    for (const child of node.children) frame.appendChild(this.build(child, node.rect));
    return frame;
  }

  text(node: HtmlText, parent: Rect): TextNode {
    const { style, rect } = node;
    const text = figma.createText();
    text.name = node.name;
    text.fontName = this.fonts.byKey.get(fontKey(style)) ?? { family: 'Inter', style: 'Regular' };
    text.characters = node.characters;
    text.fontSize = Math.max(1, style.fontSize);

    const fill = solidPaint(style.color);
    text.fills = fill ? [fill] : [];

    const lineHeight = parsePx(style.lineHeight);
    text.lineHeight = lineHeight === null ? { unit: 'AUTO' } : { unit: 'PIXELS', value: lineHeight };
    text.letterSpacing = { unit: 'PIXELS', value: parsePx(style.letterSpacing) ?? 0 };
    text.textCase = TEXT_CASE[style.textTransform] ?? 'ORIGINAL';
    text.textDecoration = style.textDecoration.includes('underline')
      ? 'UNDERLINE'
      : style.textDecoration.includes('line-through')
        ? 'STRIKETHROUGH'
        : 'NONE';
    const align = TEXT_ALIGN[style.textAlign] ?? 'LEFT';
    text.textAlignHorizontal = align;
    text.effects = shadowEffects(style.textShadow);

    // Figma's text metrics differ slightly from the browser's, so a fixed width can
    // wrap single lines unexpectedly. Let single lines grow and re-anchor them to
    // the browser position instead; only multi-line text gets a fixed width.
    const approxLine = lineHeight ?? style.fontSize * 1.2;
    const singleLine = rect.height < approxLine * 1.5 || /^(nowrap|pre)$/.test(style.whiteSpace);
    if (singleLine) {
      text.textAutoResize = 'WIDTH_AND_HEIGHT';
      const dx =
        align === 'CENTER' ? (rect.width - text.width) / 2 : align === 'RIGHT' ? rect.width - text.width : 0;
      text.x = rect.x - parent.x + dx;
      text.y = rect.y - parent.y + (rect.height - text.height) / 2;
    } else {
      text.textAutoResize = 'HEIGHT';
      text.resize(Math.max(rect.width, MIN_SIZE), text.height);
      text.x = rect.x - parent.x;
      text.y = rect.y - parent.y;
    }
    return text;
  }

  svg(node: HtmlSvg, parent: Rect): SceneNode {
    let svg: FrameNode;
    try {
      svg = figma.createNodeFromSvg(node.markup);
    } catch (error) {
      console.warn(`Could not parse SVG "${node.name}"`, error);
      this.failedSvgs++;
      return this.placeholder(node, parent);
    }
    svg.name = node.name;
    // The markup's width/height already match the browser size; resizing the frame
    // would not scale its vectors, so only position it.
    svg.x = node.rect.x - parent.x;
    svg.y = node.rect.y - parent.y;
    svg.opacity = node.opacity;
    return svg;
  }

  image(node: HtmlImage, parent: Rect): RectangleNode {
    const image = this.images.get(node.src);
    if (!image) return this.placeholder(node, parent);
    const rect = figma.createRectangle();
    rect.name = node.name;
    this.place(rect, node.rect, parent);
    applyBoxStyle(rect, node.style, node.rect, this.images);
    // The picture sits above the element's own background.
    if (node.style.visible) rect.fills = [...(rect.fills as Paint[]), objectFitPaint(image, node.objectFit)];
    return rect;
  }

  /** Gray box standing in for images that failed to load and SVGs Figma cannot parse. */
  placeholder(node: HtmlImage | HtmlSvg, parent: Rect): RectangleNode {
    const rect = figma.createRectangle();
    rect.name = node.name;
    this.place(rect, node.rect, parent);
    rect.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.87 } }];
    if (node.type === 'image') {
      const [tl, tr, br, bl] = node.style.radii;
      Object.assign(rect, { topLeftRadius: tl, topRightRadius: tr, bottomRightRadius: br, bottomLeftRadius: bl });
    }
    return rect;
  }
}

function applyBoxStyle(frame: BoxNode, style: BoxStyle, rect: Rect, images: Map<string, LoadedImage>) {
  frame.opacity = style.opacity;
  [frame.topLeftRadius, frame.topRightRadius, frame.bottomRightRadius, frame.bottomLeftRadius] = style.radii;

  frame.fills = [];
  frame.strokes = [];
  frame.effects = [];
  if (!style.visible) return;

  frame.fills = backgroundPaints(style, rect.width, rect.height, images);
  frame.effects = shadowEffects(style.boxShadow);

  // Figma has one stroke paint per node but per-side weights: use the first
  // visible side's color. CSS borders sit inside the border box.
  const widths = style.borderWidths;
  const visibleSide = widths.findIndex((w, i) => w > 0 && solidPaint(style.borderColors[i]));
  if (visibleSide === -1) return;
  frame.strokes = [solidPaint(style.borderColors[visibleSide])!];
  frame.strokeAlign = 'INSIDE';
  if (widths.every((w) => w === widths[0])) {
    frame.strokeWeight = widths[0];
  } else {
    [frame.strokeTopWeight, frame.strokeRightWeight, frame.strokeBottomWeight, frame.strokeLeftWeight] =
      widths.map((w, i) => (solidPaint(style.borderColors[i]) ? w : 0));
  }
  const lineStyle = style.borderStyles[visibleSide];
  const w = widths[visibleSide];
  if (lineStyle === 'dashed') frame.dashPattern = [w * 3, w * 3];
  else if (lineStyle === 'dotted') frame.dashPattern = [w, w];
}

export async function buildDocument(tree: HtmlFrame, assets: ImageAssets): Promise<BuildResult> {
  const [fonts, images] = await Promise.all([loadFonts(tree), loadImages(tree, assets)]);
  const builder = new Builder(fonts, images.bySrc);
  const root = builder.frame(tree, tree.rect);
  return {
    root,
    layerCount: builder.layerCount + 1,
    missingFonts: [...fonts.missing],
    failedSvgs: builder.failedSvgs,
    failedImages: images.failed,
  };
}
