// labsign doctor: confere o ambiente e mostra como conectar cada app. Só mostra — não altera nada.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Lang } from '../i18n/messages.ts';
import { HOME, listSignatures, verifyAuditChain } from '../core/vault.ts';
import { uiFile } from '../http/server.ts';
import { VERSION } from '../version.ts';

const T = {
  pt: {
    node: (v: string, ok: boolean) => `Node ${v} ${ok ? '(ok, ≥ 22.13)' : '(precisa ser 22.13 ou mais novo)'}`,
    vault: (path: string, n: number) => `Cofre: ${path} — ${n} assinatura(s)`,
    audit: (ok: boolean, n: number) => (ok ? `Auditoria íntegra (${n} evento(s))` : `ATENÇÃO: a cadeia da auditoria não confere (${n} evento(s))`),
    ui: (ok: boolean) => (ok ? 'Tela montada: ok' : 'Tela não encontrada — rode "npm run build"'),
    connect: 'Como conectar:',
    found: 'encontrado',
    notFound: 'não encontrado',
    configured: 'já configurado',
    configuredVersion: (v: string) => `instalado (v${v})`,
    disabled: 'instalado, mas desativado — habilite em Configurações → Extensões',
    desktopHow: 'instale o arquivo labsign.mcpb (dois cliques) ou acrescente em "mcpServers" do arquivo',
    codeHow: 'rode',
    codexHow: 'rode',
    codexSkill: 'e copie a skill:',
    cursorHow: 'acrescente em ~/.cursor/mcp.json:',
    note: 'O doctor só mostra; nada foi alterado.',
  },
  en: {
    node: (v: string, ok: boolean) => `Node ${v} ${ok ? '(ok, ≥ 22.13)' : '(needs 22.13 or newer)'}`,
    vault: (path: string, n: number) => `Vault: ${path} — ${n} signature(s)`,
    audit: (ok: boolean, n: number) => (ok ? `Audit log intact (${n} event(s))` : `WARNING: the audit chain does not verify (${n} event(s))`),
    ui: (ok: boolean) => (ok ? 'Screen built: ok' : 'Screen not found — run "npm run build"'),
    connect: 'How to connect:',
    found: 'found',
    notFound: 'not found',
    configured: 'already configured',
    configuredVersion: (v: string) => `installed (v${v})`,
    disabled: 'installed, but disabled — enable it in Settings → Extensions',
    desktopHow: 'install the labsign.mcpb file (double-click) or add under "mcpServers" in',
    codeHow: 'run',
    codexHow: 'run',
    codexSkill: 'and copy the skill:',
    cursorHow: 'add to ~/.cursor/mcp.json:',
    note: 'doctor only shows; nothing was changed.',
  },
};

function onPath(cmd: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// LABSIGN_CLAUDE_DIR: só para os testes isolarem a pasta do Claude Desktop, como LABSIGN_HOME faz com o cofre.
const claudeConfigDir = (): string =>
  process.env.LABSIGN_CLAUDE_DIR ||
  (process.platform === 'darwin'
    ? join(homedir(), 'Library/Application Support/Claude')
    : process.platform === 'win32'
      ? join(process.env.APPDATA ?? homedir(), 'Claude')
      : join(homedir(), '.config/Claude'));

const desktopConfigPath = (): string => join(claudeConfigDir(), 'claude_desktop_config.json');

function mentionsLabsign(file: string): boolean {
  try {
    return /labsign/.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * O Claude Desktop moderno instala .mcpb como extensão própria (pasta "Claude Extensions"),
 * não editando "mcpServers" no config — checar só o config dava falso negativo com tudo funcionando.
 */
function desktopExtension(): { installed: boolean; enabled: boolean; version?: string } {
  try {
    const raw = JSON.parse(readFileSync(join(claudeConfigDir(), 'extensions-installations.json'), 'utf8'));
    const installs = raw?.extensions ?? raw; // formato visto: { extensions: { "<id>": {...} } }
    const entry = Object.values(installs as Record<string, any>).find((e: any) => e?.manifest?.name === 'labsign') as any;
    if (!entry) return { installed: false, enabled: false };
    let enabled = true; // sem arquivo de settings = habilitada por padrão
    try {
      enabled = JSON.parse(readFileSync(join(claudeConfigDir(), 'Claude Extensions Settings', `${entry.id}.json`), 'utf8')).isEnabled ?? true;
    } catch {
      /* padrão: habilitada */
    }
    return { installed: true, enabled, version: entry.version };
  } catch {
    return { installed: false, enabled: false };
  }
}

export function doctor(lang: Lang): string {
  const t = T[lang];
  const lines: string[] = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  lines.push(`labsign ${VERSION}`, t.node(process.version, major > 22 || (major === 22 && minor >= 13)));
  lines.push(t.vault(HOME, listSignatures().length));
  const chain = verifyAuditChain();
  lines.push(t.audit(chain.ok, chain.entries));
  let uiOk = true;
  try {
    uiFile('ui.html');
  } catch {
    uiOk = false;
  }
  lines.push(t.ui(uiOk), '');

  // o comando que funciona agora: este Node + este arquivo
  const node = process.execPath;
  const script = process.argv[1];
  // a skill mora no plugin: repo (dist/labsign.js) ou plugin instalado (server/labsign.js)
  const skill =
    [join(dirname(script), '../plugin/skills/labsign'), join(dirname(script), '../skills/labsign')].find((d) => existsSync(join(d, 'SKILL.md'))) ??
    '<labsign>/plugin/skills/labsign';
  const serverJson = JSON.stringify({ command: node, args: [script, 'mcp'] });
  const status = (found: boolean, configured: boolean) => (configured ? t.configured : found ? t.found : t.notFound);

  lines.push(t.connect);
  const desktop = desktopConfigPath();
  const ext = desktopExtension();
  const desktopStatus = ext.installed ? (ext.enabled ? t.configuredVersion(ext.version ?? '?') : t.disabled) : status(existsSync(desktop), mentionsLabsign(desktop));
  lines.push(`• Claude Desktop [${desktopStatus}] — ${t.desktopHow}`, `    ${desktop}`, `    "labsign": ${serverJson}`);
  lines.push(`• Claude Code [${status(onPath('claude'), false)}] — ${t.codeHow}:`, `    claude mcp add labsign -- "${node}" "${script}" mcp`);
  const codexConfig = join(homedir(), '.codex/config.toml');
  lines.push(
    `• Codex [${status(onPath('codex') || existsSync(codexConfig), mentionsLabsign(codexConfig))}] — ${t.codexHow}:`,
    `    codex mcp add labsign -- "${node}" "${script}" mcp`,
    `    ${t.codexSkill} cp -R "${skill}" ~/.agents/skills/`,
  );
  const cursor = join(homedir(), '.cursor/mcp.json');
  lines.push(`• Cursor [${status(existsSync(join(homedir(), '.cursor')), mentionsLabsign(cursor))}] — ${t.cursorHow}`, `    { "mcpServers": { "labsign": ${serverJson} } }`);
  lines.push('', t.note);
  return lines.join('\n');
}
