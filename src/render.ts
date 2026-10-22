import serializerScript from 'serializer-script';
import {
  DEFAULT_VIEWPORT,
  SERIALIZER_SOURCE,
  type HtmlFrame,
  type ImageAssets,
  type SerializerMessage,
} from './types';

/** Covers page load, settling, resizing and image rasterizing. */
const RENDER_TIMEOUT_MS = 45000;

export interface RenderResult {
  tree: HtmlFrame;
  images: ImageAssets;
}

/**
 * Renders the HTML (running its scripts) in a hidden sandboxed iframe and resolves
 * with the serialized tree and its rasterized images. The serializer detects the
 * page's own width and asks for the iframe to be resized to it before serializing.
 */
export function renderHtml(html: string): Promise<RenderResult> {
  const iframe = document.createElement('iframe');
  // Scripts only: the page cannot reach the plugin UI's DOM or storage.
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.className = 'render-frame';
  setSize(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
  // Appended after </html>, the script still parses into <body> and runs last.
  const script = serializerScript.replace(/<\/script/gi, '<\\/script');
  iframe.srcdoc = `${html}\n<script>${script}</script>`;

  function setSize(width: number, height: number) {
    iframe.style.width = `${width}px`;
    iframe.style.height = `${height}px`;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Rendering timed out.')), RENDER_TIMEOUT_MS);

    function onMessage(event: MessageEvent) {
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data as SerializerMessage | undefined;
      if (msg?.source !== SERIALIZER_SOURCE) return;
      switch (msg.type) {
        case 'resize':
          setSize(msg.width, msg.height);
          break;
        case 'done':
          finish(null, { tree: msg.tree, images: msg.images });
          break;
        case 'error':
          finish(new Error(msg.error));
          break;
      }
    }

    function finish(error: Error | null, result?: RenderResult) {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      iframe.remove();
      if (error) reject(error);
      else resolve(result!);
    }

    window.addEventListener('message', onMessage);
    document.body.appendChild(iframe);
  });
}
