// Monta o instalador de dois cliques do Claude Desktop (dist/labsign-<versão>.mcpb),
// a partir do build em dist/. O plugin do Claude Code não leva servidor embutido: ele
// roda via "npx labsign@latest", buscando do npm — só sincroniza a versão do manifest.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const artifacts = ['labsign.js', 'ui.html', 'ui-app.html', 'THIRD_PARTY_LICENSES.txt'];
for (const f of artifacts) if (!existsSync(join(dist, f))) throw new Error(`dist/${f} não existe — rode "npm run build"`);

// ---- .mcpb (Claude Desktop): manifest + server/ + ícone
const stage = join(dist, 'mcpb');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'server'), { recursive: true });
const manifest = JSON.parse(readFileSync(join(root, 'mcpb/manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
for (const f of artifacts) copyFileSync(join(dist, f), join(stage, f === 'THIRD_PARTY_LICENSES.txt' ? f : `server/${f}`));
copyFileSync(join(root, 'mcpb/icon.png'), join(stage, 'icon.png'));
copyFileSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));

// roda o CLI do mcpb com este Node (node_modules/.bin/mcpb não executa no Windows)
const mcpbDir = join(root, 'node_modules/@anthropic-ai/mcpb');
const mcpbBin = JSON.parse(readFileSync(join(mcpbDir, 'package.json'), 'utf8')).bin;
const mcpbCli = join(mcpbDir, typeof mcpbBin === 'string' ? mcpbBin : mcpbBin.mcpb);
const mcpb = (...args) => execFileSync(process.execPath, [mcpbCli, ...args], { stdio: 'inherit' });
mcpb('validate', join(stage, 'manifest.json'));
const out = join(dist, `labsign-${pkg.version}.mcpb`);
rmSync(out, { force: true });
mcpb('pack', stage, out);
console.log(`\n${out.replace(root + '/', '')} pronto`);

// ---- plugin do Claude Code: só mantém a versão do manifest alinhada com package.json
const pluginJson = join(root, 'plugin/.claude-plugin/plugin.json');
const plugin = JSON.parse(readFileSync(pluginJson, 'utf8'));
if (plugin.version !== pkg.version) {
  plugin.version = pkg.version;
  writeFileSync(pluginJson, `${JSON.stringify(plugin, null, 2)}\n`);
  console.log('plugin/.claude-plugin/plugin.json: versão sincronizada');
}
