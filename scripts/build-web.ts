// Bundles web/app.ts and inlines it into a single self-contained HTML page at web/dist/fateweave-demo.html.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const result = await build({
  entryPoints: ['web/app.ts'], bundle: true, format: 'iife', minify: true, write: false, target: 'es2020',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync('web/template.html', 'utf8').replace('/*APP*/', () => js);
mkdirSync('web/dist', { recursive: true });
writeFileSync('web/dist/fateweave-demo.html', html);
console.log(`web/dist/fateweave-demo.html (${(html.length / 1024).toFixed(1)} KB)`);
