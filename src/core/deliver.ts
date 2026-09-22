// Entrega do PDF assinado pelo computador — o que o painel do chat não consegue fazer sozinho
// (baixar, anexar num e-mail, pôr o arquivo na área de transferência, mandar para a Lixeira).
// Cada ação chama um programa do sistema com argumentos fixos, sem shell: caminhos e textos vão
// como argumento (AppleScript/JXA: argv) ou variável de ambiente (PowerShell), nunca colados no script.
// LABSIGN_NO_OPEN=1 (testes, CI) não abre nada; LABSIGN_FAKE_SAVE_AS e LABSIGN_TRASH_DIR simulam
// o diálogo de salvar e a Lixeira.
import { spawn, execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, copyFileSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

type Platform = 'mac' | 'windows' | 'linux';
const platform: Platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
const noOpen = () => process.env.LABSIGN_NO_OPEN === '1';

export type MailClient = 'apple-mail' | 'outlook' | 'gmail' | 'default';

/** O que dá para fazer neste computador: a tela só mostra o botão que funciona. */
export interface DeliveryOptions {
  platform: Platform;
  saveAs: boolean;
  copy: boolean;
  trash: boolean;
  mail: MailClient[];
  whatsappApp: boolean;
}

/**
 * Dispara um programa (navegador, gerenciador de arquivos, app de e-mail) sem esperar por ele.
 * Comando inexistente (xdg-open ausente no Linux/WSL) chega como evento 'error': sem ouvinte, derrubaria o processo.
 */
export function startDetached(cmd: string, args: string[], extra: { windowsVerbatimArguments?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<boolean> {
  return new Promise((done) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true, ...extra });
      child.once('error', () => done(false));
      child.once('spawn', () => {
        child.unref();
        done(true);
      });
    } catch {
      done(false);
    }
  });
}

/** Roda e espera (diálogos, área de transferência, Lixeira). Nunca rejeita: devolve código e saída. */
function run(cmd: string, args: string[], env: Record<string, string> = {}, timeoutMs = 15 * 60 * 1000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((done) => {
    try {
      execFile(cmd, args, { env: { ...process.env, ...env }, windowsHide: true, timeout: timeoutMs, maxBuffer: 1 << 20, encoding: 'utf8' }, (error, stdout, stderr) =>
        done({ ok: !error, out: String(stdout ?? ''), err: String(stderr ?? '') }),
      );
    } catch (e) {
      done({ ok: false, out: '', err: String((e as Error)?.message ?? e) });
    }
  });
}

const which = (cmd: string): boolean => {
  if (platform === 'windows') return false;
  try {
    return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
};

/** PowerShell com saída em UTF-8 (caminhos com acento chegam inteiros). */
const powershell = (script: string, env: Record<string, string>, timeoutMs?: number) =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], env, timeoutMs);

const macApp = (...names: string[]) => names.some((n) => existsSync(join('/Applications', n)) || existsSync(join('/System/Applications', n)) || existsSync(join(homedir(), 'Applications', n)));

function windowsHasOutlook(): boolean {
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      if (spawnSync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\OUTLOOK.EXE`], { stdio: 'ignore', windowsHide: true }).status === 0) return true;
    } catch {}
  }
  return false;
}

let cached: DeliveryOptions | null = null;
export function deliveryOptions(): DeliveryOptions {
  if (cached) return cached;
  if (platform === 'mac') {
    const mail: MailClient[] = [];
    if (macApp('Mail.app')) mail.push('apple-mail');
    if (macApp('Microsoft Outlook.app')) mail.push('outlook');
    mail.push('gmail');
    cached = { platform, saveAs: true, copy: true, trash: true, mail, whatsappApp: macApp('WhatsApp.app') };
  } else if (platform === 'windows') {
    cached = { platform, saveAs: true, copy: true, trash: true, mail: [...(windowsHasOutlook() ? (['outlook'] as const) : []), 'gmail'], whatsappApp: false };
  } else {
    cached = {
      platform,
      saveAs: which('zenity') || which('kdialog'),
      copy: which('wl-copy') || which('xclip'),
      trash: which('gio'),
      mail: [...(which('xdg-email') ? (['default'] as const) : []), 'gmail'],
      whatsappApp: false,
    };
  }
  return cached;
}

// ---------------------------------------------------------------- abrir, mostrar, copiar
/** Abre um endereço no navegador padrão. No Windows, sem cmd: "&" da query não pode virar separador de comandos. */
export function openUrl(url: string): Promise<boolean> {
  if (noOpen()) return Promise.resolve(false);
  if (platform === 'mac') return startDetached('open', [url]);
  if (platform === 'windows') return startDetached('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  return startDetached('xdg-open', [url]);
}

/** Abre o PDF no leitor padrão do computador. */
export function openFile(file: string): Promise<boolean> {
  if (noOpen()) return Promise.resolve(false);
  if (platform === 'mac') return startDetached('open', [file]);
  if (platform === 'windows') return powershell('Start-Process -FilePath $env:LABSIGN_FILE', { LABSIGN_FILE: file }).then((r) => r.ok);
  return startDetached('xdg-open', [file]);
}

/** Abre a pasta com o arquivo selecionado (Finder, Explorer ou o gerenciador de arquivos). */
export function revealFile(file: string): Promise<boolean> {
  if (noOpen()) return Promise.resolve(false);
  if (platform === 'mac') return startDetached('open', ['-R', file]);
  // o Explorer não entende o argumento que o Node monta ("/select,C:\...\com espaço"): vai como está
  if (platform === 'windows') return startDetached('explorer.exe', [`/select,"${file}"`], { windowsVerbatimArguments: true });
  return startDetached('xdg-open', [dirname(file)]);
}

// JXA: escreve na área de transferência o mesmo que o Finder escreve ao copiar um arquivo
const JXA_COPY = `function run(argv) {
  ObjC.import('AppKit');
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  return pb.writeObjects($([$.NSURL.fileURLWithPath(argv[0])])) ? 'ok' : 'no';
}`;

/** Põe o ARQUIVO (não o texto do caminho) na área de transferência: colar num e-mail ou conversa anexa o PDF. */
export async function copyFileToClipboard(file: string): Promise<boolean> {
  if (noOpen() || !deliveryOptions().copy) return false;
  if (platform === 'mac') return (await run('osascript', ['-l', 'JavaScript', '-e', JXA_COPY, file], {}, 15000)).out.trim() === 'ok';
  if (platform === 'windows') return (await powershell('Set-Clipboard -LiteralPath $env:LABSIGN_FILE', { LABSIGN_FILE: file }, 15000)).ok;
  const uri = `file://${encodeURI(file)}\n`;
  const [cmd, args] = which('wl-copy') ? ['wl-copy', ['-t', 'text/uri-list']] : ['xclip', ['-selection', 'clipboard', '-t', 'text/uri-list']];
  return new Promise((done) => {
    try {
      const child = spawn(cmd, args as string[], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.once('error', () => done(false));
      child.once('exit', (code) => done(code === 0));
      child.stdin.end(uri);
    } catch {
      done(false);
    }
  });
}

// ---------------------------------------------------------------- salvar uma cópia em…
const OSA_SAVE = [
  'on run argv',
  'activate',
  'set f to choose file name with prompt (item 1 of argv) default name (item 2 of argv) default location (POSIX file (item 3 of argv))',
  'return POSIX path of f',
  'end run',
];
const PS_SAVE = [
  'Add-Type -AssemblyName System.Windows.Forms;',
  '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false };',
  '$d = New-Object System.Windows.Forms.SaveFileDialog;',
  "$d.Filter = 'PDF (*.pdf)|*.pdf'; $d.FileName = $env:LABSIGN_NAME; $d.InitialDirectory = $env:LABSIGN_DIR; $d.Title = $env:LABSIGN_PROMPT; $d.OverwritePrompt = $true;",
  'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
].join(' ');

/**
 * Janela "Salvar como" do sistema. Devolve o caminho escolhido (terminado em .pdf) ou null se a pessoa cancelou.
 * Espera a pessoa decidir (sem limite curto): quem chama não segura a tela esperando — ver uiSaveCopy.
 */
export async function saveAsDialog(prompt: string, defaultName: string, defaultDir: string): Promise<string | null> {
  const fake = process.env.LABSIGN_FAKE_SAVE_AS;
  if (fake !== undefined) return fake ? withPdf(fake) : null;
  if (noOpen() || !deliveryOptions().saveAs) return null;
  const dir = existsSync(defaultDir) ? defaultDir : homedir();
  let chosen = '';
  if (platform === 'mac') {
    chosen = (await run('osascript', [...OSA_SAVE.flatMap((l) => ['-e', l]), prompt, defaultName, dir])).out;
  } else if (platform === 'windows') {
    chosen = (await powershell(PS_SAVE, { LABSIGN_NAME: defaultName, LABSIGN_DIR: dir, LABSIGN_PROMPT: prompt })).out;
  } else if (which('zenity')) {
    chosen = (await run('zenity', ['--file-selection', '--save', '--confirm-overwrite', `--title=${prompt}`, `--filename=${join(dir, defaultName)}`, '--file-filter=PDF | *.pdf'])).out;
  } else {
    chosen = (await run('kdialog', ['--title', prompt, '--getsavefilename', join(dir, defaultName), '*.pdf'])).out;
  }
  chosen = chosen.replace(/[\r\n]+$/, '');
  return chosen && isAbsolute(chosen) ? withPdf(chosen) : null;
}

const withPdf = (p: string) => (extname(p).toLowerCase() === '.pdf' ? p : `${p}.pdf`);

/**
 * Copia o assinado para onde a pessoa escolheu — sem nunca substituir nada: se o nome já existe
 * (inclusive o original ou o próprio assinado), a cópia vira "nome-2.pdf", "nome-3.pdf"…
 */
export function copyTo(signed: string, dest: string): { file: string; renamed: boolean } {
  const wanted = resolve(dest);
  const ext = extname(wanted);
  const stem = ext ? wanted.slice(0, -ext.length) : wanted;
  let file = wanted;
  for (let n = 2; existsSync(file); n++) file = `${stem}-${n}${ext}`;
  copyFileSync(signed, file, fsConstants.COPYFILE_EXCL); // falha em vez de sobrescrever, mesmo numa corrida
  return { file, renamed: file !== wanted };
}

// ---------------------------------------------------------------- e-mail e WhatsApp
/** Abre o app de e-mail com uma mensagem nova e o PDF já anexado (Apple Mail, Outlook, app padrão no Linux). */
export async function mailWithAttachment(client: MailClient, file: string, subject: string, body: string): Promise<boolean> {
  if (noOpen()) return false;
  if (platform === 'mac' && client === 'apple-mail') return startDetached('open', ['-a', 'Mail', file]);
  if (platform === 'mac' && client === 'outlook') return startDetached('open', ['-a', 'Microsoft Outlook', file]);
  if (platform === 'windows' && client === 'outlook')
    return (await powershell("Start-Process -FilePath 'outlook.exe' -ArgumentList ('/a \"' + $env:LABSIGN_FILE + '\"')", { LABSIGN_FILE: file }, 30000)).ok;
  if (platform === 'linux' && client === 'default') return startDetached('xdg-email', ['--subject', subject, '--body', body, '--attach', file]);
  return false;
}

export const gmailComposeUrl = (subject: string, body: string) =>
  `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

/** Endereço da conversa: o app do WhatsApp se estiver instalado; senão o WhatsApp Web. */
export function whatsappUrl(phone: string, text: string, app: boolean): string {
  const q = `${phone ? `phone=${phone}&` : ''}text=${encodeURIComponent(text)}`;
  if (app) return `whatsapp://send?${q}`;
  return phone ? `https://web.whatsapp.com/send?${q}` : 'https://web.whatsapp.com/';
}

// ---------------------------------------------------------------- Lixeira
const JXA_TRASH = `function run(argv) {
  ObjC.import('Foundation');
  return $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), null, null) ? 'ok' : 'no';
}`;

/** Manda para a Lixeira (dá para recuperar). Não apaga de vez em nenhum caso. */
export async function moveToTrash(file: string): Promise<boolean> {
  const fake = process.env.LABSIGN_TRASH_DIR;
  if (fake) {
    mkdirSync(fake, { recursive: true });
    renameSync(file, join(fake, basename(file)));
    return true;
  }
  if (noOpen() || !deliveryOptions().trash) return false;
  if (platform === 'mac') return (await run('osascript', ['-l', 'JavaScript', '-e', JXA_TRASH, file], {}, 15000)).out.trim() === 'ok';
  if (platform === 'windows')
    return (
      await powershell(
        "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:LABSIGN_FILE, 'OnlyErrorDialogs', 'SendToRecycleBin')",
        { LABSIGN_FILE: file },
        15000,
      )
    ).ok;
  return (await run('gio', ['trash', file], {}, 15000)).ok;
}
