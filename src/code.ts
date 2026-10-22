import { buildDocument } from './builder';
import type { HtmlFrame, ImageAssets, PluginToUiMessage, UiToPluginMessage } from './types';

figma.showUI(__html__, { width: 360, height: 420, themeColors: true });

function postToUi(msg: PluginToUiMessage) {
  figma.ui.postMessage(msg);
}

/** Places the frame to the right of everything already on the page. */
function placeOnPage(frame: FrameNode) {
  const page = figma.currentPage;
  const others = page.children.filter((node) => node !== frame);
  if (others.length) {
    frame.x = Math.max(...others.map((node) => node.x + node.width)) + 100;
    frame.y = Math.min(...others.map((node) => node.y));
  } else {
    frame.x = Math.round(figma.viewport.center.x - frame.width / 2);
    frame.y = Math.round(figma.viewport.center.y - frame.height / 2);
  }
}

async function importTree(tree: HtmlFrame, images: ImageAssets) {
  const { root, layerCount, missingFonts, failedSvgs, failedImages } = await buildDocument(tree, images);
  figma.currentPage.appendChild(root);
  placeOnPage(root);
  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);

  let message = `Imported "${root.name}" at ${root.width}px (${layerCount} layers)`;
  if (missingFonts.length) message += ` — replaced missing fonts: ${missingFonts.join(', ')}`;
  if (failedSvgs) message += ` — ${failedSvgs} SVG(s) could not be parsed`;
  if (failedImages) message += ` — ${failedImages} image(s) could not be loaded`;
  figma.notify(message, { timeout: 6000 });
}

figma.ui.onmessage = async (msg: UiToPluginMessage) => {
  switch (msg.type) {
    case 'import-tree':
      try {
        await importTree(msg.tree, msg.images);
        postToUi({ type: 'import-done' });
      } catch (error) {
        postToUi({ type: 'import-error', message: `Import failed: ${error instanceof Error ? error.message : error}` });
      }
      break;
    case 'cancel':
      figma.closePlugin();
      break;
  }
};
