import * as esbuild from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const watch = process.argv.includes('--watch');

await mkdir('dist', { recursive: true });

const shared = { bundle: true, target: 'es2017', logLevel: 'info' };

// `import code from 'serializer-script'` -> src/serializer.ts bundled as a string,
// which the UI injects into the render iframe.
const serializerScript = {
  name: 'serializer-script',
  setup(build) {
    build.onResolve({ filter: /^serializer-script$/ }, () => ({
      path: 'serializer-script',
      namespace: 'serializer-script',
    }));
    build.onLoad({ filter: /.*/, namespace: 'serializer-script' }, async () => {
      const result = await esbuild.build({
        entryPoints: ['src/serializer.ts'],
        bundle: true,
        format: 'iife',
        target: 'es2017',
        minify: true,
        write: false,
        metafile: true,
      });
      return {
        contents: `export default ${JSON.stringify(result.outputFiles[0].text)};`,
        loader: 'js',
        watchFiles: Object.keys(result.metafile.inputs).map((file) => path.resolve(file)),
      };
    });
  },
};

// Plugin sandbox code -> dist/code.js
const codeOptions = { ...shared, entryPoints: ['src/code.ts'], outfile: 'dist/code.js' };

// UI script, inlined into dist/ui.html (Figma loads the UI as a single HTML string)
const inlineUi = {
  name: 'inline-ui',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      const js = result.outputFiles.find((f) => f.path.endsWith('.js')).text;
      const template = await readFile('src/ui.html', 'utf8');
      const html = template.replace(
        '<!-- UI_SCRIPT -->',
        () => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`,
      );
      await writeFile('dist/ui.html', html);
    });
  },
};
const uiOptions = {
  ...shared,
  entryPoints: ['src/ui.ts'],
  outfile: 'dist/ui.js',
  write: false,
  plugins: [serializerScript, inlineUi],
};

if (watch) {
  const contexts = await Promise.all([esbuild.context(codeOptions), esbuild.context(uiOptions)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all([esbuild.build(codeOptions), esbuild.build(uiOptions)]);
}
