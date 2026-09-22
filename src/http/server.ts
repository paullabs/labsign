// Servidor local da tela: só 127.0.0.1, porta aleatória, sessão de uso único.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { LabsignError, errorPayload } from '../core/errors.ts';
import { langFrom } from '../i18n/messages.ts';
import {
  getSession,
  sameToken,
  uiState,
  uiSaveSignature,
  uiDeleteSignature,
  uiSetPrefs,
  documentBytes,
  signedBytes,
  uiReveal,
  uiConfirm,
  uiCancel,
  uiFinish,
  uiClose,
  uiUploadChunk,
  pageOpened,
  startDetached,
  MAX_UPLOAD,
  type Session,
} from '../core/sessions.ts';
import { audit } from '../core/vault.ts';

/** A tela montada: ao lado deste arquivo no pacote, ou em dist/ quando roda do código-fonte. */
export function uiFile(name: 'ui.html' | 'ui-app.html'): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const found = [join(here, name), join(here, '../../dist', name)].find((p) => existsSync(p));
  if (!found) throw new Error(`${name} not found — run "npm run build"`);
  return found;
}

let ready: Promise<number> | null = null;
let port = 0;

/** Sobe o servidor uma vez só — duas tools chamadas juntas esperam o mesmo listen (senão uma veria a porta 0). */
export function ensureHttp(): Promise<number> {
  ready ??= new Promise<number>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((e) => json(res, 500, errorPayload(e)));
    });
    server.once('error', (e) => {
      ready = null;
      reject(e);
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      server.unref(); // não segura o processo vivo
      resolve(port);
    });
  });
  return ready;
}

/** A URL que ABRE a tela (leva o token de uso único). Vai para o navegador, nunca para o modelo quando dá para evitar. */
export const sessionUrl = (s: Session): string => `http://127.0.0.1:${port}/s/${s.id}?t=${s.openToken}`;
/** Sem token: só reabre a tela no navegador que já a abriu (cookie). Pode ir para o modelo e para o terminal. */
export const publicUrl = (s: Session): string => `http://127.0.0.1:${port}/s/${s.id}`;

/** Abre no navegador padrão (ou no programa de LABSIGN_BROWSER). Resolve false se não deu para abrir. */
export function openInBrowser(url: string): Promise<boolean> {
  if (process.env.LABSIGN_NO_OPEN === '1') return Promise.resolve(false);
  const custom = process.env.LABSIGN_BROWSER;
  const [cmd, args]: [string, string[]] = custom
    ? [custom, [url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]] // a URL só tem [A-Za-z0-9_-?=/:.]: nada que o cmd interprete
        : ['xdg-open', [url]];
  return startDetached(cmd, args);
}

// Cada requisição fecha a conexão (sem keep-alive). É um servidor local, de uso esporádico: o
// custo de um handshake a mais em 127.0.0.1 é irrelevante, e evita reaproveitar um socket que uma
// resposta de erro deixou pela metade (visto no Windows: a próxima requisição na mesma conexão
// reutilizada caía com ECONNRESET quando uma chamada anterior recusava a requisição sem drenar o corpo).
const CLOSE = { connection: 'close' } as const;

function json(res: ServerResponse, code: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CLOSE });
  res.end(JSON.stringify(body));
}

const PAGES = {
  pt: {
    notFound: ['Sessão não encontrada', 'O link expirou ou é inválido. Peça um novo pedido de assinatura.'],
    reopened: ['Esta sessão já foi aberta em outro lugar', 'Por segurança, cada pedido de assinatura só abre uma vez. Se não foi você, cancele e peça um novo.'],
  },
  en: {
    notFound: ['Session not found', 'The link expired or is invalid. Ask for a new signing request.'],
    reopened: ['This session was already opened elsewhere', 'For safety, each signing request opens only once. If it wasn’t you, cancel and ask for a new one.'],
  },
} as const;

function page(req: IncomingMessage, res: ServerResponse, code: number, which: 'notFound' | 'reopened'): void {
  const lang = langFrom(String(req.headers['accept-language'] ?? '').split(',')[0]);
  const [title, text] = PAGES[lang][which];
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", ...CLOSE });
  res.end(`<!doctype html><html lang="${lang}"><meta charset="utf-8"><title>labsign</title><body style="font:16px system-ui;padding:48px;max-width:560px;margin:auto"><h1 style="font-size:20px">${title}</h1><p>${text}</p>`);
}

const cookieOf = (req: IncomingMessage, name: string): string | undefined =>
  (req.headers.cookie ?? '')
    .split(/;\s*/)
    .map((c) => c.split('='))
    .find(([k]) => k === name)?.[1];

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Anti DNS-rebinding: só atendemos quando o Host é o nosso endereço literal.
  if (req.headers.host !== `127.0.0.1:${port}`) return json(res, 403, errorPayload(new LabsignError('BAD_HOST')));
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && parts[0] === 's' && parts[1]) {
    const s = getSession(parts[1]);
    if (!s) return page(req, res, 404, 'notFound');
    // Abre com o token de uso único (1ª vez) ou, sem token, só no navegador que já abriu (cookie).
    const sameBrowser = sameToken(cookieOf(req, `ls_${s.id}`), s.cookie);
    if (!sameBrowser && !sameToken(url.searchParams.get('t'), s.openToken)) return page(req, res, 404, 'notFound');
    if (s.opened && !sameBrowser) {
      audit({ event: 'session_reopen_blocked', session: s.id, ua: String(req.headers['user-agent'] ?? '') });
      return page(req, res, 409, 'reopened');
    }
    pageOpened(s);
    // um nonce por resposta: só os dois scripts desta página rodam (nada de script injetado nem atributo onclick)
    const nonce = randomBytes(18).toString('base64');
    const lang = process.env.LABSIGN_LANG ? { lang: langFrom(process.env.LABSIGN_LANG) } : {};
    const boot = `<script nonce="${nonce}">window.__LABSIGN_HTTP__=${JSON.stringify({ sessionId: s.id, viewToken: s.viewToken, ...lang })}</script>`;
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': `ls_${s.id}=${s.cookie}; HttpOnly; SameSite=Strict; Path=/`,
      // PDF.js roda na thread principal (sem Worker) e sem eval; fontes embutidas entram via FontFace
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      ...CLOSE,
    });
    const html = readFileSync(uiFile('ui.html'), 'utf8')
      .replace('<!--LABSIGN_BOOT-->', () => boot)
      .replace('nonce="__LABSIGN_NONCE__"', () => `nonce="${nonce}"`);
    return void res.end(html);
  }

  if (req.method === 'POST' && parts[0] === 'api' && parts[1] && parts[2]) {
    const s = getSession(parts[1]);
    if (!s) return json(res, 404, errorPayload(new LabsignError('NOT_FOUND')));
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}`) return json(res, 403, errorPayload(new LabsignError('BAD_ORIGIN')));
    // navegadores modernos dizem de onde veio a chamada: de outro site, nem com cookie
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, errorPayload(new LabsignError('BAD_ORIGIN')));
    // o envio do PDF vem cru (até 30 MB); o resto é JSON pequeno
    const isUpload = parts[2] === 'upload_document';
    const limit = isUpload ? MAX_UPLOAD : 5e6;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of req) {
      total += (c as Buffer).length;
      if (total > limit) return json(res, 413, errorPayload(new LabsignError(isUpload ? 'UPLOAD_TOO_BIG' : 'BODY_TOO_BIG', { mb: MAX_UPLOAD / 1024 / 1024 })));
      chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks);
    let body: Record<string, any> = {};
    try {
      body = isUpload || !raw.length ? {} : JSON.parse(raw.toString('utf8'));
    } catch {
      return json(res, 400, errorPayload(new LabsignError('INVALID_PLACEMENT')));
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, errorPayload(new LabsignError('INVALID_PLACEMENT')));
    // sendBeacon (aviso de aba fechada) não manda cabeçalho próprio: só "close" aceita o token no corpo
    const viewToken = req.headers['x-labsign-view'] ?? (parts[2] === 'close' ? body.view_token : undefined);
    if (!sameToken(viewToken, s.viewToken) || !sameToken(cookieOf(req, `ls_${s.id}`), s.cookie)) return json(res, 401, errorPayload(new LabsignError('UNAUTHORIZED')));
    try {
      switch (parts[2]) {
        case 'state':
          return json(res, 200, uiState(s));
        case 'document':
          return sendPdf(res, documentBytes(s));
        case 'signed_document':
          return sendPdf(res, signedBytes(s));
        case 'upload_document':
          return json(res, 200, await uiUploadChunk(s, { name: safeDecode(String(req.headers['x-labsign-filename'] ?? '')), size: raw.length, offset: 0, data: raw }));
        case 'save_signature':
          return json(res, 200, uiSaveSignature(s, body as any));
        case 'delete_signature':
          return json(res, 200, uiDeleteSignature(s, body as any));
        case 'set_prefs':
          return json(res, 200, uiSetPrefs(s, body));
        case 'confirm':
          return json(res, 200, await uiConfirm(s, body as any));
        case 'reveal':
          return json(res, 200, await uiReveal(s));
        case 'cancel':
          return json(res, 200, uiCancel(s));
        case 'finish':
          return json(res, 200, uiFinish(s));
        case 'close':
          return json(res, 200, uiClose(s));
      }
    } catch (e) {
      return json(res, 400, errorPayload(e));
    }
  }
  return json(res, 404, errorPayload(new LabsignError('NOT_FOUND')));
}

/** Nome de arquivo vindo do cabeçalho: %-encoding malformado não derruba o envio. */
function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function sendPdf(res: ServerResponse, bytes: Buffer): void {
  res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.length, 'cache-control': 'no-store', ...CLOSE });
  res.end(bytes);
}
