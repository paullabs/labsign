// Build do labsign:
//   dist/labsign.js               CLI + servidor MCP, com todas as dependências embutidas (um arquivo, Node ≥ 22.13)
//   dist/ui.html / ui-app.html    a tela em HTML único (navegador / embutida no chat via MCP Apps)
//   dist/THIRD_PARTY_LICENSES.txt licenças do que foi embutido
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
const bundled = new Set();
const note = (metafile) => {
  for (const input of Object.keys(metafile.inputs)) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (m) bundled.add(m[1]);
  }
};

// ---- a tela: duas variantes (a do navegador não carrega o SDK de MCP Apps)
const shell = readFileSync(join(root, 'src/ui/index.html'), 'utf8');
// a letra estreita dos rótulos (Archivo Narrow, OFL) vai embutida: a tela é um HTML só, sem nada de fora
const FONT_PKG = '@fontsource/archivo-narrow';
const font = readFileSync(join(root, 'node_modules', FONT_PKG, 'files/archivo-narrow-latin-600-normal.woff2')).toString('base64');
bundled.add(FONT_PKG);
for (const [file, mcpApp] of [['ui.html', false], ['ui-app.html', true]]) {
  const result = await build({
    entryPoints: [join(root, 'src/ui/main.ts')],
    bundle: true,
    format: 'iife',
    minify: true,
    target: 'es2022',
    write: false,
    metafile: true,
    legalComments: 'none',
    define: { __MCP_APP__: String(mcpApp), __LABSIGN_FONT__: JSON.stringify(font) },
    logOverride: { 'empty-import-meta': 'silent' }, // import.meta só aparece num ramo do PDF.js exclusivo do Node
  });
  note(result.metafile);
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const html = shell.replace('/*LABSIGN_BUNDLE*/', () => js);
  // no navegador, o servidor troca o nonce a cada resposta (CSP sem 'unsafe-inline'); no chat, a CSP é do app
  if (!html.includes(' nonce="__LABSIGN_NONCE__"')) throw new Error('src/ui/index.html: o <script> do pacote precisa de nonce="__LABSIGN_NONCE__"');
  writeFileSync(join(dist, file), mcpApp ? html.replace(' nonce="__LABSIGN_NONCE__"', '') : html);
  console.log(`dist/${file}: ${(readFileSync(join(dist, file)).length / 1024).toFixed(0)} KB`);
}

// ---- CLI + servidor MCP
// Roda antes de todo o resto do pacote (vai no banner, como texto).
function prelude() {
  // o PDF.js exige Node >= 22.13; em Node antigo ele quebra de jeito confuso — melhor uma mensagem clara
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    console.error(`labsign needs Node.js 22.13 or newer (found ${process.version}): https://nodejs.org`);
    process.exit(1);
  }
  // No Node o labsign só lê o texto do PDF (âncoras), não desenha páginas. Os avisos de polyfill de
  // desenho do PDF.js (pacote nativo opcional @napi-rs/canvas, DOMMatrix, Path2D) só assustariam.
  const warn = console.warn;
  console.warn = (...args) => {
    if (typeof args[0] === 'string' && /^Warning: Cannot (load "@napi-rs\/canvas"|polyfill `(DOMMatrix|Path2D)`)/.test(args[0])) return;
    warn.apply(console, args);
  };
}
const cli = await build({
  entryPoints: [join(root, 'src/cli/index.ts')],
  outfile: join(dist, 'labsign.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: true,
  keepNames: true, // pilhas de erro legíveis em relatos de bug
  metafile: true,
  legalComments: 'none',
  define: { __LABSIGN_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    // dependências CommonJS embutidas ainda chamam require(): damos um de verdade
    js: ["import { createRequire as __labsignRequire } from 'node:module';", 'const require = __labsignRequire(import.meta.url);', `(${prelude})();`].join('\n'),
  },
});
note(cli.metafile);
chmodSync(join(dist, 'labsign.js'), 0o755);
console.log(`dist/labsign.js: ${(readFileSync(join(dist, 'labsign.js')).length / 1024).toFixed(0)} KB`);

// ---- licenças do que foi embutido (MIT/Apache pedem o aviso junto)
const sections = [];
for (const name of [...bundled].sort()) {
  const dir = join(root, 'node_modules', name);
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE'].map((f) => join(dir, f)).find((f) => existsSync(f));
  sections.push(`${name}@${meta.version} — ${meta.license ?? 'see file'}\n${'-'.repeat(72)}\n${licenseFile ? readFileSync(licenseFile, 'utf8').trim() : '(license text not shipped by the package)'}\n`);
}
writeFileSync(join(dist, 'THIRD_PARTY_LICENSES.txt'), `labsign ${pkg.version} bundles the following packages:\n\n${sections.join('\n')}`);
console.log(`dist/THIRD_PARTY_LICENSES.txt: ${bundled.size} pacotes`);
