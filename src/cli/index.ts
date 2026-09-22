#!/usr/bin/env node
// labsign — CLI. Abre a MESMA tela do chat, no navegador padrão.
//   labsign sign [arquivo.pdf] [--anchor TEXTO]
//   labsign add | list | mcp | doctor | --version | --help
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { t, hasKey } from '../i18n/messages.ts';
import { detectLang } from './lang.ts';
import { doctor } from './doctor.ts';
import { VERSION } from '../version.ts';
import { LabsignError } from '../core/errors.ts';

const lang = detectLang();
const say = (text: string) => process.stdout.write(`${text}\n`);
const KEEP_ALIVE_AGENT_S = 90;

type Args = { cmd?: string; file?: string; anchor: string; version: boolean; help: boolean };
/** `labsign <comando> [arquivo.pdf] [--anchor TEXTO]`, com as flags em qualquer posição. Flag desconhecida é erro, não silêncio. */
function readArgs(): Args | { error: string } {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: { anchor: { type: 'string' }, version: { type: 'boolean', short: 'v' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 2) return { error: positionals.slice(2).join(' ') };
    return { cmd: positionals[0], file: positionals[1], anchor: values.anchor?.trim() || 'CONTRATANTE', version: Boolean(values.version), help: Boolean(values.help) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function main(): Promise<number> {
  const args = readArgs();
  if ('error' in args) {
    process.stderr.write(`${t(lang, 'cliBadArgs', { detail: args.error })}\n\n${t(lang, 'cliHelp', { version: VERSION })}\n`);
    return 64;
  }
  const { cmd, anchor } = args;
  if (cmd === 'mcp') {
    // stdout é do protocolo MCP: qualquer console.log de biblioteca vai para o stderr
    for (const k of ['log', 'info', 'debug', 'warn'] as const) console[k] = (...a: unknown[]) => console.error(...a);
    const { startMcpServer } = await import('../mcp/server.ts');
    await startMcpServer();
    return -1; // continua vivo: o app de chat encerra o processo
  }
  if (args.version) {
    say(VERSION);
    return 0;
  }
  if (!cmd || args.help || cmd === 'help') {
    say(t(lang, 'cliHelp', { version: VERSION }));
    return cmd || args.help ? 0 : 64;
  }

  const { listSignatures, HOME, notices } = await import('../core/vault.ts');
  const reportMigration = () => {
    if (notices.migrated) say(t(lang, 'cliMigrated', { n: notices.migrated.n, from: notices.migrated.from }));
  };

  if (cmd === 'list') {
    const list = listSignatures();
    reportMigration();
    say(list.length ? list.map((s) => `${s.id}  ${s.label}`).join('\n') : t(lang, 'cliListEmpty'));
    return 0;
  }
  if (cmd === 'doctor') {
    say(doctor(lang));
    reportMigration();
    return 0;
  }
  if (cmd !== 'sign' && cmd !== 'add') {
    say(t(lang, 'cliHelp', { version: VERSION }));
    return 64;
  }

  const { ensureHttp, sessionUrl, publicUrl, openInBrowser } = await import('../http/server.ts');
  const sessions = await import('../core/sessions.ts');
  let session;
  let what: string;
  if (cmd === 'add') {
    // fica vivo até a pessoa clicar em "Concluir": dá para salvar assinatura e rubrica na mesma aba
    session = sessions.createSession({ kind: 'pad', client: 'cli', closeOnSave: false });
    what = t(lang, 'cliWhatVault');
  } else if (!args.file) {
    // sem arquivo: a tela pede o PDF (arrastar ou escolher)
    session = sessions.createAwaitingSignSession({ anchorText: anchor, client: 'cli' });
    what = t(lang, 'cliWhatUpload');
  } else {
    const file = resolve(args.file);
    const bytes = sessions.readPdf(file);
    const { locateSignatureSpot } = await import('../core/anchors.ts');
    const spot = await locateSignatureSpot(bytes, anchor);
    say(spot.anchor.found ? t(lang, 'cliAnchorFound', { text: anchor, page: spot.anchor.page }) : t(lang, 'cliAnchorMissing', { text: anchor }));
    session = sessions.prepareSignSession({ file, bytes, placements: [spot.placement], anchor: spot.anchor, client: 'cli' });
    what = t(lang, 'cliWhatSign', { file });
  }
  reportMigration();

  // O link com o token de uso único só aparece se o navegador não abriu: quando um agente roda este
  // comando, ele lê o terminal — e com o token poderia assinar sem a pessoa.
  await ensureHttp();
  const opened = await openInBrowser(sessionUrl(session));
  const where = opened ? t(lang, 'cliOpened', { url: publicUrl(session) }) : t(lang, 'cliOpenManually', { url: sessionUrl(session) });
  say(`\nlabsign · ${what}\n${where}\n${t(lang, 'cliVault', { path: HOME })}\n`);

  const s = (await sessions.waitForSession(session.id, 30 * 60 * 1000))!;
  const state = sessions.publicState(s) as Record<string, any>;
  const pad = session.kind === 'pad';
  if (state.status === 'signed') {
    if (state.signed_file) say(`${t(lang, 'cliSigned', { file: state.signed_file })}\nSHA-256:  ${state.sha256_signed}`);
    else say(state.signatures_saved > 1 ? t(lang, 'cliSavedMany', { n: state.signatures_saved, label: state.signature_label }) : t(lang, 'cliSavedOne', { label: state.signature_label }));
  } else if (state.status === 'cancelled') say(t(lang, pad ? 'cliNoNewSignature' : 'cliCancelled'));
  else say(state.status === 'expired' ? t(lang, 'cliExpired') : t(lang, 'cliClosed', { status: state.status }));

  if (state.status === 'signed' && state.signed_file) {
    // a tela ainda serve para baixar, enviar por e-mail/WhatsApp ou abrir a pasta. Sem terminal interativo
    // (um agente rodando o comando), 15 min travariam o agente: espera pouco.
    const interactive = Boolean(process.stdout.isTTY);
    say(`\n${interactive ? t(lang, 'cliKeepAlive') : t(lang, 'cliKeepAliveShort', { seconds: KEEP_ALIVE_AGENT_S })}`);
    await sessions.waitForClose(session.id, (interactive ? 15 * 60 : KEEP_ALIVE_AGENT_S) * 1000);
  }
  // fechar o cofre sem salvar nada não é erro; cancelar uma assinatura é
  return state.status === 'signed' || (pad && state.status === 'cancelled') ? 0 : 1;
}

main().then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    const key = e instanceof LabsignError ? `err.${e.code}` : '';
    const message = hasKey(key) ? t(lang, key, (e as LabsignError).params) : ((e as Error)?.message ?? String(e));
    process.stderr.write(`${t(lang, 'cliError', { message })}\n`);
    process.exit(1);
  },
);
