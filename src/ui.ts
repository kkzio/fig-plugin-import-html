import { renderHtml } from './render';
import type { PluginToUiMessage, UiToPluginMessage } from './types';

const fileInput = document.getElementById('file') as HTMLInputElement;
const chooseBtn = document.getElementById('choose') as HTMLButtonElement;
const fileName = document.getElementById('file-name') as HTMLSpanElement;
const source = document.getElementById('source') as HTMLTextAreaElement;
const importBtn = document.getElementById('import') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLParagraphElement;

let currentName = 'pasted.html';

function postToPlugin(msg: UiToPluginMessage) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

function setStatus(text: string, kind: 'info' | 'error' = 'info') {
  status.textContent = text;
  status.dataset.kind = kind;
}

function updateButton() {
  importBtn.disabled = source.value.trim() === '';
}

chooseBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  currentName = file.name;
  fileName.textContent = file.name;
  source.value = await file.text();
  setStatus('');
  updateButton();
});

source.addEventListener('input', () => {
  // Editing a loaded file turns it into pasted content.
  if (fileInput.files?.length) {
    fileInput.value = '';
    fileName.textContent = 'No file chosen';
    currentName = 'pasted.html';
  }
  updateButton();
});

importBtn.addEventListener('click', async () => {
  const html = source.value;
  if (!html.trim()) return;
  importBtn.disabled = true;
  setStatus('Rendering HTML…');
  try {
    const tree = await renderHtml(html);
    tree.name ||= currentName.replace(/\.html?$/i, '');
    setStatus(`Creating layers (${tree.rect.width}px wide)…`);
    postToPlugin({ type: 'import-tree', tree });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
    updateButton();
  }
});

cancelBtn.addEventListener('click', () => postToPlugin({ type: 'cancel' }));

window.onmessage = (event: MessageEvent) => {
  const msg = event.data?.pluginMessage as PluginToUiMessage | undefined;
  if (!msg) return;
  switch (msg.type) {
    case 'import-done':
      setStatus('Done.');
      break;
    case 'import-error':
      setStatus(msg.message, 'error');
      break;
  }
  updateButton();
};

updateButton();
